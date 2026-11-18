// Minimal QR encoder for the pairing link.
//
// Scope is deliberately narrow: byte mode, error-correction level L, versions 1–5, one
// Reed-Solomon block each. That is exactly enough for `https://host/#c=<32-byte secret>` and
// keeps the implementation small enough to reason about. The module matrix produced here is
// compared against a reference encoder for every version and mask in tests/qr-verify.mjs, so a
// change that breaks scannability fails a test instead of shipping a QR nobody can scan.

// GF(256) with the QR primitive polynomial 0x11D.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Version table for level L: total codewords, data codewords, EC codewords, alignment centres. */
const VERSIONS = {
  1: { total: 26, data: 19, align: [] },
  2: { total: 44, data: 34, align: [6, 18] },
  3: { total: 70, data: 55, align: [6, 22] },
  4: { total: 100, data: 80, align: [6, 26] },
  5: { total: 134, data: 108, align: [6, 30] },
};
const MAX_VERSION = 5;
const ECL_L_FORMAT_BITS = 1;

export class QrError extends Error {}

function polyMultiply(left, right) {
  const out = new Array(left.length + right.length - 1).fill(0);
  for (let i = 0; i < left.length; i++) {
    for (let j = 0; j < right.length; j++) out[i + j] ^= gfMul(left[i], right[j]);
  }
  return out;
}

function reedSolomon(data, ecLength) {
  let generator = [1];
  for (let i = 0; i < ecLength; i++) generator = polyMultiply(generator, [1, EXP[i]]);
  const remainder = new Array(ecLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < ecLength; i++) remainder[i] ^= gfMul(generator[i + 1], factor);
  }
  return remainder;
}

function utf8Bytes(text) {
  return [...new TextEncoder().encode(text)];
}

/** Runs of bits, MSB first: the last partial byte is padded with zeros. */
function toBits(bytes) {
  const bits = [];
  for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  return bits;
}

function dataCodewords(bytes, version) {
  const capacity = VERSIONS[version].data;
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(0b0100, 4); // byte mode
  push(bytes.length, 8); // versions 1–9 use an 8-bit character count
  for (const byte of bytes) push(byte, 8);

  const capacityBits = capacity * 8;
  if (bits.length > capacityBits) throw new QrError('内容超出该版本的容量。');
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  for (let pad = 0xec; codewords.length < capacity; pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

export function pickVersion(text) {
  const length = utf8Bytes(text).length;
  for (let version = 1; version <= MAX_VERSION; version++) {
    const bits = 4 + 8 + length * 8;
    if (bits <= VERSIONS[version].data * 8) return version;
  }
  throw new QrError('配对链接太长，无法编码成二维码。');
}

/** Penalty rules 1–4 from the specification. Any mask scans; this only picks a tidy one. */
function penalty(modules, size) {
  let score = 0;
  const line = (get) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (get(i, j) === get(i, j - 1)) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  };
  line((a, b) => modules[a][b]);
  line((a, b) => modules[b][a]);

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const value = modules[y][x];
      if (value === modules[y][x + 1] && value === modules[y + 1][x] && value === modules[y + 1][x + 1]) score += 3;
    }
  }

  const finderLike = (cells) => {
    const pattern = [1, 0, 1, 1, 1, 0, 1];
    let hits = 0;
    for (let i = 0; i + 7 <= cells.length; i++) {
      let match = true;
      for (let k = 0; k < 7; k++) if (cells[i + k] !== Boolean(pattern[k])) { match = false; break; }
      if (!match) continue;
      const quiet = (from, to) => { for (let k = from; k < to; k++) if (k >= 0 && k < cells.length && cells[k]) return false; return true; };
      if (quiet(i - 4, i) || quiet(i + 7, i + 11)) hits++;
    }
    return hits;
  };
  for (let y = 0; y < size; y++) score += 40 * finderLike(modules[y]);
  for (let x = 0; x < size; x++) score += 40 * finderLike(modules.map(row => row[x]));

  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

