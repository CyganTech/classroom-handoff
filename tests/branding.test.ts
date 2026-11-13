import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('manifest icon assets have the required PNG dimensions and shared vector branding', async () => {
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
  for (const size of [16, 32, 48, 128]) {
    const path = manifest.icons[String(size)]; assert.equal(typeof path, 'string');
    const png = await readFile(`extension/${path}`);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
    if (size !== 128) assert.equal(manifest.action.default_icon[String(size)], path);
  }
  assert.match(await readFile('extension/icons/logo.svg', 'utf8'), /viewBox="0 0 128 128"/);
});
