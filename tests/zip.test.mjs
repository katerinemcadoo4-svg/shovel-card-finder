import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:zlib';
import { readZipEntries } from '../src/zip.mjs';
import { zip } from './fixtures.mjs';

test('reads stored and DEFLATE entries, including repeated back references', async () => {
  const text = 'golden-spatula '.repeat(800);
  const entries = await readZipEntries(zip([
    ['manifest.json', '{"schemaVersion":1}', 0],
    ['images/card.png', text, 8],
    ['fixed.txt', text, 8, { strategy: constants.Z_FIXED }],
    ['stored-block.txt', text, 8, { level: 0 }],
  ]));
  assert.equal(new TextDecoder().decode(entries.get('manifest.json')), '{"schemaVersion":1}');
  assert.equal(new TextDecoder().decode(entries.get('images/card.png')), text);
  assert.equal(new TextDecoder().decode(entries.get('fixed.txt')), text);
  assert.equal(new TextDecoder().decode(entries.get('stored-block.txt')), text);
});

test('rejects traversal and duplicate entry names', async () => {
  await assert.rejects(readZipEntries(zip([['../escape.png', 'x']])), /unsafe entry path/);
  await assert.rejects(readZipEntries(zip([['a.png', 'x'], ['a.png', 'y']])), /duplicate entry/);
});

test('rejects corrupt data and unsupported compression', async () => {
  const archive = zip([['a.txt', 'safe', 0]]);
  archive[35] ^= 1;
  await assert.rejects(readZipEntries(archive), /checksum/);
  const unsupported = zip([['a.txt', 'safe', 0]]);
  new DataView(unsupported.buffer).setUint16(8, 12, true);
  await assert.rejects(readZipEntries(unsupported), /method mismatch|unsupported/);
});

test('enforces entry-size limit before inflation', async () => {
  const archive = zip([['large.txt', 'A'.repeat(100)]]);
  await assert.rejects(readZipEntries(archive, { archiveBytes: 1000, entries: 5, entryBytes: 50, totalBytes: 50 }), /size limit/);
});

test('rejects an oversized File before reading its bytes', async () => {
  let read = false;
  const oversized = { size: 81 * 1024 * 1024, async arrayBuffer() { read = true; return new ArrayBuffer(0); } };
  await assert.rejects(readZipEntries(oversized), /archive exceeds size limit/);
  assert.equal(read, false);
});
