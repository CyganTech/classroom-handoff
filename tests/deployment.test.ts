import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

// Docker calls are intercepted here; scripts/docker-smoke.mjs exercises real containers.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'handoff deployment '));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const log = join(dir, 'docker-calls');
  if (existsSync('handoff')) copyFileSync('handoff', join(dir, 'handoff'));
  for (const file of ['compose.yaml', 'compose.proxy.yaml']) if (existsSync(file)) copyFileSync(file, join(dir, file));
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args)+'\\n');if(args.includes('up'))process.exit(Number(process.env.UP_EXIT||0));`);
  chmodSync(join(bin, 'docker'), 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log };
  delete env.COMPOSE_FILE; delete env.COMPOSE_PROJECT_NAME;
  const run = (...args: string[]) => spawnSync('/bin/sh', [join(dir, 'handoff'), ...args], { cwd: tmpdir(), env, encoding: 'utf8' });
  const calls = (): string[][] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { dir, env, run, calls, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('setup writes minimal config and waits for healthy deployment from another directory', () => {
  const f = fixture(); try {
    const result = f.run('setup', 'https://handoff.example.org');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.dir, '.env'), 'utf8'), 'PUBLIC_URL=https://handoff.example.org\nBIND_ADDRESS=127.0.0.1\nPORT=8787\n');
    assert.ok(f.calls().some(args => args.includes('--project-directory') && args.includes(f.dir) && args.includes('up') && args.includes('--build') && args.includes('--wait')));
    assert.match(result.stdout, /healthy/i);
  } finally { f.close(); }
});

test('setup accepts a separate proxy host and external Docker proxy network', () => {
  const f = fixture(); try {
    const result = f.run('setup', 'https://handoff.example.org:8443', '--bind', '192.168.1.20', '--port', '9876', '--network', 'proxy-net');
    assert.equal(result.status, 0, result.stderr);
    const config = readFileSync(join(f.dir, '.env'), 'utf8');
    assert.match(config, /BIND_ADDRESS=192\.168\.1\.20\nPORT=9876\n/);
    assert.match(config, /PROXY_NETWORK=proxy-net\n/);
    assert.match(config, /COMPOSE_FILE=compose\.yaml:compose\.proxy\.yaml\n/);
  } finally { f.close(); }
});

test('repeat setup preserves existing config and does not deploy', () => {
  const f = fixture(); try {
    writeFileSync(join(f.dir, '.env'), 'PUBLIC_URL=https://existing.example.org\n');
    const result = f.run('setup', 'https://other.example.org');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/i);
    assert.equal(readFileSync(join(f.dir, '.env'), 'utf8'), 'PUBLIC_URL=https://existing.example.org\n');
    assert.ok(!f.calls().some(args => args.includes('up')));
  } finally { f.close(); }
});

test('invalid origins and options cannot write config or deploy', () => {
  const invalid = [
    ['setup', 'http://handoff.example.org'], ['setup', 'https://host/path'], ['setup', 'https://user:password@host'],
    ['setup', 'https://host?x=y'], ['setup', 'https://999.999.999.999'], ['setup', 'https://a..b'],
    ['setup', 'https://-bad.example.org'], ['setup', 'https://bad-.example.org'],
    ['setup', `https://${'a'.repeat(64)}.example.org`], ['setup', 'https://010.0.0.1'], ['setup', 'https://host\nPORT=80'], ['setup', 'https://host$HOME'],
    ['setup', 'https://host', '--port', '0'], ['setup', 'https://host', '--port', '65536'],
    ['setup', 'https://host', '--bind', '999.1.1.1'], ['setup', 'https://host', '--bind', '1.2.3.4\n8.8.8.8'], ['setup', 'https://host', '--network', 'bad network'],
    ['setup', 'https://host', '--port'], ['setup', 'https://host', '--wat'], ['setup'], ['stop', '--volumes'],
  ];
  for (const args of invalid) {
    const f = fixture(); try {
      const result = f.run(...args);
      assert.notEqual(result.status, 0, JSON.stringify(args));
      assert.equal(existsSync(join(f.dir, '.env')), false);
      assert.ok(!f.calls().some(args => args.includes('up')));
    } finally { f.close(); }
  }
});

test('failed health wait returns failure with diagnostics and no success claim', () => {
  const f = fixture(); try {
    writeFileSync(join(f.dir, '.env'), 'PUBLIC_URL=https://host\n'); f.env.UP_EXIT = '17';
    const result = f.run('up');
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /backend is healthy/i);
    assert.match(result.stderr, /failed/i);
    assert.ok(f.calls().some(args => args.includes('logs')));
  } finally { f.close(); }
});

