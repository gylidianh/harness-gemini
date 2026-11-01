import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { atomicWrite, HttpError } from './util.mjs';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_ENCODED_IMAGE = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_PIXELS = 40_000_000;
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const ARTIFACT_NAME = /^[a-f0-9]{36}\.(?:png|jpg|webp|gif)$/;

function invalid(message = '图片内容或格式不正确。') { throw new HttpError(422, message); }
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > MAX_PIXELS) invalid('图片尺寸超出限制。');
  return { width, height };
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid();
  let offset = 8; let size; let header; let ended = false;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > MAX_IMAGE_BYTES || offset + length + 12 > bytes.length) invalid();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) invalid();
    if (!header) {
      if (type !== 'IHDR' || length !== 13) invalid();
      header = chunk;
      size = dimensions(chunk.readUInt32BE(0), chunk.readUInt32BE(4));
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[chunk[9]]?.includes(chunk[8]) || chunk[10] !== 0 || chunk[11] !== 0 || chunk[12] > 1) invalid();
    } else if (type === 'IHDR') invalid();
    if (type === 'IDAT') compressed.push(chunk);
    offset += length + 12;
    if (type === 'IEND') { if (length !== 0 || offset !== bytes.length) invalid(); ended = true; break; }
  }
  if (!ended || !compressed.length || !size) invalid();
  let raster;
  try { raster = inflateSync(Buffer.concat(compressed), { maxOutputLength: 128 * 1024 * 1024 }); } catch { invalid(); }
  if (header[12] === 0) {
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header[9]];
    const stride = Math.ceil(size.width * channels * header[8] / 8) + 1;
    if (raster.length !== stride * size.height) invalid();
    for (let row = 0; row < size.height; row++) if (raster[row * stride] > 4) invalid();
  }
  return size;
}

function jpeg(bytes) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  let offset = 2; let size; let scanned = false;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) { if (!size || !scanned || offset !== bytes.length) invalid(); return size; }
    if (marker === 0x00 || marker === 0xd8 || marker === undefined) invalid();
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) invalid();
    if (sof.has(marker)) {
      if (length < 8) invalid();
      size = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += length;
    if (marker === 0xda) {
      scanned = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const next = bytes[offset + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
        if (next === 0xff) { offset++; continue; }
        break;
      }
    }
  }
  invalid();
}

function gif(bytes) {
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) invalid();
  const size = dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  let offset = 13 + ((bytes[10] & 0x80) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
  let frames = 0;
  const blocks = () => {
    while (offset < bytes.length) {
      const length = bytes[offset++];
      if (length === 0) return;
      if (offset + length > bytes.length) invalid();
      offset += length;
    }
    invalid();
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) { if (!frames || offset !== bytes.length) invalid(); return size; }
    if (marker === 0x21) { offset++; blocks(); continue; }
    if (marker !== 0x2c || offset + 9 > bytes.length) invalid();
    dimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6));
    const packed = bytes[offset + 8];
    offset += 9 + ((packed & 0x80) ? 3 * (1 << ((packed & 7) + 1)) : 0);
    if (bytes[offset] < 2 || bytes[offset] > 8) invalid();
    offset++; blocks(); frames++;
  }
  invalid();
}

function webp(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
  let offset = 12; let size; let frames = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > bytes.length) invalid();
    if (type === 'VP8X') {
      if (length !== 10) invalid();
      size = dimensions(bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1);
    } else if (type === 'VP8 ') {
      if (length < 10 || bytes.subarray(start + 3, start + 6).toString('hex') !== '9d012a') invalid();
      size ??= dimensions(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff);
      frames = true;
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[start] !== 0x2f) invalid();
      const bits = bytes.readUInt32LE(start + 1);
      size ??= dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      frames = true;
    } else if (type === 'ANMF') { if (length < 24) invalid(); frames = true; }
    offset = start + length + (length & 1);
  }
  if (offset !== bytes.length || !size || !frames) invalid();
  return size;
}

export function validateImageBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) invalid('图片为空或超过 15 MB。');
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) ? 'image/gif'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  if (!mime) invalid('仅支持有效的 PNG、JPEG、WebP 或 GIF 图片。');
  const size = ({ 'image/png': png, 'image/jpeg': jpeg, 'image/webp': webp, 'image/gif': gif })[mime](bytes);
  return { mime, extension: MIME_EXT[mime], ...size };
}

export function decodeImageDataUri(uri) {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(uri);
  if (!match) invalid('仅支持有效的 PNG、JPEG、WebP 或 GIF 内嵌图片。');
  const mime = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  const encoded = match[2];
  if (!encoded.length || encoded.length > MAX_ENCODED_IMAGE || encoded.length % 4 !== 0) invalid('图片为空、编码不完整或超过 15 MB。');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== encoded) invalid('图片的 Base64 编码不正确。');
  const size = ({ 'image/png': png, 'image/jpeg': jpeg, 'image/webp': webp, 'image/gif': gif })[mime](bytes);
  return { bytes, mime, extension: MIME_EXT[mime], ...size };
}

