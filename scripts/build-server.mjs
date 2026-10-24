import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
await rm('dist/server', { recursive: true, force: true });
await mkdir('dist/server', { recursive: true });
await build({ entryPoints: ['server/index.ts'], outfile: 'dist/server/index.js', bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', sourcemap: true });
console.log('Built backend: dist/server/index.js');
