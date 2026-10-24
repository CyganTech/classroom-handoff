import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const project = `classroom-handoff-check-${process.pid}`;
const env = { ...process.env, PORT: '0', PUBLIC_URL: 'http://localhost:8787' };
const compose = (...args) => execFileSync('docker', ['compose', '-p', project, '-f', 'compose.yaml', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function ready(origin) {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(origin + '/healthz', { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Restart in progress. */ }
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error('Container health endpoint did not become ready');
}
try {
  compose('up', '-d', '--build', '--wait', '--wait-timeout', '45');
  const address = compose('port', 'backend', '8787').trim();
  let origin = `http://${address}`; console.log('Checking published container health…'); await ready(origin);
  const uid = compose('exec', '-T', 'backend', 'id', '-u').trim(); assert.notEqual(uid, '0');
  const response = await fetch(origin + '/api/devices/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Container persistence smoke' }) });
  assert.equal(response.status, 201); const credential = await response.json();
  console.log('Restarting container and checking persisted registration…');
  compose('restart', 'backend');
  origin = `http://${compose('port', 'backend', '8787').trim()}`;
  await ready(origin);
  const persisted = await fetch(origin + '/api/devices', { headers: { Authorization: `Bearer ${credential.token}` } });
  assert.equal(persisted.status, 200); assert.deepEqual(await persisted.json(), { devices: [] });
  console.log(`Docker Compose smoke passed: healthy non-root backend (uid ${uid}), read-only root, writable persistent database, authenticated API survives restart.`);
} catch (error) {
  console.error(error.message);
  try { console.error(compose('logs', '--tail', '20', 'backend')); } catch { /* Preserve original diagnostic. */ }
  if (error.stderr) console.error(String(error.stderr).slice(-4000));
  process.exitCode = 1;
} finally {
  try { compose('down', '--volumes', '--remove-orphans'); } catch (error) { console.error('Could not remove temporary validation stack:', error.message); process.exitCode = 1; }
}
