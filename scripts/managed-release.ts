import { parseArgs } from 'node:util';
import { cp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { zipDirectory } from './lib/zip.js';
import { signCrx, verifyCrx, extensionId } from './lib/crx.js';
import { createManagedManifest, httpsUrl, updateManifest, googleAdminPolicy, assertReleaseUpdate, assertPrivateKeyOutsidePublicOutput } from './lib/managed-release.js';
const { values } = parseArgs({ options: { 'update-base-url': { type: 'string' }, 'backend-url': { type: 'string' }, key: { type: 'string', default: '.signing/classroom-handoff.pem' }, 'init-key': { type: 'boolean', default: false }, 'out-dir': { type: 'string', default: 'site' } } });
if (!values['update-base-url']) throw new Error('Supply --update-base-url https://OWNER.github.io/REPOSITORY/');
const base = httpsUrl(values['update-base-url']); if (!base.endsWith('/')) throw new Error('--update-base-url must end with /');
const keyPath = resolve(values.key!); const site = resolve(values['out-dir']!); const unpacked = resolve('artifacts/managed-extension');
if (site === resolve('.') || site === unpacked || site.startsWith(resolve('.signing'))) throw new Error('Use a public output directory separate from source and signing keys');
await assertPrivateKeyOutsidePublicOutput(site, keyPath);
let pem: string;
try { pem = await readFile(keyPath, 'utf8'); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !values['init-key']) throw new Error('Signing key missing. Use --init-key once, or restore the original private key.');
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await writeFile(keyPath, pem, { flag: 'wx', mode: 0o600 });
}
await chmod(keyPath, 0o600);
const key = createPrivateKey(pem); const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }) as Buffer; const id = extensionId(publicKey);
try { const previous = JSON.parse(await readFile(`${site}/release.json`, 'utf8')); if (previous.extensionId !== id) throw new Error('Signing key does not match the published extension ID. Restore the original key instead of replacing a release.'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
await rm(unpacked, { recursive: true, force: true }); await cp('artifacts/extension', unpacked, { recursive: true });
await build({ entryPoints: ['extension/src/background.ts', 'extension/src/popup.ts', 'extension/src/options.ts'], outdir: unpacked, bundle: true, platform: 'browser', target: 'chrome120', format: 'esm', sourcemap: false, define: { __HANDOFF_MANAGED_RELEASE__: 'true' } });
for (const file of ['background.js.map', 'popup.js.map', 'options.js.map']) await rm(`${unpacked}/${file}`, { force: true });
const original = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const manifest = createManagedManifest(original, publicKey, new URL('updates.xml', base).href, values['backend-url']);
await writeFile(`${unpacked}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
await writeFile(`${unpacked}/BUILD.txt`, `Classroom Handoff managed release ${manifest.version}\nStable ID: ${id}\nBackend origin comes from Google Admin BackendUrl policy. No device tokens are packaged.\n`);
const zip = await zipDirectory(unpacked); const crx = signCrx(zip, key); if (verifyCrx(crx).extensionId !== id) throw new Error('CRX identity verification failed');
const version = String(manifest.version); const filename = `classroom-handoff-${version}.crx`; const zipname = `classroom-handoff-${version}.zip`;

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const release = { schemaVersion: 1, extensionId: id, version, updateUrl: manifest.update_url as string, crxUrl: new URL(filename, base).href, crxSha256: hash(crx), zipSha256: hash(zip), publicKeySha256: hash(publicKey), backendPermission: manifest.host_permissions[0], backendPolicyRequired: true };
try { assertReleaseUpdate(JSON.parse(await readFile(`${site}/release.json`, 'utf8')), release); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
await mkdir(site, { recursive: true }); await writeFile(`${site}/${filename}`, crx); await writeFile(`${site}/${zipname}`, zip);
await writeFile(`${site}/updates.xml`, updateManifest(id, version, release.crxUrl));
await writeFile(`${site}/release.json`, JSON.stringify(release, null, 2) + '\n'); await writeFile(`${site}/extension-id.txt`, id + '\n');
await writeFile(`${site}/SHA256SUMS`, `${hash(crx)}  ${filename}\n${hash(zip)}  ${zipname}\n`);
await writeFile(`${site}/admin-policy.example.json`, JSON.stringify(googleAdminPolicy(values['backend-url'] ?? 'https://YOUR-BACKEND-HOST.invalid'), null, 2) + '\n');
await writeFile(`${site}/chrome-browser-policy.example.json`, JSON.stringify({ ExtensionSettings: { [id]: { installation_mode: 'force_installed', update_url: release.updateUrl, override_update_url: true, toolbar_pin: 'force_pinned' } } }, null, 2) + '\n');
await writeFile(`${site}/.nojekyll`, '');
let html = await readFile('deployment/install.html', 'utf8');
for (const [find, replacement] of Object.entries({ '__EXTENSION_ID__': id, '__UPDATE_URL__': release.updateUrl, '__CRX_FILENAME__': filename, '__VERSION__': version })) html = html.replaceAll(find, replacement);
await writeFile(`${site}/index.html`, html); await cp('deployment/install.js', `${site}/install.js`);
console.log(`Managed release ${version}\nExtension ID: ${id}\nGoogle Admin custom update URL: ${release.updateUrl}\nPublic files: ${site}\nPrivate signing key kept outside the public output. Back it up securely.`);
