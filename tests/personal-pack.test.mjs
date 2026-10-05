import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePersonalS19Pack, safeOutputPath } from '../scripts/make_personal_s19_pack.mjs';
import { parseAssetPack } from '../src/catalog.mjs';
import { readZipEntries } from '../src/zip.mjs';

const CONFIG = 'https://jcc.qq.com/data-js/basicConfig.js';
const VERSIONS = 'https://game.gtimg.cn/images/lol/act/jkzlk/js/config/versiondataconfig.js';
const CHESS = 'https://game.gtimg.cn/images/lol/act/jkzlk/js/18/18.18.3-S19/chess.js';
const BIG = 'https://game.gtimg.cn/images/jk/jkimg/mode18s19/1624x750/';
const SMALL = 'https://game.gtimg.cn/images/lol/act/jkzlk/mode18s19/hero/';
const PNG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13,
  73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1);
const JPEG = Uint8Array.of(255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(patch = '18.18.3') {
  const heroes = [];
  const chessData = {};
  for (let index = 0; index < 65; index++) {
    const numericId = String(10000 + index);
    const id = `hero-${numericId}`;
    const name = `合成角色${index}`;
    heroes.push({ id, name, cost: 1, traits: ['合成羁绊'], skill: { name: '合成技能', description: '测试专用。' },
      stats: { health: 500 }, recommendations: { patch, items: [], comps: [], sourceIds: [] },
      variants: [{ id: 'card', kind: 'card' }, { id: 'splash', kind: 'splash' }] });
    chessData[numericId] = { id: numericId, name, price: '1', showHeroTag: '1',
      picture: `${SMALL}test_${numericId}.png`, heroPaint: `test_${numericId}` };
  }
  const catalog = { schemaVersion: 1, seasonId: 's19', seasonName: '合成测试', patch,
    updatedAt: '2026-10-04', status: 'verified', sources: [
      { id: 'current-season', title: '测试配置', url: CONFIG, checkedAt: '2026-10-04' },
      { id: 'version', title: '测试版本', url: VERSIONS, checkedAt: '2026-10-04' },
      { id: 'heroes', title: '测试角色', url: CHESS, checkedAt: '2026-10-04' },
    ], heroes };
  const data = new Map([
    [CONFIG, ['var mode = "18";\nvar season = "S19";\nhero_pic_big:{"18_S19":"//game.gtimg.cn/images/jk/jkimg/mode18s19/1624x750/{{pic_name}}.jpg"}', 'text/javascript']],
    [VERSIONS, [JSON.stringify([{ mode: '18', season: 'S19', is_newest_version: 1, version: '18.18.3', herourl: '/18/18.18.3-S19/chess.js' }]), 'application/json']],
    [CHESS, [JSON.stringify({ version: '18.18.3', season: 'S19', setId: '18', data: chessData }), 'application/json']],
  ]);
  for (const hero of Object.values(chessData)) {
    data.set(hero.picture, [PNG, 'image/png']);
    data.set(`${BIG}${hero.heroPaint}.jpg`, [JPEG, 'image/jpeg']);
  }
  let artRequests = 0;
  const fetchImpl = async (url) => {
    if (url.startsWith(SMALL) || url.startsWith(BIG)) artRequests++;
    const item = data.get(url);
    return item ? new Response(item[0], { status: 200, headers: { 'content-type': item[1] } })
      : new Response('missing', { status: 404 });
  };
  return { catalog, data, fetchImpl, get artRequests() { return artRequests; } };
}

test('personal builder produces a locally importable 65-hero, 130-image ZIP with source hashes', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'jcc-personal-pack-'));
  try {
    const outputPath = join(temporary, 'personal.zip');
    const upstream = fixture();
    const result = await makePersonalS19Pack({ catalog: upstream.catalog, outputPath, fetchImpl: upstream.fetchImpl });
    assert.equal(result.heroes, 65);
    assert.equal(result.references, 130);
    assert.equal(upstream.artRequests, 130);
    const bytes = await readFile(outputPath);
    const entries = await readZipEntries(bytes);
    const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));
    assert.equal(manifest.patch, '18.18.3');
    assert.equal(manifest.references.length, 130);
    assert.match(manifest.references[0].sourceUrl, /^https:\/\/game\.gtimg\.cn\//);
    assert.match(manifest.references[0].sha256, /^[0-9a-f]{64}$/);
    const parsed = await parseAssetPack(new Blob([bytes]));
    assert.equal(parsed.records.length, 130);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('stale catalog aborts before art is downloaded or a file is written', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'jcc-stale-pack-'));
  try {
    const outputPath = join(temporary, 'stale.zip');
    const upstream = fixture('18.18.2a');
    await assert.rejects(makePersonalS19Pack({ catalog: upstream.catalog, outputPath, fetchImpl: upstream.fetchImpl }), /catalog patch .* is stale/);
    assert.equal(upstream.artRequests, 0);
    await assert.rejects(stat(outputPath), { code: 'ENOENT' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('wrong upstream image type aborts without writing the ZIP', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'jcc-bad-art-'));
  try {
    const outputPath = join(temporary, 'bad.zip');
    const upstream = fixture();
    upstream.data.set(`${SMALL}test_10000.png`, [JPEG, 'image/jpeg']);
    await assert.rejects(makePersonalS19Pack({ catalog: upstream.catalog, outputPath, fetchImpl: upstream.fetchImpl }), /wrong image type/);
    await assert.rejects(stat(outputPath), { code: 'ENOENT' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('output path accepts private local-packs but rejects public directories', () => {
  assert.equal(safeOutputPath(join(projectRoot, 'local-packs', 's19.zip')),
    join(projectRoot, 'local-packs', 's19.zip'));
  assert.throws(() => safeOutputPath(join(projectRoot, 'assets', 's19.zip')), /under local-packs/);
  assert.throws(() => safeOutputPath(join(projectRoot, 'dist', 's19.zip')), /under local-packs/);
  assert.throws(() => safeOutputPath(join(projectRoot, '..private', 's19.zip')), /under local-packs/);
});
