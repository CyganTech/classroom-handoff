import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
await rm('dist/server', { recursive: true, force: true });
await mkdir('dist/server', { recursive: true });
await build({ entryPoints: ['server/index.ts'], outfile: 'dist/server/index.js', bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', sourcemap: true });
await mkdir('dist/server/admin', { recursive: true });
await build({ entryPoints: ['server/admin/admin.ts'], outfile: 'dist/server/admin/admin.js', bundle: true, platform: 'browser', target: 'es2022', format: 'iife', minify: true });
for (const filename of ['index.html', 'admin.css', 'logo.svg']) {
  await copyFile(`server/admin/${filename}`, `dist/server/admin/${filename}`);
}
console.log('Built backend: dist/server/index.js');
