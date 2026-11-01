import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const mode = process.argv[2] || 'server';
if (!['server','desktop','smoke'].includes(mode)) throw new Error('Unknown run mode');
const name = mode === 'smoke' ? `smoke-${randomUUID()}` : mode;
const data = path.join(root, '.local-data', name);
const workspace = path.join(root, '.local-workspace', name);
await Promise.all([fs.mkdir(data, { recursive: true }), fs.mkdir(workspace, { recursive: true })]);
const env = { ...process.env, HARNESS_DATA_DIR: data, HARNESS_WORKSPACE_DIR: workspace };
let executable = process.execPath, args = [path.join(root, 'app/server/index.mjs')];
if (mode !== 'server') {
  executable = (await import('electron')).default;
  args = [path.join(root, 'app'), `--data-dir=${data}`, `--workspace-dir=${workspace}`, `--profile-dir=${path.join(data, 'profile')}`];
  if (mode === 'smoke') args.push(`--smoke-test=${path.join(data, 'report.json')}`);
}
const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
