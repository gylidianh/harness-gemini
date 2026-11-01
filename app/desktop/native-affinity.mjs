import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';

const UINT64_MAX = 0xffffffffffffffffn;
const scriptUrl = new URL('./read-window-affinity.ps1', import.meta.url);

function handleNumber(handle) {
  let value;
  if (Buffer.isBuffer(handle) || handle instanceof Uint8Array) {
    const bytes = Buffer.from(handle);
    if (![4, 8].includes(bytes.length)) throw new TypeError('Native HWND must contain 4 or 8 bytes.');
    value = bytes.length === 8 ? bytes.readBigUInt64LE() : BigInt(bytes.readUInt32LE());
  } else if (typeof handle === 'bigint') value = handle;
  else if (typeof handle === 'number' && Number.isSafeInteger(handle)) value = BigInt(handle);
  else if (typeof handle === 'string' && /^(?:0x[0-9a-f]{1,16}|[0-9]{1,20})$/i.test(handle)) value = BigInt(handle);
  else throw new TypeError('Native HWND must be a strict integer handle.');
  if (value <= 0n || value > UINT64_MAX) throw new RangeError('Native HWND is outside the pointer range.');
  return value;
}

/**
 * Read the affinity of this app's own HWND, without capturing any pixels.
 * Used only by isolated desktop smoke tests. The native script verifies owner PID
 * before querying the window, and never changes protection or window properties.
 * Reading the script first works when this module is copied inside app.asar.
 */
export async function verifyNativeAffinity(handle, expectedProcessId = process.pid) {
  if (!Number.isSafeInteger(expectedProcessId) || expectedProcessId < 1 || expectedProcessId > 0xffffffff) {
    throw new TypeError('Expected process ID must be a positive UInt32 integer.');
  }
  const normalizedHandle = `0x${handleNumber(handle).toString(16)}`;
  if (process.platform !== 'win32') return { ok: false, error: 'WINDOW_AFFINITY_REQUIRES_WINDOWS' };

  const script = await readFile(scriptUrl, 'utf8');
  // Only validated numeric tokens are appended. There is no shell interpolation,
  // filename execution, arbitrary command argument, or temporary script file.
  const command = `& {\n${script}\n} -WindowHandle '${normalizedHandle}' -ExpectedProcessId ${expectedProcessId}`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = await new Promise((resolve, reject) => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      // The script emits one structured result even for an ownership/query failure.
      const body = stdout.trim().replace(/^\uFEFF/u, '');
      if (!body) { reject(new Error(`Native affinity diagnostic failed: ${error?.code ?? 'NO_OUTPUT'}${stderr ? ` (${stderr.trim().slice(0, 160)})` : ''}`)); return; }
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Native affinity diagnostic did not return JSON.')); }
    });
  });
  if (output.expectedProcessId !== expectedProcessId || output.windowHandle?.toLowerCase() !== normalizedHandle.toLowerCase()) {
    throw new Error('Native affinity diagnostic returned a mismatched window identity.');
  }
  return Object.freeze({
    ok: output.querySucceeded === true && output.ownerProcessId === expectedProcessId && output.affinity === 0x11,
    querySucceeded: output.querySucceeded === true,
    windowHandle: output.windowHandle,
    expectedProcessId,
    ownerProcessId: Number.isInteger(output.ownerProcessId) ? output.ownerProcessId : null,
    affinity: Number.isInteger(output.affinity) ? output.affinity : null,
    affinityHex: typeof output.affinityHex === 'string' ? output.affinityHex : null,
    protected: output.protected === true,
    win32Error: Number.isInteger(output.win32Error) ? output.win32Error : null,
    error: typeof output.error === 'string' ? output.error.slice(0, 300) : null,
  });
}