test('stop keeps volumes and logs/status work without changing configuration', () => {
  const f = fixture(); try {
    writeFileSync(join(f.dir, '.env'), 'PUBLIC_URL=https://host\n');
    for (const command of ['stop', 'status', 'logs']) assert.equal(f.run(command).status, 0);
    assert.ok(f.calls().some(args => args.includes('down')));
    assert.ok(f.calls().some(args => args.includes('ps')));
    assert.ok(f.calls().some(args => args.includes('logs') && args.includes('--follow')));
    assert.ok(!f.calls().some(args => args.includes('--volumes') || args.includes('-v')));
  } finally { f.close(); }
});

test('update fast-forwards a clean real Git checkout, then deploys the new helper', () => {
  const f = fixture(); try {
    const git = (...args: string[]) => execFileSync('git', ['-C', f.dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-b', 'main'); git('config', 'user.name', 'Deployment test'); git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(f.dir, '.gitignore'), '.env\nbin/\ndocker-calls\nremote/\ndownloaded-executed\n');
    // Ensure the red phase fails on missing helper behavior, rather than fixture setup.
    if (!existsSync(join(f.dir, 'handoff'))) writeFileSync(join(f.dir, 'handoff'), 'exit 99\n');
    git('add', '.'); git('commit', '-m', 'initial');
    execFileSync('git', ['clone', '--bare', f.dir, join(f.dir, 'remote')], { stdio: 'pipe' });
    git('remote', 'add', 'origin', join(f.dir, 'remote')); git('fetch', 'origin'); git('branch', '--set-upstream-to=origin/main', 'main');
    // A local remote with a newer helper proves update actually reloads the downloaded script.
    const next = join(f.dir, 'next');
    execFileSync('git', ['clone', join(f.dir, 'remote'), next], { stdio: 'pipe' });
    execFileSync('git', ['-C', next, 'config', 'user.name', 'Deployment test']);
    execFileSync('git', ['-C', next, 'config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(next, 'handoff'), readFileSync(join(next, 'handoff'), 'utf8').replace('up) start ;;', 'up) printf downloaded > "$ROOT/downloaded-executed"; start ;;') + '\n# downloaded revision\n');
    execFileSync('git', ['-C', next, 'add', 'handoff']); execFileSync('git', ['-C', next, 'commit', '-m', 'update'], { stdio: 'pipe' });
    execFileSync('git', ['-C', next, 'push'], { stdio: 'pipe' }); rmSync(next, { recursive: true });
    writeFileSync(join(f.dir, '.env'), 'PUBLIC_URL=https://host\n');
    const result = f.run('update'); assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(f.dir, 'handoff'), 'utf8'), /downloaded revision/);
    assert.equal(readFileSync(join(f.dir, 'downloaded-executed'), 'utf8'), 'downloaded');
    assert.ok(f.calls().some(args => args.includes('up')));
    writeFileSync(join(f.dir, 'handoff'), '# dirty\n' + readFileSync(join(f.dir, 'handoff'), 'utf8'));
    const count = f.calls().length;
    const dirty = f.run('update'); assert.notEqual(dirty.status, 0); assert.match(dirty.stderr, /uncommitted/i);
    assert.equal(f.calls().slice(count).some(args => args.includes('up')), false);
    git('restore', 'handoff');
    writeFileSync(join(f.dir, 'local-change'), 'local'); git('add', 'local-change'); git('commit', '-m', 'local revision');
    const localHead = git('rev-parse', 'HEAD');
    execFileSync('git', ['clone', join(f.dir, 'remote'), next], { stdio: 'pipe' });
    execFileSync('git', ['-C', next, 'config', 'user.name', 'Deployment test']);
    execFileSync('git', ['-C', next, 'config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(next, 'remote-change'), 'remote');
    execFileSync('git', ['-C', next, 'add', 'remote-change']); execFileSync('git', ['-C', next, 'commit', '-m', 'diverged remote'], { stdio: 'pipe' });
    execFileSync('git', ['-C', next, 'push'], { stdio: 'pipe' }); rmSync(next, { recursive: true });
    const beforeDivergence = f.calls().length;
    const diverged = f.run('update'); assert.notEqual(diverged.status, 0); assert.match(diverged.stderr, /Git update failed/);
    assert.equal(git('rev-parse', 'HEAD'), localHead); assert.equal(readFileSync(join(f.dir, 'local-change'), 'utf8'), 'local');
    assert.equal(f.calls().slice(beforeDivergence).some(args => args.includes('up')), false);
  } finally { f.close(); }
});
