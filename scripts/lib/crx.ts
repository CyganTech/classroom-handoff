import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
// Chromium components/crx_file/crx3.proto and crx_creator.cc (RSA_PKCS1_SHA256).
function varint(value: number): Buffer { const bytes = []; do { const b = value & 127; value = Math.floor(value / 128); bytes.push(b | (value ? 128 : 0)); } while (value); return Buffer.from(bytes); }
function field(id: number, value: Buffer): Buffer { return Buffer.concat([varint(id * 8 + 2), varint(value.length), value]); }
function uint32(value: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; }
const context = Buffer.from('CRX3 SignedData\0');
export function extensionId(publicKey: Buffer): string { return [...createHash('sha256').update(publicKey).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join(''); }
export function signCrx(zip: Buffer, privateKey: KeyObject): Buffer {
  if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('CRX signing requires an RSA key of at least 2048 bits');
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer;
  const signedData = field(1, createHash('sha256').update(publicKey).digest().subarray(0, 16));
  const signature = sign('sha256', Buffer.concat([context, uint32(signedData.length), signedData, zip]), privateKey);
  const header = Buffer.concat([field(2, Buffer.concat([field(1, publicKey), field(2, signature)])), field(10000, signedData)]);
  return Buffer.concat([Buffer.from('Cr24'), uint32(3), uint32(header.length), header, zip]);
}
function fields(buffer: Buffer): Map<number, Buffer> {
  const result = new Map<number, Buffer>(); let position = 0;
  function readVarint() { let value = 0; for (let i = 0; i < 5; i++) { if (position >= buffer.length) throw new Error('Truncated CRX protobuf'); const b = buffer[position++]!; value += (b & 127) * 2 ** (7 * i); if (!(b & 128)) return value; } throw new Error('Invalid CRX protobuf'); }
  while (position < buffer.length) {
    const tag = readVarint(); if ((tag & 7) !== 2) throw new Error('Unexpected CRX field encoding');
    const id = Math.floor(tag / 8); const length = readVarint(); if (!id || length > buffer.length - position || result.has(id)) throw new Error('Invalid CRX field');
    result.set(id, buffer.subarray(position, position + length)); position += length;
  }
  return result;
}
export function verifyCrx(crx: Buffer) {
  if (crx.length < 12 || crx.subarray(0, 4).toString() !== 'Cr24' || crx.readUInt32LE(4) !== 3) throw new Error('Not a CRX3 package');
  const size = crx.readUInt32LE(8); if (size > 65536 || size > crx.length - 16) throw new Error('Invalid CRX header length');
  const header = fields(crx.subarray(12, 12 + size)); const proof = fields(header.get(2) ?? Buffer.alloc(0));
  const publicKey = proof.get(1); const signature = proof.get(2); const signedData = header.get(10000);
  if (!publicKey || !signature || !signedData) throw new Error('Missing CRX signature');
  const id = fields(signedData).get(1); if (!id?.equals(createHash('sha256').update(publicKey).digest().subarray(0, 16))) throw new Error('CRX identity mismatch');
  const zip = crx.subarray(12 + size); if (zip.readUInt32LE(0) !== 0x04034b50) throw new Error('Missing ZIP');
  const signedMessage = Buffer.concat([context, uint32(signedData.length), signedData, zip]);
  if (!verify('sha256', signedMessage, createPublicKey({ key: publicKey, type: 'spki', format: 'der' }), signature)) throw new Error('CRX signature verification failed');
  return { extensionId: extensionId(publicKey), publicKey, signature, signedMessage, zip };
}
