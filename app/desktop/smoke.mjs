import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { ExternalSkillRegistry, runExternalSkill, validateExternalArgs } from '../server/external-skills.mjs';
import { ArtifactStore } from '../server/media.mjs';
import { saveAttachment } from '../server/attachments.mjs';
import { nativeWorkspaceFileActions } from '../server/native-file-actions.mjs';
import { atomicWrite } from '../server/util.mjs';
import path from 'node:path';
import { APP_NAME } from '../shared/app-identity.mjs';

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(name, data) {
  const type = Buffer.from(name, 'ascii');
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(data.length);
  const suffix = Buffer.alloc(4); suffix.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([prefix, type, data, suffix]);
}

function onePixelPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 99, 102, 241, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function localGet(origin, requestedPath, maximum = 8 * 1024 * 1024) {
  const url = new URL(requestedPath, `${origin}/`);
  if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('SMOKE_NON_LOCAL_RESOURCE');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Origin: origin } });
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maximum) throw new Error('SMOKE_RESOURCE_TOO_LARGE');
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) throw new Error('SMOKE_RESOURCE_TOO_LARGE');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return { response, bytes: Buffer.concat(chunks) };
}

/** Smoke checks only the application's own HTTP service; it never reads a renderer DOM. */
export async function checkDesktopService({ origin, dataDir, workspace }) {
  const statusReply = await localGet(origin, '/api/status', 64 * 1024);
  const status = JSON.parse(statusReply.bytes.toString('utf8'));
  if (statusReply.response.status !== 200 || status.pid !== process.pid || status.appName !== APP_NAME) throw new Error('SMOKE_WRONG_SERVICE');
  if (status.settingsReady) throw new Error('SMOKE_REQUIRES_UNCONFIGURED_DATA');

  const indexReply = await localGet(origin, '/');
  const html = indexReply.bytes.toString('utf8');
  const htmlTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/<[^>]*>/g, '').trim().slice(0, 160) ?? '';
  const bodyMarkup = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? '';
  const bodyTextSnippet = bodyMarkup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
  const references = new Set();
  for (const tag of html.matchAll(/<(?:script|link|img)\b[^>]*>/gi)) {
    const value = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1];
    if (value) references.add(value);
  }
  const resources = [];
  const mathFontUrls = new Set();
  for (const reference of [...references].slice(0, 30)) {
    const assetUrl = new URL(reference, `${origin}/`);
    if (assetUrl.origin !== origin) {
      resources.push({ path: '[external resource omitted]', ok: false, reason: 'NON_LOCAL_RESOURCE' });
      continue;
    }
    const result = await localGet(origin, assetUrl.href);
    const mime = result.response.headers.get('content-type') ?? '';
    const expectedMime = assetUrl.pathname.endsWith('.js') ? /(?:java|ecma)script/i : assetUrl.pathname.endsWith('.css') ? /text\/css/i : null;
    resources.push({ path: assetUrl.pathname, status: result.response.status, mime, bytes: result.bytes.length, ok: result.response.status === 200 && result.bytes.length > 0 && (!expectedMime || expectedMime.test(mime)) });
    if (assetUrl.pathname.endsWith('.css')) {
      for (const match of result.bytes.toString('utf8').matchAll(/url\(["']?([^\s)"']+\.woff2)["']?\)/g)) {
        mathFontUrls.add(new URL(match[1], assetUrl).href);
      }
    }
  }
  const mathFonts = [];
  for (const fontUrl of mathFontUrls) {
    const result = await localGet(origin, fontUrl, 512 * 1024);
    mathFonts.push({ path: new URL(fontUrl).pathname, ok: result.response.status === 200 && result.bytes.subarray(0, 4).toString('ascii') === 'wOF2' });
  }
  const mathFontsOk = mathFonts.length > 0 && mathFonts.every(font => font.ok);

  // This deliberately generated, single-pixel fixture lives only in the caller's isolated smoke data.
  const fixture = onePixelPng();
  const artifact = await new ArtifactStore(path.join(dataDir, 'artifacts')).save(`data:image/png;base64,${fixture.toString('base64')}`);
  const imageReply = await localGet(origin, artifact.url, 4_096);
  const downloadReply = await localGet(origin, artifact.downloadUrl, 4_096);
  const image = {
    status: imageReply.response.status,
    mime: imageReply.response.headers.get('content-type'),
    bytes: imageReply.bytes.length,
    width: artifact.width, height: artifact.height,
    sha256: createHash('sha256').update(imageReply.bytes).digest('hex'),
    matchesFixture: imageReply.bytes.equals(fixture),
    downloadOk: downloadReply.response.status === 200 && /attachment/i.test(downloadReply.response.headers.get('content-disposition') ?? '') && downloadReply.bytes.equals(fixture),
  };
  // File previews are verified using only our own isolated workspace fixtures.
  const previewName = '预览 [desktop] & image.png';
  const textName = '说明 [desktop] & preview.txt';
  const textContent = '这是桌面版的隔离文件预览检查。\nWorkspace preview smoke check.\n';
  await writeFile(path.join(workspace, previewName), fixture, { flag: 'wx' });
  await writeFile(path.join(workspace, textName), textContent, { flag: 'wx' });
  const fileInfoReply = await localGet(origin, `/api/workspace/file-info?path=${encodeURIComponent(previewName)}`, 8_192);
  const fileInfo = JSON.parse(fileInfoReply.bytes.toString('utf8'));
  const fileImageReply = fileInfo.previewUrl ? await localGet(origin, fileInfo.previewUrl, 4_096) : null;
  const textInfoReply = await localGet(origin, `/api/workspace/file-info?path=${encodeURIComponent(textName)}`, 8_192);
  const textInfo = JSON.parse(textInfoReply.bytes.toString('utf8'));
  const textReply = await localGet(origin, `/api/workspace/file?path=${encodeURIComponent(textName)}`, 8_192);
  const textFile = JSON.parse(textReply.bytes.toString('utf8'));
  // Attachments are exercised through the packaged server itself: one text file and one image
  // are uploaded into a session created for this check, then read back from their own directory.
  const sessionReply = await fetch(new URL('/api/sessions', `${origin}/`), {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: origin }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  const session = await sessionReply.json();
  const attachmentNames = ['smoke 说明 [desktop] & note.txt', 'smoke 图片 [desktop] & shot.png'];
  const uploaded = [];
  for (const [index, uploadName] of attachmentNames.entries()) {
    const bytes = index === 0 ? Buffer.from('attachment smoke check\n', 'utf8') : fixture;
    const response = await fetch(new URL(`/api/sessions/${session.id}/attachments`, `${origin}/`), {
      method: 'POST', headers: { 'content-type': 'application/json', Origin: origin }, redirect: 'error', signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ name: uploadName, mime: index === 0 ? 'text/plain' : 'image/png', data: `data:${index === 0 ? 'text/plain' : 'image/png'};base64,${bytes.toString('base64')}` }),
    });
    uploaded.push({ status: response.status, body: await response.json() });
  }
  // Each kind is read back through the endpoint that serves it: text through the file reader,
  // an image through the validated raster preview.
  const attachmentReads = [];
  for (const [index, entry] of uploaded.entries()) {
    if (entry.status !== 201) { attachmentReads.push({ ok: false }); continue; }
    const endpoint = index === 0 ? 'file' : 'file-content';
    const reply = await localGet(origin, `/api/workspace/${endpoint}?path=${encodeURIComponent(entry.body.path)}&sessionId=${session.id}`, 4_096).catch(() => null);
    const body = reply ? reply.bytes.toString('utf8') : '';
    attachmentReads.push({
      ok: Boolean(reply) && reply.response.status === 200 && reply.bytes.length > 0,
      mime: reply?.response.headers.get('content-type') ?? '', bytes: reply?.bytes.length ?? 0,
      matches: index === 0 ? body.includes('attachment smoke check') : reply?.bytes.equals(fixture) === true,
    });
  }
  const attachments = {
    sessionCreated: sessionReply.status === 201 && typeof session.id === 'string',
    uploadStatuses: uploaded.map(entry => entry.status),
    names: uploaded.map(entry => entry.body.name),
    kinds: uploaded.map(entry => entry.body.mime),
    reads: attachmentReads,
  };
  attachments.ok = attachments.sessionCreated
    && attachments.uploadStatuses.every(status => status === 201)
    && attachments.names.every((attachmentName, index) => typeof attachmentName === 'string' && attachmentName.length > 0 && (index === 0 || attachmentName.endsWith('.png')))
    && attachments.kinds[0] === 'text/plain' && attachments.kinds[1] === 'image/png'
    && attachmentReads.every(read => read.ok && read.matches);
  // The skill library travels through the packaged server and its own larger body parser: one
  // long prompt is created, read back, edited and deleted, and the file itself must appear in
  // the isolated data directory.
  const skillApi = async (method, requestedPath, body) => {
    const response = await fetch(new URL(requestedPath, `${origin}/`), {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', Origin: origin },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const longPrompt = '提示'.repeat(20_000);
  const emptyLibrary = await skillApi('GET', '/api/skills');
  const createdSkill = await skillApi('POST', '/api/skills', { name: 'smoke 解码 [desktop]', text: longPrompt });
  const listedSkills = await skillApi('GET', '/api/skills');
  // The long prompt has to be on disk before the update replaces it with a short one.
  const skillFile = await lstat(path.join(dataDir, 'skills.json')).then(entry => ({ exists: entry.isFile(), bytes: entry.size }), () => ({ exists: false, bytes: 0 }));
  const updatedSkill = await skillApi('PUT', `/api/skills/${createdSkill.body?.id}`, { name: 'smoke 解订阅 [desktop]', text: '换成新的提示词' });
  const deletedSkill = await skillApi('DELETE', `/api/skills/${createdSkill.body?.id}`);
  const skills = {
    emptyLibrary: emptyLibrary.status === 200 && Array.isArray(emptyLibrary.body?.skills) && emptyLibrary.body.skills.length === 0,
    created: createdSkill.status === 201 && createdSkill.body?.name === 'smoke 解码 [desktop]' && createdSkill.body?.text?.length === longPrompt.length,
    listed: listedSkills.status === 200 && listedSkills.body?.skills?.length === 1 && listedSkills.body?.skills[0]?.text?.length === longPrompt.length,
    updated: updatedSkill.status === 200 && updatedSkill.body?.name === 'smoke 解订阅 [desktop]' && updatedSkill.body?.text === '换成新的提示词',
    storedOnDisk: skillFile.exists && skillFile.bytes > longPrompt.length,
    deleted: deletedSkill.status === 200 && deletedSkill.body?.deleted === true,
    removed: (await skillApi('GET', '/api/skills')).body?.skills?.length === 0,
  };
  skills.ok = Object.values(skills).every(value => value === true);
  // External skills: the PDF sample is installed into a fresh data directory, and a JavaScript
  // skill runs on the runtime inside the EXE (ELECTRON_RUN_AS_NODE), not on a system Node.js.
  const externalList = await skillApi('GET', '/api/external-skills');
  const externalDirectory = externalList.body?.directory;
  const externalSkills = { listed: externalList.status === 200, samplePresent: Boolean(externalList.body?.skills?.some(skill => skill.name === 'read_pdf' && skill.readOnly)) };
  try {
    const probeDir = path.join(externalDirectory, 'smoke_echo_probe');
    await mkdir(probeDir, { recursive: true });
    await writeFile(path.join(probeDir, 'skill.json'), JSON.stringify({
      name: 'smoke_echo_probe', description: 'smoke', command: ['index.mjs'], readOnly: true,
      parameters: { type: 'object', properties: { text: { type: 'string' }, containers: { type: ['array', 'string'], items: { type: 'string' } } } },
    }));
    await writeFile(path.join(probeDir, 'index.mjs'), "let s='';process.stdin.setEncoding('utf8');for await (const c of process.stdin) s+=c;console.log(JSON.stringify({ echoed: JSON.parse(s).text, electron: Boolean(process.versions.electron), node: process.versions.node }));\n");
    const registry = await new ExternalSkillRegistry({ directory: externalDirectory, dataDir }).init();
    const probe = registry.get('ext_smoke_echo_probe');
    externalSkills.unionParameterType = probe?.parameters?.properties?.containers?.type ?? null;
    const arrayArgs = { text: '外置技能', containers: ['VSTU2433551'] };
    const legacyArgs = { text: '外置技能', containers: 'VSTU2433551' };
    validateExternalArgs(probe, arrayArgs);
    validateExternalArgs(probe, legacyArgs);
    externalSkills.legacyUnionCallsAccepted = true;
    const customs = registry.get('ext_customs_validator');
    externalSkills.bundledContainersType = customs?.parameters?.properties?.containers?.type ?? null;
    const ran = await runExternalSkill(probe, arrayArgs, { workspace, signal: AbortSignal.timeout(30_000) });
    externalSkills.bundledRuntime = ran.exitCode === 0 && ran.result?.echoed === '外置技能';
    externalSkills.runtimeNode = ran.result?.node ?? null;
    await rm(probeDir, { recursive: true, force: true });
  } catch (error) {
    externalSkills.bundledRuntime = false;
    externalSkills.error = String(error?.message ?? error).slice(0, 200);
  }
  externalSkills.ok = externalSkills.listed && externalSkills.samplePresent && externalSkills.bundledRuntime
    && externalSkills.unionParameterType === 'array' && externalSkills.legacyUnionCallsAccepted === true
    && externalSkills.bundledContainersType === 'array';
  const settingsReply = await localGet(origin, '/api/settings', 64 * 1024);
  const settings = JSON.parse(settingsReply.bytes.toString('utf8'));
  const applicationsReply = await localGet(origin, '/api/workspace/applications?path=' + encodeURIComponent(textName), 64 * 1024);
  const applications = JSON.parse(applicationsReply.bytes.toString('utf8'));
  const applicationListOk = applicationsReply.response.status === 200 && applications.path === textName
    && Array.isArray(applications.applications) && applications.applications.length > 0
    && applications.applications.every(application => typeof application.id === 'string' && application.id.length > 0
      && typeof application.name === 'string' && application.name.trim().length > 0 && typeof application.recommended === 'boolean');
  const workspaceFiles = {
    imageInfoStatus: fileInfoReply.response.status,
    imageKind: fileInfo.kind,
    imageStatus: fileImageReply?.response.status,
    imageMime: fileImageReply?.response.headers.get('content-type'),
    imageMatchesFixture: Boolean(fileImageReply?.bytes.equals(fixture)),
    fileActions: fileInfo.actions,
    nativeActionsAvailable: ['default', 'choose', 'reveal'].every(action => fileInfo.actions?.[action] === true),
    textInfoStatus: textInfoReply.response.status,
    textKind: textInfo.kind,
    textStatus: textReply.response.status,
    textMatchesFixture: textFile.content === textContent,
    applicationListStatus: applicationsReply.response.status,
    applicationCount: applications.applications?.length ?? 0,
    applicationListOk,
    systemApplicationsLaunched: false,
  };
  workspaceFiles.ok = workspaceFiles.imageInfoStatus === 200 && workspaceFiles.imageKind === 'image'
    && workspaceFiles.imageStatus === 200 && workspaceFiles.imageMime === 'image/png' && workspaceFiles.imageMatchesFixture
    && workspaceFiles.nativeActionsAvailable && workspaceFiles.textInfoStatus === 200 && workspaceFiles.textKind === 'text'
    && workspaceFiles.textStatus === 200 && workspaceFiles.textMatchesFixture && workspaceFiles.applicationListOk;
  const defaultUnlimitedToolRounds = settingsReply.response.status === 200 && settings.maxToolRounds === 0;
  // Exercise ASAR script loading and the Windows bridge with a target that cannot be opened.
  // The native helper rejects the missing file before invoking any application.
  const absentTarget = path.join(workspace, `absent-native-probe-${randomUUID()}.txt`);
  const absent = await lstat(absentTarget).then(() => false, error => {
    if (error.code !== 'ENOENT') throw error;
    return true;
  });
  if (!absent) throw new Error('SMOKE_NATIVE_TARGET_MUST_NOT_EXIST');
  let nativeBridgeRejectsMissingFile = false;
  try {
    await nativeWorkspaceFileActions().default({ absolutePath: absentTarget, workspace, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    // Only FileNotFound proves that the packaged script compiled and reached path validation.
    nativeBridgeRejectsMissingFile = /错误码 0x80070002[）)]/i.test(error.message);
  }
  const csp = indexReply.response.headers.get('content-security-policy') ?? '';
  const hasRoot = /\bid\s*=\s*["']root["']/i.test(html);
  const hasModuleScript = /<script\b[^>]*\btype\s*=\s*["']module["']/i.test(html);
  return {
    ok: indexReply.response.status === 200 && hasRoot && hasModuleScript && resources.length > 0 && resources.every(resource => resource.ok) && mathFontsOk && image.status === 200 && image.matchesFixture && image.downloadOk && workspaceFiles.ok && attachments.ok && defaultUnlimitedToolRounds && nativeBridgeRejectsMissingFile && skills.ok && externalSkills.ok && /default-src\s+'self'/i.test(csp),
    modelRequestsPerformed: false,
    status: { appName: status.appName, version: status.version, pid: status.pid, settingsReady: status.settingsReady },
    html: { status: indexReply.response.status, bytes: indexReply.bytes.length, title: htmlTitle, hasRoot, hasModuleScript, csp },
    bodyTextSnippet, bodyTextSource: 'HTTP index.html; no DOM evaluation',
    resources, mathFonts, mathFontsOk, image, workspaceFiles, attachments, skills, externalSkills, defaultUnlimitedToolRounds, nativeBridgeRejectsMissingFile,
  };
}

export async function writeSmokeReport(filename, report) {
  await atomicWrite(filename, `${JSON.stringify(report, null, 2)}\n`);
}

export async function serviceHasStopped(origin) {
  try {
    await fetch(`${origin}/api/status`, { redirect: 'error', signal: AbortSignal.timeout(1_500) });
    return false;
  } catch { return true; }
}
