/**
 * Small, dependency-free ZIP reader for local asset packs. It deliberately
 * supports only ordinary single-disk ZIP files with stored or DEFLATE entries.
 * Entries are never written to the filesystem.
 */

export const ZIP_LIMITS = Object.freeze({
  archiveBytes: 80 * 1024 * 1024,
  entries: 512,
  entryBytes: 24 * 1024 * 1024,
  totalBytes: 160 * 1024 * 1024,
});

const decoder = new TextDecoder('utf-8', { fatal: true });
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function fail(message) {
  throw new Error(`Invalid asset ZIP: ${message}`);
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}

function uint16(view, offset) { return view.getUint16(offset, true); }
function uint32(view, offset) { return view.getUint32(offset, true); }

function checkedPath(path) {
  if (!path || path.startsWith('/') || path.includes('\\') || /^[a-zA-Z]:/.test(path) || /[\u0000-\u001f\u007f]/.test(path)) {
    fail(`unsafe entry path ${JSON.stringify(path)}`);
  }
  const parts = path.split('/');
  if (parts.some((part, index) => part === '.' || part === '..' || (part === '' && index !== parts.length - 1))) {
    fail(`unsafe entry path ${JSON.stringify(path)}`);
  }
  return path;
}

function makeHuffman(lengths) {
  const count = new Uint16Array(16);
  for (const length of lengths) {
    if (!Number.isInteger(length) || length < 0 || length > 15) fail('invalid DEFLATE code length');
    if (length) count[length]++;
  }
  let available = 1;
  const nextCode = new Uint16Array(16);
  let code = 0;
  for (let length = 1; length <= 15; length++) {
    available = (available << 1) - count[length];
    if (available < 0) fail('oversubscribed DEFLATE Huffman tree');
    code = (code + count[length - 1]) << 1;
    nextCode[length] = code;
  }
  const byLength = Array.from({ length: 16 }, () => new Map());
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol];
    if (length) byLength[length].set(nextCode[length]++, symbol);
  }
  return byLength;
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.position = 0;
    this.bits = 0;
    this.bitCount = 0;
  }
  read(count) {
    while (this.bitCount < count) {
      if (this.position >= this.bytes.length) fail('truncated DEFLATE stream');
      this.bits |= this.bytes[this.position++] << this.bitCount;
      this.bitCount += 8;
    }
    const value = this.bits & ((1 << count) - 1);
    this.bits >>>= count;
    this.bitCount -= count;
    return value;
  }
  symbol(tree) {
    let code = 0;
    for (let length = 1; length <= 15; length++) {
      code = (code << 1) | this.read(1);
      const symbol = tree[length].get(code);
      if (symbol !== undefined) return symbol;
    }
    fail('invalid DEFLATE Huffman code');
  }
  alignByte() {
    this.bits = 0;
    this.bitCount = 0;
  }
}

const FIXED_LITERAL_TREE = makeHuffman(Array.from({ length: 288 }, (_, index) =>
  index < 144 ? 8 : index < 256 ? 9 : index < 280 ? 7 : 8));
const FIXED_DISTANCE_TREE = makeHuffman(Array(32).fill(5));

function dynamicTrees(reader) {
  const literalCount = reader.read(5) + 257;
  const distanceCount = reader.read(5) + 1;
  const codeCount = reader.read(4) + 4;
  const codeLengths = Array(19).fill(0);
  for (let i = 0; i < codeCount; i++) codeLengths[CODE_LENGTH_ORDER[i]] = reader.read(3);
  const codeTree = makeHuffman(codeLengths);
  const lengths = [];
  while (lengths.length < literalCount + distanceCount) {
    const symbol = reader.symbol(codeTree);
    if (symbol <= 15) lengths.push(symbol);
    else {
      const repeated = symbol === 16 ? lengths.at(-1) : 0;
      if (repeated === undefined) fail('invalid first repeat in DEFLATE tree');
      const count = symbol === 16 ? reader.read(2) + 3 : symbol === 17 ? reader.read(3) + 3 : reader.read(7) + 11;
      for (let i = 0; i < count; i++) lengths.push(repeated);
    }
    if (lengths.length > literalCount + distanceCount) fail('DEFLATE tree exceeds declared size');
  }
  const literalLengths = lengths.slice(0, literalCount);
  if (!literalLengths[256]) fail('DEFLATE stream has no end symbol');
  return [makeHuffman(literalLengths), makeHuffman(lengths.slice(literalCount))];
}