export class ArtifactStore {
  constructor(directory) { this.directory = directory; }
  async save(uri) {
    const image = decodeImageDataUri(uri);
    const id = randomBytes(18).toString('hex');
    const filename = `${id}.${image.extension}`;
    await atomicWrite(path.join(this.directory, filename), image.bytes);
    return {
      id, url: `/api/artifacts/${filename}`, downloadUrl: `/api/artifacts/${filename}?download=1`,
      mime: image.mime, name: `image-${id.slice(0, 8)}.${image.extension}`, width: image.width, height: image.height,
    };
  }
  async resolve(filename) {
    if (!ARTIFACT_NAME.test(filename)) throw new HttpError(404, '图片不存在。');
    const absolute = path.join(this.directory, filename);
    const stat = await fs.lstat(absolute).catch(error => { if (error.code === 'ENOENT') throw new HttpError(404, '图片不存在。'); throw error; });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new HttpError(404, '图片不存在。');
    const extension = path.extname(filename).slice(1);
    const mime = Object.entries(MIME_EXT).find(([, ext]) => ext === extension)?.[0];
    return { absolute, mime, size: stat.size };
  }
}

/** Hold a data URI across arbitrary SSE boundaries; no inline bytes leave this filter. */
export class MediaTextFilter {
  constructor({ artifactStore, onText, onArtifact }) {
    this.artifactStore = artifactStore; this.onText = onText; this.onArtifact = onArtifact;
    this.buffer = ''; this.text = ''; this.artifacts = []; this.discarding = false;
  }
  async emit(text) {
    if (!text) return;
    if (this.text.length + text.length > 2_000_000) throw new Error('回复文本超过 2 MB，已停止接收。');
    this.text += text;
    await this.onText?.(text);
  }
  async write(chunk, final = false) {
    this.buffer += chunk;
    for (;;) {
      if (this.discarding) {
        const boundary = this.buffer.search(/[^A-Za-z0-9+/=]/);
        if (boundary < 0) { this.buffer = ''; if (final) this.discarding = false; return; }
        this.buffer = this.buffer.slice(boundary); this.discarding = false;
      }
      const start = this.buffer.toLowerCase().indexOf('data:');
      if (start < 0) {
        const emitLength = final ? this.buffer.length : Math.max(0, this.buffer.length - 4);
        await this.emit(this.buffer.slice(0, emitLength)); this.buffer = this.buffer.slice(emitLength); return;
      }
      if (start > 0) { await this.emit(this.buffer.slice(0, start)); this.buffer = this.buffer.slice(start); }
      const comma = this.buffer.indexOf(',');
      if (comma < 0) {
        if (!final && this.buffer.length <= 256) return;
        // An unfinished inline image is never replayed as ordinary text.
        if (/^data:image\//i.test(this.buffer)) { this.buffer = ''; await this.emit('[图片数据不完整]'); return; }
        await this.emit('data:'); this.buffer = this.buffer.slice(5); continue;
      }
      const header = this.buffer.slice(0, comma + 1);
      if (!/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,$/i.test(header)) {
        await this.emit('data:'); this.buffer = this.buffer.slice(5); continue;
      }
      const encodedStart = comma + 1;
      const boundary = this.buffer.slice(encodedStart).search(/[^A-Za-z0-9+/=]/);
      const end = boundary < 0 ? this.buffer.length : encodedStart + boundary;
      if (end - encodedStart > MAX_ENCODED_IMAGE) {
        this.buffer = this.buffer.slice(end); this.discarding = boundary < 0;
        await this.emit('[图片超过 15 MB，未保存]'); continue;
      }
      if (boundary < 0 && !final) return;
      const uri = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      try {
        if (this.artifacts.length >= 8) throw new Error('单次回复最多接收 8 张图片。');
        const artifact = await this.artifactStore.save(uri);
        this.artifacts.push(artifact);
        await this.onArtifact?.(artifact);
        await this.emit(artifact.url);
      } catch (error) {
        await this.emit(`[图片未保存：${error instanceof HttpError ? error.message : '图片无效或超出限制。'}]`);
      }
    }
  }
  finish() { return this.write('', true); }
  async cancel() {
    const prefix = this.buffer.toLowerCase().indexOf('data:');
    if (prefix >= 0) this.buffer = this.buffer.slice(0, prefix);
    await this.emit(this.buffer); this.buffer = ''; this.discarding = false;
  }
}

export function contextText(text) {
  return String(text ?? '').replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[内嵌数据已省略]');
}
