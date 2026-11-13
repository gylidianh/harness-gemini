import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImageBytes, decodeImageDataUri, MAX_IMAGE_BYTES } from '../app/server/media.mjs';

// Generated structural fixture; not claimed to be a fully entropy-decodable photograph.
const segment = (marker, body) => {
  const length = Buffer.alloc(2); length.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, body]);
};
const frame = segment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
const scan = segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0]));
const jpeg = (prefix = Buffer.alloc(0)) => Buffer.concat([
  Buffer.from([0xff, 0xd8]), prefix, frame, scan,
  Buffer.from([0x13, 0xff, 0x00, 0x14, 0xff, 0xd0, 0x15, 0xff, 0xd9]),
]);
const uri = bytes => `data:image/jpeg;base64,${bytes.toString('base64')}`;
const bothReject = bytes => {
  assert.throws(() => validateImageBytes(bytes));
  assert.throws(() => decodeImageDataUri(uri(bytes)));
};

test('JPEG accepts 24 trailing bytes and preserves the exact original data', () => {
  const bytes = Buffer.concat([jpeg(), Buffer.alloc(24, 0x41)]);
  assert.deepEqual(validateImageBytes(bytes), { mime: 'image/jpeg', extension: 'jpg', width: 1, height: 1 });
  const decoded = decodeImageDataUri(uri(bytes));
  assert.deepEqual(decoded.bytes, bytes);
  assert.equal(decoded.width, 1); assert.equal(decoded.height, 1);
});

test('an EOI inside an APP segment cannot replace the main image EOI', () => {
  const bytes = jpeg(segment(0xe1, Buffer.from([0x45, 0x78, 0xff, 0xd9, 0, 0])));
  assert.equal(validateImageBytes(bytes).mime, 'image/jpeg');
  bothReject(bytes.subarray(0, bytes.length - 2));
});

test('every truncated prefix of the structural JPEG is rejected at both entry points', () => {
  const bytes = jpeg();
  for (let length = 0; length < bytes.length; length++) bothReject(bytes.subarray(0, length));
});

test('missing frame, missing scan, invalid component length and excess size are rejected', () => {
  bothReject(Buffer.concat([Buffer.from([0xff, 0xd8]), scan, Buffer.from([1, 0xff, 0xd9])]));
  bothReject(Buffer.concat([Buffer.from([0xff, 0xd8]), frame, Buffer.from([0xff, 0xd9])]));
  const broken = jpeg(); broken[11] = 2; bothReject(broken);
  bothReject(Buffer.concat([jpeg(), Buffer.alloc(MAX_IMAGE_BYTES)]));
});