function inflateRaw(input, expectedSize) {
  const reader = new BitReader(input);
  const output = new Uint8Array(expectedSize);
  let position = 0;
  let finalBlock = 0;
  do {
    finalBlock = reader.read(1);
    const type = reader.read(2);
    if (type === 0) {
      reader.alignByte();
      if (reader.position + 4 > input.length) fail('truncated stored DEFLATE block');
      const length = input[reader.position] | (input[reader.position + 1] << 8);
      const complement = input[reader.position + 2] | (input[reader.position + 3] << 8);
      reader.position += 4;
      if ((length ^ complement) !== 0xffff) fail('invalid stored DEFLATE block length');
      if (reader.position + length > input.length || position + length > output.length) fail('stored DEFLATE block exceeds bounds');
      output.set(input.subarray(reader.position, reader.position + length), position);
      reader.position += length;
      position += length;
      continue;
    }
    if (type === 3) fail('reserved DEFLATE block type');
    const [literalTree, distanceTree] = type === 1
      ? [FIXED_LITERAL_TREE, FIXED_DISTANCE_TREE]
      : dynamicTrees(reader);
    while (true) {
      const symbol = reader.symbol(literalTree);
      if (symbol < 256) {
        if (position >= output.length) fail('DEFLATE output exceeds declared size');
        output[position++] = symbol;
      } else if (symbol === 256) {
        break;
      } else {
        const lengthIndex = symbol - 257;
        if (lengthIndex < 0 || lengthIndex >= LENGTH_BASE.length) fail('invalid DEFLATE length code');
        const length = LENGTH_BASE[lengthIndex] + reader.read(LENGTH_EXTRA[lengthIndex]);
        const distanceSymbol = reader.symbol(distanceTree);
        if (distanceSymbol >= DIST_BASE.length) fail('invalid DEFLATE distance code');
        const distance = DIST_BASE[distanceSymbol] + reader.read(DIST_EXTRA[distanceSymbol]);
        if (distance > position || position + length > output.length) fail('DEFLATE back reference exceeds bounds');
        for (let i = 0; i < length; i++) {
          output[position] = output[position - distance];
          position++;
        }
      }
    }
  } while (!finalBlock);
  if (position !== output.length) fail('DEFLATE output size mismatch');
  return output;
}

/**
 * Read safe ZIP entries into a Map<path, Uint8Array>. Accepts a File, Blob,
 * ArrayBuffer, or Uint8Array. ZIP64, encryption, and multi-disk archives fail
 * explicitly. The size limits bound memory use on iPhones.
 */
export async function readZipEntries(input, limits = ZIP_LIMITS) {
  if (Number.isFinite(input?.size) && input.size > limits.archiveBytes) {
    fail('archive exceeds size limit');
  }
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer
    ? new Uint8Array(input) : new Uint8Array(await input.arrayBuffer());
  if (bytes.length > limits.archiveBytes) fail('archive exceeds size limit');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (uint32(view, offset) === 0x06054b50 && offset + 22 + uint16(view, offset + 20) === bytes.length) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) fail('end-of-central-directory record missing');
  const count = uint16(view, endOffset + 10);
  const centralBytes = uint32(view, endOffset + 12);
  const centralOffset = uint32(view, endOffset + 16);
  if (uint16(view, endOffset + 4) !== 0 || uint16(view, endOffset + 6) !== 0 ||
      uint16(view, endOffset + 8) !== count) fail('multi-disk archive is unsupported');
  if (count === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) fail('ZIP64 is unsupported');
  if (count > limits.entries) fail('too many entries');
  if (centralOffset + centralBytes > endOffset) fail('central directory exceeds archive');
  const entries = new Map();
  let offset = centralOffset;
  let totalBytes = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > endOffset || uint32(view, offset) !== 0x02014b50) fail('invalid central directory');
    const flags = uint16(view, offset + 8);
    const method = uint16(view, offset + 10);
    const checksum = uint32(view, offset + 16);
    const compressedSize = uint32(view, offset + 20);
    const size = uint32(view, offset + 24);
    const nameLength = uint16(view, offset + 28);
    const extraLength = uint16(view, offset + 30);
    const commentLength = uint16(view, offset + 32);
    const localOffset = uint32(view, offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > endOffset) fail('truncated central directory entry');
    let name;
    try { name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)); }
    catch { fail('entry name is not UTF-8'); }
    checkedPath(name);
    offset = next;
    if (name.endsWith('/')) continue;
    if (entries.has(name)) fail(`duplicate entry ${name}`);
    if ((flags & 1) || (flags & 0x40)) fail('encrypted entries are unsupported');
    if (method !== 0 && method !== 8) fail(`compression method ${method} is unsupported`);
    if (size > limits.entryBytes || (totalBytes += size) > limits.totalBytes) fail('uncompressed size limit exceeded');
    if (size > 1024 * 1024 && compressedSize * 400 < size) fail('compression ratio limit exceeded');
    if (localOffset + 30 > centralOffset || uint32(view, localOffset) !== 0x04034b50) fail('invalid local ZIP header');
    if (uint16(view, localOffset + 8) !== method) fail('local ZIP method mismatch');
    const localNameLength = uint16(view, localOffset + 26);
    const localExtraLength = uint16(view, localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (start + compressedSize > centralOffset) fail('entry data exceeds archive');
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (localName.length !== nameLength || !localName.every((byte, index) => byte === bytes[next - commentLength - extraLength - nameLength + index])) {
      fail('local ZIP entry name mismatch');
    }
    const compressed = bytes.subarray(start, start + compressedSize);
    const expanded = method === 0 ? compressed : inflateRaw(compressed, size);
    if (expanded.length !== size || crc32(expanded) !== checksum) fail(`checksum or size mismatch for ${name}`);
    entries.set(name, expanded);
  }
  if (offset !== centralOffset + centralBytes) fail('central directory size mismatch');
  return entries;
}
