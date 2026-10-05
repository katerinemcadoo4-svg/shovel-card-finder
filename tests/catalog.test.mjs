import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateCatalog, parseAssetPack, loadCatalog, getReferences } from '../src/catalog.mjs';
import { buildOfficialRecommendations } from '../scripts/import_official_s19.mjs';
import { zip } from './fixtures.mjs';

const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 0, 73, 69, 78, 68,
]);

const catalog = {
  schemaVersion: 1,
  seasonId: 'sample-season',
  seasonName: '样例赛季',
  patch: '1.0',
  updatedAt: '2026-09-25',
  status: 'user-provided',
  sources: [{ id: 'sample', title: '样例来源', url: 'https://example.com/season', checkedAt: '2026-09-25' }],
  heroes: [{
    id: 'sample-hero', name: '样例英雄', cost: 1, traits: ['样例羁绊'],
    skill: { name: '样例技能', description: '样例描述' },
    stats: { health: 500, mana: '0/60' },
    recommendations: { patch: '1.0', items: [{ name: '样例装备', reason: '示例' }],
      comps: [{ name: '样例阵容' }], sourceIds: ['sample'] },
    variants: [{ id: 'card', kind: 'card' }, { id: 'splash', kind: 'splash' }],
  }],
};

function pack(overrides = {}) {
  const manifest = { schemaVersion: 1, seasonId: 'sample-season', patch: '1.0', catalog,
    references: [{ heroId: 'sample-hero', variantId: 'card', path: 'images/card.png' }], ...overrides };
  return zip([['manifest.json', JSON.stringify(manifest)], ['images/card.png', PNG]]);
}

test('built-in catalog has sourced current-patch guides without bundled art', async () => {
  const builtIn = validateCatalog(JSON.parse(await readFile(new URL('../data/season.json', import.meta.url))));
  assert.equal(builtIn.status, 'verified');
  assert.equal(builtIn.seasonId, 's19');
  assert.equal(builtIn.patch, '18.18.3');
  assert.equal(builtIn.seasonName, '自然之力');
  assert.equal(builtIn.heroes.length, 65);
  assert.equal(new Set(builtIn.heroes.map((hero) => hero.id)).size, 65);
  assert.deepEqual([1, 2, 3, 4, 5].map((cost) => builtIn.heroes.filter((hero) => hero.cost === cost).length), [14, 13, 14, 14, 10]);
  assert.ok(builtIn.sources.some((source) => source.url.endsWith('/18/18.18.3-S19/chess.js')));
  assert.ok(builtIn.sources.some((source) => source.id === 'lineups' && source.url.endsWith('/m19/11/18/lineup_detail_total.json')));
  assert.ok(builtIn.sources.some((source) => source.id === 'equipment' && source.url.endsWith('/18/18.18.3-S19/equip.js')));
  assert.ok(builtIn.heroes.every((hero) => hero.traits.length && hero.skill.name && hero.skill.description &&
    hero.stats.health > 0 && hero.stats.mana.includes('/') &&
    hero.variants.length === 2 && hero.variants.every((variant) => !variant.url) &&
    hero.recommendations.patch === builtIn.patch && hero.recommendations.comps.length <= 3 &&
    hero.recommendations.items.length <= 3 && hero.recommendations.items.every((item) => item.reason.includes('阵容配装'))));
  assert.equal(builtIn.heroes.filter((hero) => hero.recommendations.comps.length).length, 64);
  assert.equal(builtIn.heroes.filter((hero) => hero.recommendations.items.length).length, 49);
  assert.ok(builtIn.heroes.filter((hero) => hero.recommendations.items.length).every((hero) =>
    hero.recommendations.sourceIds.includes('lineups') && hero.recommendations.sourceIds.includes('equipment')));
  assert.deepEqual(builtIn.heroes.find((hero) => hero.name === '拉克丝').recommendations.items, []);
});

