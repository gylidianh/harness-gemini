#!/usr/bin/env node
/**
 * Harness Gemini UI Open-Source & Visual Rules Automated Verifier
 * License: MIT
 *
 * Pure Node.js built-in implementation (zero external npm dependencies).
 * Checks:
 *  1. MIT LICENSE files exist and contain standard MIT license terms.
 *  2. src152/package.json has "license": "MIT", no "private": true, and "build:ui" / "verify:ui" scripts.
 *  3. src152/ui/ open-source directory layout & documentation completeness (no legacy minified bundle refs).
 *  4. src152/dist/index.html referenced local .js / .mjs / .css assets (plus CSS @import & KaTeX .woff2 fonts) exist and are non-empty, satisfying CSP & desktop/smoke.mjs contracts.
 *  5. Syntax check (`node --check`) across all .js / .mjs files under src152/ui/ and src152/dist/.
 *  6. Visual rules in workspace-tabs.css & conversation-map.css:
 *     - `#hg-cmap-tab > span` / `.hg-cmap-tab > span` transparent background & `box-shadow: none` reset;
 *     - `.hg-map-card` shadowless rule (`box-shadow: none`) with no residual card shadows.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(__filename);
const uiDir = path.resolve(scriptsDir, '..');
const src152Dir = path.resolve(uiDir, '..');
const repoRootDir = path.resolve(src152Dir, '..');
const distDir = path.join(src152Dir, 'dist');

const args = new Set(process.argv.slice(2));
const jsonOnly = args.has('--json');

function hasRepoWrapper() {
  return path.basename(src152Dir) === 'src152' && fs.existsSync(path.join(repoRootDir, 'src152'));
}

function relFromRepo(targetPath) {
  const base = hasRepoWrapper() ? repoRootDir : src152Dir;
  return path.relative(base, targetPath).replace(/\\/g, '/');
}

async function statFile(filePath) {
  try {
    const st = await fsp.stat(filePath);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

async function statDir(dirPath) {
  try {
    const st = await fsp.stat(dirPath);
    return st.isDirectory() ? st : null;
  } catch {
    return null;
  }
}

async function collectFiles(rootDir, extensions, excludeDirs = new Set(['node_modules', '.git'])) {
  const results = [];
  if (!(await statDir(rootDir))) return results;

  async function walk(currentDir) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name)) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(rootDir);
  return results;
}

function runNodeCheck(filePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', filePath], {
      cwd: src152Dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      resolve({ filePath, ok: false, error: String(err?.message ?? err) });
    });
    child.on('close', (code) => {
      resolve({
        filePath,
        ok: code === 0,
        error: code === 0 ? '' : stderr.trim() || `Exited with code ${code}`,
      });
    });
  });
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runner());
  await Promise.all(workers);
  return results;
}

/**
 * Strip CSS comments and flatten top-level + nested (@media/@container/@supports) rule blocks
 * into `{ selector, declarations }` entries.
 */
function parseCssRuleBlocks(rawCss) {
  const clean = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];

  function scan(source) {
    let i = 0;
    const len = source.length;
    while (i < len) {
      while (i < len && /\s/.test(source[i])) i++;
      if (i >= len) break;

      const openBrace = source.indexOf('{', i);
      const semi = source.indexOf(';', i);
      if (semi !== -1 && (openBrace === -1 || semi < openBrace)) {
        i = semi + 1;
        continue;
      }
      if (openBrace === -1) break;

      const header = source.slice(i, openBrace).trim();
      let depth = 1;
      let j = openBrace + 1;
      let inQuote = null;
      while (j < len && depth > 0) {
        const ch = source[j];
        if (inQuote) {
          if (ch === '\\') {
            j += 2;
            continue;
          }
          if (ch === inQuote) inQuote = null;
        } else if (ch === '"' || ch === "'") {
          inQuote = ch;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
        }
        j++;
      }

      const body = source.slice(openBrace + 1, Math.max(openBrace + 1, j - 1)).trim();
      if (header.startsWith('@')) {
        if (/^@(?:media|container|supports|layer)\b/i.test(header)) {
          scan(body);
        }
      } else if (header.length > 0) {
        blocks.push({ selector: header, declarations: body });
      }
      i = j;
    }
  }

  scan(clean);
  return blocks;
}

