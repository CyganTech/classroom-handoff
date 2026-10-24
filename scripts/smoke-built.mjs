import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const dataDir = await mkdtemp(join(tmpdir(), 'handoff-built-'));
const child = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, PUBLIC_URL: 'http://localhost' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; let errorOutput = '';
child.stderr.on('data', chunk => { errorOutput += chunk; });
try {
  const address = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Built server startup timed out: ${errorOutput}`)), 10000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', code => { clearTimeout(deadline); reject(new Error(`Built server exited ${code}: ${errorOutput}`)); });
    child.stdout.on('data', chunk => { output += chunk; const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output); if (match) { clearTimeout(deadline); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  assert.equal((await fetch(address + '/healthz')).status, 200);
  const registration = await fetch(address + '/api/devices/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Built artifact smoke test' }) });
  assert.equal(registration.status, 201);
  const credentials = await registration.json();
  const peers = await fetch(address + '/api/devices', { headers: { Authorization: `Bearer ${credentials.token}` } });
  assert.equal(peers.status, 200); assert.deepEqual(await peers.json(), { devices: [] });
  console.log('Built backend runtime smoke passed: health, registration, authenticated API.');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  await rm(dataDir, { recursive: true, force: true });
}
