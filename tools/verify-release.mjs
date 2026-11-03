import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'SOURCE-MANIFEST.json'), 'utf8'));
const changed = [];
for (const entry of manifest.files) {
  const file = path.resolve(root, entry.path);
  if (!file.startsWith(root + path.sep)) throw new Error('Invalid manifest path');
  if (!fs.existsSync(file) || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== entry.sha256) changed.push(entry.path);
}
if (changed.length) { console.error(`Files differ from the published ${manifest.version} app:`, changed.join(', ')); process.exitCode = 1; }
else console.log(`${manifest.files.length} application files match the published ${manifest.version} archive.`);
