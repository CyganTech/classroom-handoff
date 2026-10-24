import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, createPublicKey } from 'node:crypto';
import { signCrx, verifyCrx, extensionId } from '../scripts/lib/crx.js';
import { zipEntries } from '../scripts/lib/zip.js';
import { createManagedManifest, updateManifest, googleAdminPolicy, assertReleaseUpdate, assertPrivateKeyOutsidePublicOutput } from '../scripts/lib/managed-release.js';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }) as Buffer;
const original = { manifest_version: 3, version: '0.2.0', permissions: ['tabs', 'storage'], optional_host_permissions: ['https://*/*'] };
test('CRX3 signature binds developer identity and complete ZIP contents', () => {
  const zip = zipEntries({ 'manifest.json': Buffer.from(JSON.stringify(original)), 'file.txt': Buffer.from('lesson') });
  const crx = signCrx(zip, key); assert.equal(crx.subarray(0, 4).toString(), 'Cr24'); assert.equal(crx.readUInt32LE(4), 3);
  const verified = verifyCrx(crx); assert.equal(verified.extensionId, extensionId(publicKey)); assert.deepEqual(verified.zip, zip);
  // Independent RSA verification against the Chromium-specified signed message.
  assert.equal(verify('sha256', verified.signedMessage, createPublicKey({ key: verified.publicKey, format: 'der', type: 'spki' }), verified.signature), true);
  const changed = Buffer.from(crx); changed[changed.length - 1]! ^= 1; assert.throws(() => verifyCrx(changed), /signature/i);
  assert.throws(() => verifyCrx(crx.subarray(0, 10)));
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }) as Buffer; assert.notEqual(extensionId(other), verified.extensionId);
});
test('ZIP packaging is deterministic and filters unsafe entry paths', () => {
  assert.deepEqual(zipEntries({ 'b.txt': Buffer.from('two'), 'a.txt': Buffer.from('one') }), zipEntries({ 'a.txt': Buffer.from('one'), 'b.txt': Buffer.from('two') }));
  for (const name of ['../key.pem', '/absolute', 'sub/../../key.pem', 'back\\slash']) assert.throws(() => zipEntries({ [name]: Buffer.from('secret') }));
});
test('managed release constrains exact host when known, preserves stable key, and separates update hosting from backend', () => {
  const manifest = createManagedManifest(original, publicKey, 'https://cygantech.github.io/classroom-handoff/updates.xml', 'https://handoff.example.org');
  assert.deepEqual(manifest.host_permissions, ['https://handoff.example.org/*']); assert.deepEqual(manifest.optional_host_permissions, []);
  assert.equal(manifest.update_url, 'https://cygantech.github.io/classroom-handoff/updates.xml'); assert.equal(manifest.key, publicKey.toString('base64'));
  assert.deepEqual(createManagedManifest(original, publicKey, 'https://example.org/updates.xml').host_permissions, ['https://*/*']);
  assert.throws(() => createManagedManifest(original, publicKey, 'http://example.org/updates.xml'));
});
test('public update XML and admin policy use the actual identity and no bearer secrets', () => {
  const id = extensionId(publicKey); const xml = updateManifest(id, '0.2.0', 'https://example.org/extension.crx');
  assert.match(xml, new RegExp(`appid="${id}"`)); assert.match(xml, /version="0.2.0"/); assert.match(xml, /codebase="https:\/\/example.org\/extension.crx"/);
  assert.throws(() => updateManifest('wrong', '0.2.0', 'https://example.org/x.crx')); assert.throws(() => updateManifest(id, 'invalid', 'https://example.org/x.crx'));
  assert.deepEqual(googleAdminPolicy('https://handoff.example.org'), { BackendUrl: { Value: 'https://handoff.example.org' }, AutoRegister: { Value: true } });
});

test('published releases keep identity, immutable version bytes and increasing Chrome versions', () => {
  const old = { extensionId: extensionId(publicKey), version: '0.2.0', crxSha256: 'old' };
  assert.doesNotThrow(() => assertReleaseUpdate(old, { ...old }));
  assert.doesNotThrow(() => assertReleaseUpdate(old, { ...old, version: '0.2.1', crxSha256: 'new' }));
  assert.throws(() => assertReleaseUpdate(old, { ...old, crxSha256: 'changed' }), /version/i);
  assert.throws(() => assertReleaseUpdate(old, { ...old, version: '0.1.9' }), /version/i);
  assert.throws(() => assertReleaseUpdate(old, { ...old, extensionId: 'a'.repeat(32), version: '0.2.1' }), /identity|key/i);
});

import { mkdtemp, rm, access, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
test('release CLI refuses to create a private key anywhere inside public output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-key-boundary-'));
  const site = join(root, 'public'); const key = join(site, 'nested', 'private.pem');
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/managed-release.ts', '--init-key', '--key', key, '--out-dir', site, '--update-base-url', 'https://example.org/'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'a public output directory must never contain a signing key');
    assert.match(result.stderr, /private|signing|public/i);
    await assert.rejects(access(key), 'reject before creating a private key');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('private key exclusion follows symlinked public directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-key-symlink-'));
  try {
    const site = join(root, 'public'); await mkdir(site);
    const alias = join(root, 'alias'); await symlink(site, alias, 'dir');
    await assert.rejects(assertPrivateKeyOutsidePublicOutput(site, join(alias, 'key.pem')), /private signing key/);
    await assert.doesNotReject(assertPrivateKeyOutsidePublicOutput(site, join(root, 'private', 'key.pem')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