function splitSelectors(selectorGroup) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of selectorGroup) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function verifyCmapTabSpanReset(blocks) {
  let hasTransparentBg = false;
  let hasNoShadow = false;
  const matchedSelectors = [];

  for (const block of blocks) {
    const branches = splitSelectors(block.selector);
    const hitsCmapSpan = branches.some(
      (sel) =>
        /(?:#hg-cmap-tab|\.hg-cmap-tab)\b/.test(sel) &&
        /(?:>\s*span|\s+span)\b/.test(sel),
    );
    if (!hitsCmapSpan) continue;

    matchedSelectors.push(block.selector.replace(/\s+/g, ' '));
    if (/background(?:-color)?\s*:\s*(?:transparent|none|0\s+0)\b/i.test(block.declarations)) {
      hasTransparentBg = true;
    }
    if (/box-shadow\s*:\s*none\b/i.test(block.declarations)) {
      hasNoShadow = true;
    }
  }

  return {
    ok: hasTransparentBg && hasNoShadow,
    hasTransparentBg,
    hasNoShadow,
    matchedSelectors,
  };
}

function verifyMapCardShadowless(blocks) {
  let hasBaseShadowNone = false;
  const shadowViolations = [];
  const matchedCardSelectors = [];

  for (const block of blocks) {
    const branches = splitSelectors(block.selector);
    const hitsBaseMapCard = branches.some((sel) => /\.hg-map-card$/.test(sel));
    const hitsMapCardSelfOrPseudo = branches.some((sel) =>
      /\.hg-map-card(?:[:.#[][^\s>+~]*)?$/.test(sel),
    );

    if (hitsBaseMapCard && /box-shadow\s*:\s*none\b/i.test(block.declarations)) {
      hasBaseShadowNone = true;
      matchedCardSelectors.push(block.selector.replace(/\s+/g, ' '));
    }

    if (hitsMapCardSelfOrPseudo) {
      for (const match of block.declarations.matchAll(/box-shadow\s*:\s*([^;{}]+)/gi)) {
        const rawValue = match[1].replace(/!important/gi, '').trim();
        if (rawValue.toLowerCase() !== 'none') {
          shadowViolations.push(`${block.selector.replace(/\s+/g, ' ')} -> box-shadow: ${match[1].trim()}`);
        }
      }
    }
  }

  return {
    ok: hasBaseShadowNone && shadowViolations.length === 0,
    hasBaseShadowNone,
    matchedCardSelectors,
    shadowViolations,
  };
}

// ---------------------------------------------------------------------------
// Individual Check Runners
// ---------------------------------------------------------------------------

async function checkLicenses() {
  const errors = [];
  const licenseTargets = [
    ...(hasRepoWrapper() ? [path.join(repoRootDir, 'LICENSE')] : []),
    path.join(src152Dir, 'LICENSE'),
    path.join(uiDir, 'LICENSE'),
  ];
  const verifiedFiles = [];

  for (const target of licenseTargets) {
    const rel = relFromRepo(target);
    const st = await statFile(target);
    if (!st || st.size === 0) {
      errors.push(`Missing or empty LICENSE file: ${rel}`);
      continue;
    }
    const content = await fsp.readFile(target, 'utf8');
    const isMit =
      /MIT License/i.test(content) &&
      /Permission is hereby granted,\s*free of charge/i.test(content) &&
      /THE SOFTWARE IS PROVIDED\s+"AS IS"/i.test(content);
    if (!isMit) {
      errors.push(`LICENSE file does not contain standard MIT License text: ${rel}`);
    } else {
      verifiedFiles.push(rel);
    }
  }

  return {
    id: 'mit-licenses',
    title: 'MIT 开源许可证校验 (LICENSE)',
    passed: errors.length === 0,
    details: { verifiedFiles },
    errors,
  };
}

async function checkPackageJson() {
  const errors = [];
  const pkgPath = path.join(src152Dir, 'package.json');
  const rel = relFromRepo(pkgPath);
  const st = await statFile(pkgPath);
  const details = { file: rel };

  if (!st || st.size === 0) {
    return {
      id: 'package-json',
      title: 'package.json 开源元数据与脚本配置校验',
      passed: false,
      details,
      errors: [`Missing or empty ${rel}`],
    };
  }

  let pkg;
  try {
    pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
  } catch (err) {
    return {
      id: 'package-json',
      title: 'package.json 开源元数据与脚本配置校验',
      passed: false,
      details,
      errors: [`Invalid JSON in ${rel}: ${err.message}`],
    };
  }

  details.name = pkg.name;
  details.version = pkg.version;
  details.license = pkg.license;
  details.scripts = pkg.scripts ?? {};

  if (pkg.license !== 'MIT') {
    errors.push(`Expected "license": "MIT" in ${rel}, got ${JSON.stringify(pkg.license)}`);
  }
  if (pkg.private === true) {
    errors.push(`"private": true must be removed in ${rel} for open-source configuration`);
  }
  if (typeof pkg.scripts?.['build:ui'] !== 'string' || !pkg.scripts['build:ui'].includes('ui/scripts/build.mjs')) {
    errors.push(`Missing or invalid "scripts.build:ui" in ${rel} (expected "node ui/scripts/build.mjs")`);
  }
  if (typeof pkg.scripts?.['verify:ui'] !== 'string' || !pkg.scripts['verify:ui'].includes('ui/scripts/verify-ui.mjs')) {
    errors.push(`Missing or invalid "scripts.verify:ui" in ${rel} (expected "node ui/scripts/verify-ui.mjs")`);
  }

  for (const requiredField of ['name', 'version', 'type', 'main', 'engines', 'dependencies', 'overrides']) {
    if (pkg[requiredField] === undefined) {
      errors.push(`Required original field "${requiredField}" is missing in ${rel}`);
    }
  }

  return {
    id: 'package-json',
    title: 'package.json 开源元数据与脚本配置校验',
    passed: errors.length === 0,
    details,
    errors,
  };
}

async function checkUiSourceStructure() {
  const errors = [];
  const requiredFiles = [
    path.join(uiDir, 'index.html'),
    path.join(uiDir, 'README.md'),
    path.join(uiDir, 'scripts', 'build.mjs'),
    path.join(uiDir, 'scripts', 'verify-ui.mjs'),
    ...(hasRepoWrapper() ? [path.join(repoRootDir, 'OPEN-SOURCE-UI.md')] : []),
  ];

  for (const filePath of requiredFiles) {
    const st = await statFile(filePath);
    if (!st || st.size === 0) {
      errors.push(`Missing or empty required UI source/doc file: ${relFromRepo(filePath)}`);
    }
  }

  const requiredDirs = [
    path.join(uiDir, 'src'),
    path.join(uiDir, 'styles'),
    path.join(uiDir, 'scripts'),
  ];
  for (const dirPath of requiredDirs) {
    if (!(await statDir(dirPath))) {
      errors.push(`Missing required UI directory: ${relFromRepo(dirPath)}`);
    }
  }

  const srcJsFiles = await collectFiles(path.join(uiDir, 'src'), new Set(['.js', '.mjs', '.jsx']));
  const styleCssFiles = await collectFiles(path.join(uiDir, 'styles'), new Set(['.css']));
  const moduleJsFiles = await collectFiles(path.join(uiDir, 'modules'), new Set(['.js', '.mjs']));
  const vendorJsFiles = await collectFiles(path.join(uiDir, 'vendor'), new Set(['.js', '.mjs']));

  if (srcJsFiles.length === 0) {
    errors.push('No readable React source modules found under src152/ui/src/');
  }
  if (styleCssFiles.length === 0) {
    errors.push('No CSS stylesheets found under src152/ui/styles/');
  }

  const uiIndexPath = path.join(uiDir, 'index.html');
  if (await statFile(uiIndexPath)) {
    const uiHtml = await fsp.readFile(uiIndexPath, 'utf8');
    if (/index-BWW8q4t7\.js|index-BbYfWXft\.css/.test(uiHtml)) {
      errors.push('src152/ui/index.html still references legacy minified bundle filenames');
    }
  }

  return {
    id: 'ui-source-structure',
    title: 'src152/ui/ 开源源码目录结构与文档完整性校验',
    passed: errors.length === 0,
    details: {
      srcModuleCount: srcJsFiles.length,
      styleSheetCount: styleCssFiles.length,
      extensionModuleCount: moduleJsFiles.length,
      vendorModuleCount: vendorJsFiles.length,
    },
    errors,
  };
}

function resolveLocalDistAsset(rawRef, baseDir = distDir) {
  const trimmed = rawRef.trim();
  if (
    !trimmed ||
    /^(?:https?:|data:|blob:|mailto:|javascript:|\/\/|#)/i.test(trimmed)
  ) {
    return null;
  }
  const cleanPath = decodeURIComponent(trimmed.split('#')[0].split('?')[0]);
  if (!cleanPath) return null;

  const resolved = cleanPath.startsWith('/')
    ? path.resolve(distDir, `.${cleanPath}`)
    : path.resolve(baseDir, cleanPath);

  const relativeToDist = path.relative(distDir, resolved);
  if (relativeToDist.startsWith('..') || path.isAbsolute(relativeToDist)) {
    return { escaped: true, rawRef, resolved };
  }
  return { escaped: false, rawRef, resolved };
}

async function checkDistAssetsAndContracts() {
  const errors = [];
  const distIndexPath = path.join(distDir, 'index.html');
  const st = await statFile(distIndexPath);

  if (!st || st.size === 0) {
    return {
      id: 'dist-html-assets',
      title: 'src152/dist/index.html 本地资源引用与桌面端契约校验',
      passed: false,
      details: {},
      errors: [`Missing or empty ${relFromRepo(distIndexPath)} (run "npm run build:ui" first)`],
    };
  }

  const html = await fsp.readFile(distIndexPath, 'utf8');

  if (/index-BWW8q4t7\.js|index-BbYfWXft\.css/.test(html)) {
    errors.push('src152/dist/index.html still references legacy minified black-box bundle (index-BWW8q4t7.js / index-BbYfWXft.css)');
  }
  if (!/\bid\s*=\s*["']root["']/i.test(html)) {
    errors.push('src152/dist/index.html is missing <div id="root"></div> mount node');
  }
  if (!/<script\b[^>]*\btype\s*=\s*["']module["']/i.test(html)) {
    errors.push('src152/dist/index.html is missing <script type="module" ...> entry');
  }

  // CSP check: forbid inline executable <script> blocks
  for (const scriptMatch of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = scriptMatch[1] ?? '';
    const inlineBody = (scriptMatch[2] ?? '').trim();
    const hasSrc = /\bsrc\s*=\s*["'][^"']+["']/i.test(attrs);
    if (!hasSrc && inlineBody.length > 0) {
      errors.push('Inline <script> detected in src152/dist/index.html (violates CSP script-src \'self\')');
      break;
    }
  }

  const tagRefs = [];
  for (const tag of html.matchAll(/<(?:script|link|img)\b[^>]*>/gi)) {
    const attrMatch = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(tag[0]);
    if (attrMatch?.[1]) {
      tagRefs.push(attrMatch[1]);
    }
  }

  const uniqueRefs = [...new Set(tagRefs)];
  const verifiedJsAssets = [];
  const verifiedCssAssets = [];
  const verifiedOtherAssets = [];
  const directLinkedCssPaths = [];

  for (const [index, ref] of uniqueRefs.entries()) {
    const target = resolveLocalDistAsset(ref, distDir);
    if (!target) {
      errors.push(`External or unsupported asset URL in dist/index.html: ${ref}`);
      continue;
    }
    if (target.escaped) {
      errors.push(`Asset reference escapes dist/ directory: ${ref}`);
      continue;
    }
    const fileStat = await statFile(target.resolved);
    const relAsset = relFromRepo(target.resolved);
    if (!fileStat || fileStat.size === 0) {
      errors.push(`Referenced asset in dist/index.html is missing or empty: ${ref} -> ${relAsset}`);
      continue;
    }

    const ext = path.extname(target.resolved).toLowerCase();
    if (ext === '.js' || ext === '.mjs') {
      verifiedJsAssets.push(relAsset);
    } else if (ext === '.css') {
      verifiedCssAssets.push(relAsset);
      if (index < 30) {
        directLinkedCssPaths.push(target.resolved);
      }
    } else {
      verifiedOtherAssets.push(relAsset);
    }
  }

  if (verifiedJsAssets.length === 0) {
    errors.push('No local .js/.mjs scripts referenced in src152/dist/index.html');
  }
  if (verifiedCssAssets.length === 0) {
    errors.push('No local .css stylesheets referenced in src152/dist/index.html');
  }

  // Verify nested local CSS @import targets recursively so split CSS modules never dangle
  const visitedCss = new Set();
  async function verifyCssImports(cssFilePath) {
    if (visitedCss.has(cssFilePath)) return;
    visitedCss.add(cssFilePath);
    const cssText = (await fsp.readFile(cssFilePath, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
    const importRegex = /@import\s+(?:url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["'])/gi;
    for (const match of cssText.matchAll(importRegex)) {
      const importRef = (match[1] ?? match[2] ?? '').trim();
      const target = resolveLocalDistAsset(importRef, path.dirname(cssFilePath));
      if (!target) continue;
      if (target.escaped) {
        errors.push(`CSS @import escapes dist/ in ${relFromRepo(cssFilePath)}: ${importRef}`);
        continue;
      }
      const stImport = await statFile(target.resolved);
      if (!stImport || stImport.size === 0) {
        errors.push(`CSS @import target missing or empty in ${relFromRepo(cssFilePath)}: ${importRef} -> ${relFromRepo(target.resolved)}`);
      } else if (target.resolved.toLowerCase().endsWith('.css')) {
        await verifyCssImports(target.resolved);
      }
    }
  }

  for (const cssPath of directLinkedCssPaths) {
    await verifyCssImports(cssPath);
  }

  // Verify desktop/smoke.mjs mathFontsOk contract (.woff2 in directly linked CSS within first 30 refs)
  const woff2Targets = new Set();
  for (const cssPath of directLinkedCssPaths) {
    const cssText = await fsp.readFile(cssPath, 'utf8');
    for (const fontMatch of cssText.matchAll(/url\(["']?([^\s)"']+\.woff2)["']?\)/g)) {
      const resolvedFont = resolveLocalDistAsset(fontMatch[1], path.dirname(cssPath));
      if (resolvedFont && !resolvedFont.escaped) {
        woff2Targets.add(resolvedFont.resolved);
      }
    }
  }

  if (woff2Targets.size === 0) {
    errors.push('No KaTeX .woff2 font url(...) found in stylesheets directly <link>-ed in dist/index.html (required by desktop/smoke.mjs mathFontsOk)');
  } else {
    for (const fontFile of woff2Targets) {
      const fontStat = await statFile(fontFile);
      if (!fontStat || fontStat.size < 4) {
        errors.push(`KaTeX font missing or empty: ${relFromRepo(fontFile)}`);
        continue;
      }
      const handle = await fsp.open(fontFile, 'r');
      try {
        const header = Buffer.alloc(4);
        await handle.read(header, 0, 4, 0);
        if (header.toString('ascii') !== 'wOF2') {
          errors.push(`Invalid wOFF2 magic header in font file: ${relFromRepo(fontFile)}`);
        }
      } finally {
        await handle.close();
      }
    }
  }

  return {
    id: 'dist-html-assets',
    title: 'src152/dist/index.html 本地资源引用与桌面端契约校验',
    passed: errors.length === 0,
    details: {
      totalHtmlReferences: uniqueRefs.length,
      jsAssetCount: verifiedJsAssets.length,
      cssAssetCount: verifiedCssAssets.length,
      importedCssCheckedCount: visitedCss.size,
      woff2FontCount: woff2Targets.size,
    },
    errors,
  };
}

async function checkJsSyntax() {
  const errors = [];
  const uiJsFiles = await collectFiles(uiDir, new Set(['.js', '.mjs']));
  const distJsFiles = await collectFiles(distDir, new Set(['.js', '.mjs']));
  const allTargets = [...uiJsFiles, ...distJsFiles];

  if (uiJsFiles.length === 0) {
    errors.push('No .js/.mjs files found under src152/ui/');
  }
  if (distJsFiles.length === 0) {
    errors.push('No .js/.mjs files found under src152/dist/');
  }

  const checkResults = await runPool(allTargets, 8, (filePath) => runNodeCheck(filePath));
  for (const res of checkResults) {
    if (!res.ok) {
      errors.push(`Syntax error in ${relFromRepo(res.filePath)}: ${res.error}`);
    }
  }

  return {
    id: 'js-syntax-check',
    title: 'JS / MJS 全量语法检查 (node --check)',
    passed: errors.length === 0,
    details: {
      uiFilesChecked: uiJsFiles.length,
      distFilesChecked: distJsFiles.length,
      totalChecked: allTargets.length,
    },
    errors,
  };
}

async function findSourceModuleCss(filename) {
  const candidates = [
    path.join(uiDir, 'styles', 'modules', filename),
    path.join(uiDir, 'styles', filename),
    path.join(uiDir, 'modules', filename),
  ];
  for (const candidate of candidates) {
    if (await statFile(candidate)) return candidate;
  }
  return candidates[0];
}

async function checkVisualCssRules() {
  const errors = [];
  const summary = {};

  const srcWorkspaceTabs = await findSourceModuleCss('workspace-tabs.css');
  const distWorkspaceTabs = path.join(distDir, 'workspace-tabs.css');
  const srcConversationMap = await findSourceModuleCss('conversation-map.css');
  const distConversationMap = path.join(distDir, 'conversation-map.css');

  const workspaceTabsTargets = [
    { label: 'ui/workspace-tabs.css', filePath: srcWorkspaceTabs },
    { label: 'dist/workspace-tabs.css', filePath: distWorkspaceTabs },
  ];

  for (const item of workspaceTabsTargets) {
    const rel = relFromRepo(item.filePath);
    const st = await statFile(item.filePath);
    if (!st || st.size === 0) {
      errors.push(`Missing or empty ${rel}`);
      continue;
    }
    const css = await fsp.readFile(item.filePath, 'utf8');
    const blocks = parseCssRuleBlocks(css);
    const spanReset = verifyCmapTabSpanReset(blocks);
    summary[rel] = {
      cmapTabSpanResetOk: spanReset.ok,
      matchedSelectors: spanReset.matchedSelectors,
    };
    if (!spanReset.ok) {
      errors.push(
        `${rel} is missing transparent background & box-shadow: none reset for #hg-cmap-tab > span / .hg-cmap-tab > span (transparentBg=${spanReset.hasTransparentBg}, noShadow=${spanReset.hasNoShadow})`,
      );
    }
  }

  const conversationMapTargets = [
    { label: 'ui/conversation-map.css', filePath: srcConversationMap },
    { label: 'dist/conversation-map.css', filePath: distConversationMap },
  ];

  for (const item of conversationMapTargets) {
    const rel = relFromRepo(item.filePath);
    const st = await statFile(item.filePath);
    if (!st || st.size === 0) {
      errors.push(`Missing or empty ${rel}`);
      continue;
    }
    const css = await fsp.readFile(item.filePath, 'utf8');
    const blocks = parseCssRuleBlocks(css);
    const spanReset = verifyCmapTabSpanReset(blocks);
    const cardShadowless = verifyMapCardShadowless(blocks);
    summary[rel] = {
      cmapTabSpanResetOk: spanReset.ok,
      mapCardShadowlessOk: cardShadowless.ok,
      matchedCardSelectors: cardShadowless.matchedCardSelectors,
    };

    if (!spanReset.ok) {
      errors.push(
        `${rel} is missing transparent background & box-shadow: none reset for #hg-cmap-tab > span / .hg-cmap-tab > span (transparentBg=${spanReset.hasTransparentBg}, noShadow=${spanReset.hasNoShadow})`,
      );
    }
    if (!cardShadowless.hasBaseShadowNone) {
      errors.push(`${rel} is missing explicit "box-shadow: none" rule on .hg-map-card`);
    }
    if (cardShadowless.shadowViolations.length > 0) {
      errors.push(
        `${rel} still applies non-none box-shadow on .hg-map-card: ${cardShadowless.shadowViolations.join(' | ')}`,
      );
    }
  }

  return {
    id: 'css-visual-rules',
    title: '对话地图标签去胶囊底色污染与卡片无阴影 CSS 规则校验',
    passed: errors.length === 0,
    details: summary,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Main Execution & Reporting
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  const checks = await Promise.all([
    checkLicenses(),
    checkPackageJson(),
    checkUiSourceStructure(),
    checkDistAssetsAndContracts(),
    checkJsSyntax(),
    checkVisualCssRules(),
  ]);

  const failedChecks = checks.filter((c) => !c.passed);
  const allErrors = checks.flatMap((c) => c.errors.map((err) => `[${c.id}] ${err}`));
  const ok = failedChecks.length === 0;

  const report = {
    ok,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    summary: {
      totalChecks: checks.length,
      passedChecks: checks.length - failedChecks.length,
      failedChecks: failedChecks.length,
    },
    checks,
    errors: allErrors,
  };

  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const divider = '='.repeat(72);
    console.log(divider);
    console.log(' Harness Gemini Open-Source UI Verification Report');
    console.log(divider);
    for (const check of checks) {
      const badge = check.passed ? '[PASS]' : '[FAIL]';
      console.log(` ${badge} ${check.title} (${check.id})`);
      if (!check.passed) {
        for (const err of check.errors) {
          console.log(`        - ${err}`);
        }
      }
    }
    console.log('-'.repeat(72));
    console.log(
      ` Result: ${ok ? 'ALL CHECKS PASSED' : 'VERIFICATION FAILED'} (${report.summary.passedChecks}/${report.summary.totalChecks} passed in ${report.durationMs}ms)`,
    );
    console.log('-'.repeat(72));
    console.log(JSON.stringify(report, null, 2));
  }

  if (!ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[verify-ui] Unexpected fatal error:', err);
  process.exitCode = 1;
});
