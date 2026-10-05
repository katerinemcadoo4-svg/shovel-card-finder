import { deflateRawSync } from 'node:zlib';

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}

/** Minimal ZIP fixture builder for both stored and DEFLATE entries. */
export function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, contents, method = 8, deflateOptions = {}] of entries) {
    const data = contents instanceof Uint8Array ? contents : new TextEncoder().encode(contents);
    const nameBytes = new TextEncoder().encode(name);
    const compressed = method === 8 ? deflateRawSync(data, deflateOptions) : data;
    const checksum = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, compressed.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, compressed);

    const descriptor = new Uint8Array(46 + nameBytes.length);
    const descriptorView = new DataView(descriptor.buffer);
    descriptorView.setUint32(0, 0x02014b50, true);
    descriptorView.setUint16(4, 20, true);
    descriptorView.setUint16(6, 20, true);
    descriptorView.setUint16(8, 0x0800, true);
    descriptorView.setUint16(10, method, true);
    descriptorView.setUint32(16, checksum, true);
    descriptorView.setUint32(20, compressed.length, true);
    descriptorView.setUint32(24, data.length, true);
    descriptorView.setUint16(28, nameBytes.length, true);
    descriptorView.setUint32(42, offset, true);
    descriptor.set(nameBytes, 46);
    central.push(descriptor);
    offset += local.length + compressed.length;
  }
  const centralSize = central.reduce((sum, bytes) => sum + bytes.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  return Uint8Array.from([...chunks, ...central, end].flatMap((part) => [...part]));
}
