import { readdir, readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const table = Array.from({ length: 256 }, (_, value) => { for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(data: Buffer) { let crc = 0xffffffff; for (const byte of data) crc = table[(crc ^ byte) & 255]! ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
export function zipEntries(entries: Record<string, Buffer>): Buffer {
  const local: Buffer[] = []; const directory: Buffer[] = []; let offset = 0; const names = Object.keys(entries).sort();
  if (names.length > 65535) throw new Error('ZIP entry limit exceeded');
  for (const name of names) {
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(p => p === '..' || p === '.' || !p)) throw new Error('Unsafe ZIP path');
    const filename = Buffer.from(name); const data = entries[name]!; const compressed = deflateRawSync(data); const crc = crc32(data);
    if (filename.length > 65535 || data.length > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP32 size limit exceeded');
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(0x5c21, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(compressed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(filename.length, 26);
    local.push(h, filename, compressed);
    const d = Buffer.alloc(46); d.writeUInt32LE(0x02014b50); d.writeUInt16LE(20, 4); d.writeUInt16LE(20, 6); d.writeUInt16LE(0x800, 8); d.writeUInt16LE(8, 10); d.writeUInt16LE(0x5c21, 14); d.writeUInt32LE(crc, 16); d.writeUInt32LE(compressed.length, 20); d.writeUInt32LE(data.length, 24); d.writeUInt16LE(filename.length, 28); d.writeUInt32LE(offset, 42);
    directory.push(d, filename); offset += h.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(directory); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}
export async function zipDirectory(root: string): Promise<Buffer> {
  const entries: Record<string, Buffer> = {};
  async function visit(path = ''): Promise<void> {
    for (const entry of await readdir(`${root}/${path}`, { withFileTypes: true })) {
      const name = path + entry.name;
      if (entry.isDirectory()) await visit(name + '/');
      else if (entry.isFile() && !name.endsWith('.map')) entries[name] = await readFile(`${root}/${name}`);
      else if (entry.isSymbolicLink()) throw new Error('Symlinks cannot be packaged');
    }
  }
  await visit(); return zipEntries(entries);
}
