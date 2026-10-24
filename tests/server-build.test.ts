import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('server-only build works without extension sources, tests or a host TypeScript compiler', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-server-build-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    for (const path of ['server', 'shared']) cpSync(path, join(dir, path), { recursive: true });
    if (existsSync('scripts/build-server.mjs')) cpSync('scripts/build-server.mjs', join(dir, 'scripts/build-server.mjs'));
    cpSync('package.json', join(dir, 'package.json'));
    symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
    const result = spawnSync(process.execPath, [join(dir, 'scripts/build-server.mjs')], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, 'dist/server/index.js')), true);
    assert.equal(existsSync(join(dir, 'artifacts')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
