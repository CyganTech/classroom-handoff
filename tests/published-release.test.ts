import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { verifyCrx } from '../scripts/lib/crx.js';
test('committed managed package, manifest, update XML and metadata agree and contain no private key', async () => {
  const release = JSON.parse(await readFile('site/release.json', 'utf8'));
  assert.match(release.version, /^\d+(\.\d+){0,3}$/);
  const crx = await readFile(`site/classroom-handoff-${release.version}.crx`);
  const zip = await readFile(`site/classroom-handoff-${release.version}.zip`);
  const verified = verifyCrx(crx);
  assert.equal(verified.extensionId, release.extensionId);
  assert.deepEqual(verified.zip, zip);
  assert.equal(createHash('sha256').update(crx).digest('hex'), release.crxSha256);
  assert.equal(createHash('sha256').update(zip).digest('hex'), release.zipSha256);
  assert.equal((await readFile('site/extension-id.txt', 'utf8')).trim(), release.extensionId);
  const entries = new Map<string, Buffer>(); let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18); const nameLength = zip.readUInt16LE(offset + 26); const extra = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString(); const start = offset + 30 + nameLength + extra;
    assert.equal(zip.readUInt16LE(offset + 8), 8); const data = inflateRawSync(zip.subarray(start, start + size));
    assert.equal(name.includes('..'), false); assert.equal(name.endsWith('.pem'), false); assert.equal(data.includes(Buffer.from('-----BEGIN PRIVATE KEY-----')), false);
    entries.set(name, data); offset = start + size;
  }
  const manifest = JSON.parse(entries.get('manifest.json')!.toString());
  if (manifest.icons) {
    for (const size of [16, 32, 48, 128]) {
      const png = entries.get(manifest.icons[String(size)]); assert.ok(png, `Packaged icon ${size}`);
      assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
    }
    assert.ok(entries.has('icons/logo.svg')); assert.ok(entries.has('theme.js'));
  }
  assert.equal(manifest.version, release.version); assert.equal(manifest.key, verified.publicKey.toString('base64')); assert.equal(manifest.update_url, release.updateUrl);
  assert.equal(manifest.storage.managed_schema, 'managed-schema.json'); assert.ok(entries.has(manifest.storage.managed_schema)); assert.deepEqual(manifest.optional_host_permissions, []);
  assert.deepEqual(manifest.host_permissions, [release.backendPermission]);
  const xml = await readFile('site/updates.xml', 'utf8'); assert.ok(xml.includes(`appid="${release.extensionId}"`)); assert.ok(xml.includes(`version="${release.version}"`)); assert.ok(xml.includes(`codebase="${release.crxUrl}"`));
});
