import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const project = `classroom-handoff-check-${process.pid}`;
const proxyNetwork = `${project}-proxy`;
let networkCreated = false;
const dir = mkdtempSync(join(tmpdir(), 'handoff-docker-check-'));
// Copy only deployment inputs: never copy local credentials or signing keys.
mkdirSync(join(dir, 'scripts'));
for (const file of ['handoff', 'Dockerfile', '.dockerignore', 'compose.yaml', 'compose.proxy.yaml', 'package.json', 'package-lock.json', 'scripts/build-server.mjs', 'server', 'shared']) {
  cpSync(file, join(dir, file), { recursive: true });
}
// Compose chooses an ephemeral host port; setup's default is overridden only in this isolated test.
const env = { ...process.env, COMPOSE_PROJECT_NAME: project, PORT: '0', BIND_ADDRESS: '127.0.0.1', PUBLIC_URL: 'https://handoff.example.invalid' };
delete env.COMPOSE_FILE; // An empty COMPOSE_FILE means the current directory, not the default file.
const options = { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 };
const compose = (...args) => execFileSync('docker', ['compose', '--project-directory', dir, '--env-file', join(dir, '.env'), ...args], options);
const helper = (...args) => execFileSync('/bin/sh', [join(dir, 'handoff'), ...args], options);
async function ready(origin) {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(origin + '/healthz', { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Restart in progress. */ }
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error('Container health endpoint did not become ready');
}
const origin = () => `http://${compose('port', 'backend', '8787').trim()}`;
try {
  execFileSync('docker', ['network', 'create', proxyNetwork], options); networkCreated = true;
  console.log('Running actual ./handoff setup with an isolated external proxy network…');
  const setup = helper('setup', 'https://handoff.example.invalid', '--network', proxyNetwork); assert.match(setup, /Backend is healthy/);
  await ready(origin());
  console.log('Checking upstream hostname from a separate proxy-network container…');
  execFileSync('docker', ['run', '--rm', '--network', proxyNetwork, 'node:24-alpine', 'node', '-e', "fetch('http://classroom-handoff:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], options);
  const uid = compose('exec', '-T', 'backend', 'id', '-u').trim(); assert.notEqual(uid, '0');
  const response = await fetch(origin() + '/api/devices/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Container persistence smoke' }) });
  assert.equal(response.status, 201); const credential = await response.json();
  const assertPersisted = async () => {
    await ready(origin());
    const persisted = await fetch(origin() + '/api/devices', { headers: { Authorization: `Bearer ${credential.token}` } });
    assert.equal(persisted.status, 200); assert.deepEqual(await persisted.json(), { devices: [] });
  };
  console.log('Recreating the container, rebuilding through ./handoff up and checking authenticated data…');
  const previousId = compose('ps', '-q', 'backend').trim();
  compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90');
  assert.notEqual(compose('ps', '-q', 'backend').trim(), previousId);
  assert.match(helper('up'), /Backend is healthy/); await assertPersisted();
  console.log('Stopping through ./handoff stop, starting again and checking persistent registrations…');
  helper('stop'); assert.match(helper('up'), /Backend is healthy/); await assertPersisted();
  console.log(`Docker helper smoke passed: setup, health, rebuild, recreation, stop/start, proxy-network DNS/HTTP, uid ${uid}, and preserved authenticated registration.`);
} catch (error) {
  console.error(error.message);
  try { console.error(compose('logs', '--tail', '20', 'backend')); } catch { /* Preserve original diagnostic. */ }
  if (error.stderr) console.error(String(error.stderr).slice(-4000));
  process.exitCode = 1;
} finally {
  try { compose('down', '--volumes', '--remove-orphans'); } catch (error) { console.error('Could not remove temporary validation stack:', error.message); process.exitCode = 1; }
  if (networkCreated) {
    try { execFileSync('docker', ['network', 'rm', proxyNetwork], options); } catch (error) { console.error('Could not remove temporary proxy network:', error.message); process.exitCode = 1; }
  }
  rmSync(dir, { recursive: true, force: true });
}