function buildMatrix(version, codewords, mask) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const set = (x, y, dark) => { modules[y][x] = dark; reserved[y][x] = true; };

  // Finder patterns with their separators: a one-module light border around each corner.
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx; const y = oy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const ring = inside && (dx === 0 || dx === 6 || dy === 0 || dy === 6);
        const core = inside && dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        set(x, y, ring || core);
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }

  // Alignment patterns, skipping the three that would collide with a finder.
  const align = VERSIONS[version].align;
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      const cx = align[i]; const cy = align[j];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          set(cx + dx, cy + dy, ring !== 1);
        }
      }
    }
  }

  // Reserve the format areas before data placement, then paint them after masking.
  const formatCells = () => {
    for (let i = 0; i <= 5; i++) set(8, i, false);
    set(8, 7, false); set(8, 8, false); set(7, 8, false);
    for (let i = 9; i < 15; i++) set(14 - i, 8, false);
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, false);
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, false);
    set(8, size - 8, true); // always dark
  };
  formatCells();

  // Data bits snake upward and downward through column pairs, right to left, skipping column 6.
  const bits = toBits(codewords);
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (reserved[y][x] || index >= bits.length) continue;
        modules[y][x] = bits[index] === 1;
        index++;
      }
    }
  }

  const maskBit = (x, y) => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: throw new QrError('蒙版编号必须是 0 到 7。');
    }
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!reserved[y][x] && maskBit(x, y)) modules[y][x] = !modules[y][x];
    }
  }

  // Format information: level and mask, BCH(15,5) protected, then XORed with 0x5412.
  const formatData = (ECL_L_FORMAT_BITS << 3) | mask;
  let remainder = formatData;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const formatBits = ((formatData << 10) | remainder) ^ 0x5412;
  const formatAt = bit => ((formatBits >> bit) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, formatAt(i));
  set(8, 7, formatAt(6));
  set(8, 8, formatAt(7));
  set(7, 8, formatAt(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, formatAt(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, formatAt(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, formatAt(i));
  set(8, size - 8, true);

  return { modules, reserved };
}

/**
 * @returns {{ version:number, size:number, mask:number, modules:boolean[][] }}
 */
/** The codewords this encoder feeds to the placement step. Used by tests/qr-verify.mjs. */
export function codewordsFor(text, version) {
  const data = dataCodewords(utf8Bytes(text), version);
  const ec = reedSolomon(data, VERSIONS[version].total - VERSIONS[version].data);
  return { data, ec };
}

/** Which modules are function patterns (never data), for the same verification. */
export function layoutFor(version) {
  const blank = new Array(VERSIONS[version].total).fill(0);
  const { reserved, modules } = buildMatrix(version, blank, 0);
  return { size: version * 4 + 17, reserved, modules };
}

export function encodeQr(text, { version, mask } = {}) {
  if (typeof text !== 'string' || !text) throw new QrError('二维码内容不能为空。');
  const chosen = version ?? pickVersion(text);
  if (!VERSIONS[chosen]) throw new QrError('只支持版本 1 到 5 的二维码。');
  const bytes = utf8Bytes(text);
  const data = dataCodewords(bytes, chosen);
  const ec = reedSolomon(data, VERSIONS[chosen].total - VERSIONS[chosen].data);
  const codewords = [...data, ...ec];

  if (mask !== undefined) {
    if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new QrError('蒙版编号必须是 0 到 7。');
    return { version: chosen, size: chosen * 4 + 17, mask, modules: buildMatrix(chosen, codewords, mask).modules };
  }
  let best = null;
  for (let candidate = 0; candidate < 8; candidate++) {
    const { modules } = buildMatrix(chosen, codewords, candidate);
    const score = penalty(modules, chosen * 4 + 17);
    if (!best || score < best.score) best = { score, mask: candidate, modules };
  }
  return { version: chosen, size: best.size ?? chosen * 4 + 17, mask: best.mask, modules: best.modules };
}

/** The matrix as one SVG path, so a React panel can draw it without any markup injection. */
export function qrPath(text, { margin = 4, version, mask } = {}) {
  const { size, modules, version: used } = encodeQr(text, { version, mask });
  const total = size + margin * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) path += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }
  return { path, size, version: used, total };
}

/** The same drawing as a standalone file: handy for tests, or for saving an image by hand. */
export function qrSvg(text, { margin = 4, scale = 6, version, mask, dark = '#16202c', light = '#ffffff' } = {}) {
  const { path, total } = qrPath(text, { margin, version, mask });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total * scale}" height="${total * scale}" `
    + `viewBox="0 0 ${total} ${total}" role="img" aria-label="配对二维码" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/>`
    + '</svg>';
}