test('official guides select one named S-tier equipment set and at most three current-patch lineups', () => {
  const heroes = ['hero-100', 'hero-101'].map((id) => ({ id, recommendations: {
    patch: '18.18.3', items: [], comps: [], sourceIds: [],
  } }));
  const slot = (hero_id, equipment_id = '') => ({ chess_type: 'hero', hero_id, equipment_id });
  const row = (id, quality, patch, members, name) => ({ id, quality, status: '5', mode: '18',
    simulator_season: 'S19', simulator_edition: patch, sortID: String(id),
    detail: JSON.stringify({ line_name: name, hero_location: members }),
  });
  const lineups = { lineup_list: [
    row(1, 'A', '18.18.3', [slot('100', '2')], 'A 阵容'),
    row(2, 'S', '18.18.3', [slot('100', '1'), slot('999', '1')], 'S 阵容'),
    row(3, 'S', '18.18.2a', [slot('100', '2')], '过期阵容'),
    row(4, 'A', '18.18.3', [slot('100')], 'A 阵容二'),
    row(5, 'A', '18.18.3', [slot('100')], 'A 阵容三'),
  ] };
  buildOfficialRecommendations({ heroes, lineups, equip: { data: { 1: { name: 'S 装备' }, 2: { name: 'A 装备' } } },
    patch: '18.18.3', season: 'S19', mode: '18' });
  assert.deepEqual(heroes[0].recommendations.comps.map((comp) => comp.name), ['S 阵容', 'A 阵容三', 'A 阵容二']);
  assert.deepEqual(heroes[0].recommendations.items, [{ name: 'S 装备', reason: '「S 阵容」阵容配装' }]);
  assert.deepEqual(heroes[0].recommendations.sourceIds, ['lineups', 'equipment']);
  assert.deepEqual(heroes[1].recommendations, { patch: '18.18.3', items: [], comps: [], sourceIds: [] });
});

test('validates catalog sources, IDs, and recommendation patch', () => {
  assert.equal(validateCatalog(catalog), catalog);
  assert.throws(() => validateCatalog({ ...catalog, heroes: [{ ...catalog.heroes[0],
    recommendations: { ...catalog.heroes[0].recommendations, patch: 'old' } }] }), /recommendations.patch/);
  assert.throws(() => validateCatalog({ ...catalog, heroes: [catalog.heroes[0], catalog.heroes[0]] }), /duplicate IDs/);
  assert.throws(() => validateCatalog({ ...catalog, sources: [] }), /sources/);
  assert.throws(() => validateCatalog({ ...catalog, heroes: [{ ...catalog.heroes[0],
    variants: [{ id: 'card', kind: 'card', url: '  https://example.com/collect.png' }] }] }), /same-origin/);
});

test('parses ZIP with embedded catalog and checked image identity', async () => {
  const parsed = await parseAssetPack(pack());
  assert.equal(parsed.catalog.heroes[0].name, '样例英雄');
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].blob.type, 'image/png');
  assert.deepEqual([parsed.records[0].heroId, parsed.records[0].variantId], ['sample-hero', 'card']);
});

test('supports a matching external catalog and rejects mismatches', async () => {
  const manifest = { schemaVersion: 1, seasonId: 'sample-season', patch: '1.0',
    references: [{ heroId: 'sample-hero', variantId: 'card', path: 'images/card.png' }] };
  const archive = zip([['manifest.json', JSON.stringify(manifest)], ['images/card.png', PNG]]);
  assert.equal((await parseAssetPack(archive, { catalog })).catalog, catalog);
  await assert.rejects(parseAssetPack(archive), /Invalid catalog/);
  await assert.rejects(parseAssetPack(pack({ patch: '2.0' })), /must match/);
  await assert.rejects(parseAssetPack(pack({ references: [{ heroId: 'other', variantId: 'card', path: 'images/card.png' }] })), /Unknown hero/);
});

test('rejects disguised files and missing images', async () => {
  const wrongImage = zip([['manifest.json', JSON.stringify({ schemaVersion: 1, seasonId: 'sample-season', patch: '1.0', catalog,
    references: [{ heroId: 'sample-hero', variantId: 'card', path: 'images/card.png' }] })], ['images/card.png', 'not an image']]);
  await assert.rejects(parseAssetPack(wrongImage), /must be a PNG/);
  await assert.rejects(parseAssetPack(pack({ references: [{ heroId: 'sample-hero', variantId: 'card', path: 'missing.png' }] })), /Missing image/);
});

test('loadCatalog fetches built-in JSON when no pack is installed', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => catalog });
  try { assert.equal(await loadCatalog(), catalog); }
  finally { globalThis.fetch = previous; }
});

test('bundled atlas remains readable when browser storage cannot open', async () => {
  const previousFetch = globalThis.fetch;
  const previousIndexedDb = globalThis.indexedDB;
  globalThis.indexedDB = { open() { throw new Error('storage unavailable'); } };
  globalThis.fetch = async () => ({ ok: true, json: async () => catalog });
  try {
    assert.equal(await loadCatalog(), catalog);
    assert.deepEqual(await getReferences(catalog), []);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousIndexedDb === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previousIndexedDb;
  }
});
