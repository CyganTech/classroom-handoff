import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
// Deterministic ZIP32 writer: avoids requiring a platform-specific zip executable.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data) { let crc = 0xffffffff; for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
async function files(path = '') {
  const output = [];
  for (const entry of await readdir(`artifacts/extension/${path}`, { withFileTypes: true })) {
    const name = path + entry.name;
    if (entry.isDirectory()) output.push(...await files(name + '/'));
    else if (entry.isFile() && !name.endsWith('.map')) output.push(name);
  }
  return output.sort();
}
await readFile('artifacts/extension/manifest.json');
const entries = await files(); const localParts = []; const centralParts = []; let offset = 0;
for (const name of entries) {
  const nameBytes = Buffer.from(name); const data = await readFile(`artifacts/extension/${name}`); const compressed = deflateRawSync(data); const crc = crc32(data);
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(0x5c21, 12); // 2026-01-01
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(nameBytes.length, 26);
  localParts.push(header, nameBytes, compressed);
  const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt16LE(0x5c21, 14);
  directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(offset, 42);
  centralParts.push(directory, nameBytes); offset += header.length + nameBytes.length + compressed.length;
}
const central = Buffer.concat(centralParts); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
const archive = 'artifacts/classroom-handoff-extension.zip'; await mkdir('artifacts', { recursive: true });
const bytes = Buffer.concat([...localParts, central, end]); await writeFile(archive, bytes);
const hash = createHash('sha256').update(bytes).digest('hex'); await writeFile(`${archive}.sha256`, `${hash}  classroom-handoff-extension.zip\n`);
console.log(`Packaged ${archive} (${entries.length} files)\nSHA-256 ${hash}`);
