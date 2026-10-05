#!/usr/bin/env node
/**
 * Synthetic fixture only; none of these names, images, or values are game data.
 * Usage: node scripts/make_test_pack.mjs [output-directory]
 * Produces a ZIP for the app's local asset import and four PNGs that can be
 * selected as scan inputs during browser testing.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { zip } from '../tests/fixtures.mjs';

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const name = new TextEncoder().encode(type);
  const result = new Uint8Array(12 + data.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(name, 4);
  result.set(data, 8);
  view.setUint32(8 + data.length, crc32(result.subarray(4, 8 + data.length)));
  return result;
}

function image(hero, variant) {
  const width = variant === 'card' ? 320 : 480;
  const height = variant === 'card' ? 320 : 320;
  const pixels = new Uint8Array(height * (1 + width * 4));
  const cool = hero === 'blue';
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    pixels[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 4;
      const grid = (Math.floor(x / 20) + Math.floor(y / 20)) % 2;
      const diagonal = cool ? Math.abs(x - y * width / height) < 13 : Math.abs(x + y * width / height - width) < 13;
      const ring = Math.abs(Math.hypot(x - width * 0.5, y - height * 0.5) - Math.min(width, height) * 0.28) < 10;
      const star = ((x * 17 + y * 31 + (cool ? 3 : 11)) % 97) < 4;
      const border = x < 12 || y < 12 || x >= width - 12 || y >= height - 12;
      const bright = diagonal || ring || star || border;
      pixels[p] = cool ? (bright ? 255 : 20 + grid * 20) : (bright ? 255 : 25 + grid * 16);
      pixels[p + 1] = cool ? (bright ? 235 : 45 + grid * 30) : (bright ? 215 : 110 + grid * 24);
      pixels[p + 2] = cool ? (bright ? 60 : 145 + grid * 30) : (bright ? 65 : 50 + grid * 10);
      pixels[p + 3] = 255;
    }
  }
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const body = [signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', new Uint8Array())];
  return Uint8Array.from(body.flatMap((part) => [...part]));
}

const catalog = {
  schemaVersion: 1,
  seasonId: 'synthetic-test-only',
  seasonName: '合成测试赛季（非游戏资料）',
  patch: 'test-0',
  updatedAt: '2026-09-25',
  status: 'unverified',
  sources: [],
  heroes: [
    { id: 'synthetic-blue', name: '合成蓝星（测试）', cost: 1, traits: ['合成测试'],
      skill: { name: '蓝色测试', description: '仅用于本地识别流程测试。' },
      stats: { health: 500, attackDamage: 40 },
      recommendations: { patch: 'test-0', items: [], comps: [], sourceIds: [] },
      variants: [{ id: 'card', kind: 'card' }, { id: 'splash', kind: 'splash' }] },
    { id: 'synthetic-amber', name: '合成橙影（测试）', cost: 2, traits: ['合成测试'],
      skill: { name: '橙色测试', description: '仅用于本地识别流程测试。' },
      stats: { health: 600, attackDamage: 55 },
      recommendations: { patch: 'test-0', items: [], comps: [], sourceIds: [] },
      variants: [{ id: 'card', kind: 'card' }, { id: 'splash', kind: 'splash' }] },
  ],
};

const output = resolve(process.argv[2] ?? 'tests/fixtures/generated');
await mkdir(output, { recursive: true });
const references = [];
const zipEntries = [];
for (const [heroId, color] of [['synthetic-blue', 'blue'], ['synthetic-amber', 'amber']]) {
  for (const variantId of ['card', 'splash']) {
    const filename = `${heroId}-${variantId}.png`;
    const png = image(color, variantId);
    await writeFile(join(output, filename), png);
    const path = `images/${filename}`;
    references.push({ heroId, variantId, path });
    zipEntries.push([path, png]);
  }
}
const manifest = { schemaVersion: 1, seasonId: catalog.seasonId, patch: catalog.patch, catalog, references };
zipEntries.unshift(['manifest.json', JSON.stringify(manifest)]);
const packPath = join(output, 'synthetic-test-pack.zip');
await writeFile(packPath, zip(zipEntries));
process.stdout.write(`Synthetic test pack: ${packPath}\n`);
