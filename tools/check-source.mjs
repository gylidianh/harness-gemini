import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const git = spawnSync('git', ['ls-files','--cached','--others','--exclude-standard','-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
const files = git.status === 0 && fs.existsSync(path.join(root, '.git'))
  ? [...new Set(git.stdout.split('\0').filter(Boolean))]
  : collect(root).map(file => path.relative(root, file).replaceAll('\\','/'));
function collect(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['.git','node_modules','.local-data','.local-workspace','release'].includes(entry.name)) return [];
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? collect(file) : [file];
  });
}
const problems = [];
let textCount = 0, syntaxCount = 0;
const username = path.basename(os.homedir());
for (const relative of files) {
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  if (/(^|\/)(node_modules|data|sessions|workspace|logs|backup|__pycache__)(\/|$)|\.(bak|pyc|pyo|log|tmp)$|(^|\/)\.env(?:\.|$)/i.test(relative)) problems.push(`${relative}: runtime or private file`);
  if (!/\.(?:[cm]?js|json|md|txt|html|css|py|ps1|ya?ml|xml|config)$/i.test(relative)) continue;
  textCount++;
  const text = fs.readFileSync(file, 'utf8');
  const privatePath = /[A-Z]:[\\/]+Users[\\/]+(?!Public(?:[\\/])|Default(?:[\\/])|<)[^\\/\s"']+/i.test(text) || /\/(?:Users|home)\/(?!user(?:\/)|username(?:\/)|<)[a-zA-Z0-9._-]+\//.test(text);
  if (privatePath) problems.push(`${relative}: personal home path`);
  if (username.length >= 4 && new RegExp(`\\b${username.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`).test(text)) problems.push(`${relative}: current machine username`);
  if (/codex-clipboard-[0-9a-f-]{36}/i.test(text)) problems.push(`${relative}: clipboard filename`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) problems.push(`${relative}: private key material`);
  if (/(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,}|AKIA[A-Z0-9]{16})/.test(text)) problems.push(`${relative}: credential-shaped value`);
  if (/\.(?:[cm]?js)$/.test(relative)) {
    syntaxCount++;
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
    if (checked.status !== 0) problems.push(`${relative}: JavaScript syntax failed`);
  }
}
console.log(JSON.stringify({ files: files.length, textFiles: textCount, javascriptChecked: syntaxCount, problems }, null, 2));
if (problems.length) process.exitCode = 1;
