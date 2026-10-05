import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildOfficialLineupCatalog, plainOfficialText } from '../scripts/import_official_lineups.mjs';
import { validateLineupCatalog, loadLineups } from '../src/lineups.mjs';

const catalog = JSON.parse(await readFile(new URL('../data/season.json', import.meta.url), 'utf8'));
const unitId = catalog.heroes[0].id.slice('hero-'.length);
const basicUnit = catalog.heroes[0];

function fixture() {
  const slot = (hero_id, location, kind = 'hero', equipment_id = '') => ({
    hero_id, location, chess_type: kind, equipment_id, is_carry_hero: kind === 'hero',
  });
  const row = (id, quality, sortID, patch = catalog.patch) => ({
    id, quality, sortID, status: '5', mode: '18', simulator_edition: patch,
    simulator_season: catalog.seasonId.toUpperCase(),
    lineupauthor_data: { name: '官方推荐作者' },
    detail: JSON.stringify({
      line_name: `阵容 ${id}`, early_info: '<p>先存经济<br>再升人口</p>',
      location_info: '主坦与主 C 同侧。',
      hero_location: [slot(unitId, '1,3', 'hero', '2001,2001'),
        slot('18704', '1,1', 'pet'), slot('18704', '1,7', 'pet')],
    }),
  });
  return {
    catalog, checkedAt: '2026-10-05',
    chess: { version: catalog.patch, season: catalog.seasonId.toUpperCase(), setId: '18',
      data: { [unitId]: { name: basicUnit.name, price: String(basicUnit.cost), picture: 'https://example.com/private.png' },
        18704: { name: '石皮树', price: '0', picture: 'https://example.com/summon.png' } } },
    equip: { version: catalog.patch, season: catalog.seasonId.toUpperCase(), setId: '18',
      data: { 2001: { name: '样例装备', picture: 'https://example.com/equip.png' } } },
    lineups: { lineup_list: [row('1', 'A', '999'), row('2', 'S', '12'), row('3', 'S', '10'),
      row('4', 'S', '9999', 'old-patch'), { ...row('5', 'S', '1'), mode: '1' },
      { ...row('6', 'S', '1'), status: '0' }, row('7', 'B', '1')] },
  };
}

test('official conversion keeps complete slots, summon duplicates, exact equipment, and source ordering', () => {
  const data = buildOfficialLineupCatalog(fixture());
  assert.deepEqual(data.lineups.map(lineup => lineup.officialId), ['2', '3', '1']);
  const lineup = data.lineups[0];
  assert.equal(lineup.members.length, 3);
  assert.deepEqual(lineup.members[0].items.map(item => item.id), ['2001', '2001']);
  assert.equal(lineup.members[0].heroId, basicUnit.id);
  assert.equal(lineup.members[0].isCarry, true);
  assert.deepEqual(lineup.members.slice(1).map(unit => [unit.unitId, unit.heroId, unit.name]),
    [['18704', null, '石皮树'], ['18704', null, '石皮树']]);
  assert.deepEqual(lineup.members[2].position, { row: 1, column: 7 });
  assert.equal(lineup.guide.early, '先存经济\n再升人口');
  assert.equal(lineup.guide.reroll, '');
  assert.ok(data.sources.every(source => source.checkedAt === '2026-10-05'));
  assert.doesNotMatch(JSON.stringify(data), /picture|private\.png|summon\.png|equip\.png|winrate|popularity/);
});

test('official conversion fails when source versions, names, or equipment cannot be verified', () => {
  const oldVersion = fixture();
  oldVersion.equip.version = 'old-patch';
  assert.throws(() => buildOfficialLineupCatalog(oldVersion), /equip data does not match/);
  const missingUnit = fixture();
  delete missingUnit.chess.data['18704'];
  assert.throws(() => buildOfficialLineupCatalog(missingUnit), /unknown unit 18704/);
  const missingItem = fixture();
  delete missingItem.equip.data['2001'];
  assert.throws(() => buildOfficialLineupCatalog(missingItem), /unknown equipment 2001/);
});

test('lineup validation rejects stale recommendations, malformed positions, and mismatched hero identities', () => {
  const valid = buildOfficialLineupCatalog(fixture());
  assert.throws(() => validateLineupCatalog(valid, { catalog: { ...catalog, patch: 'old-patch' } }), /must match/);
  const badPosition = structuredClone(valid);
  badPosition.lineups[0].members[0].position.column = 8;
  assert.throws(() => validateLineupCatalog(badPosition), /4 by 7/);
  const badName = structuredClone(valid);
  badName.lineups[0].members[0].name = '另一名角色';
  assert.throws(() => validateLineupCatalog(badName, { catalog }), /does not match the active/);
});

test('published complete lineup dataset matches the roster version and has sourced guides without artwork', async () => {
  const data = validateLineupCatalog(JSON.parse(await readFile(new URL('../data/lineups.json', import.meta.url), 'utf8')), { catalog });
  assert.equal(data.lineups.length, 59);
  assert.equal(data.lineups.filter(lineup => lineup.quality === 'S').length, 22);
  assert.equal(data.lineups.filter(lineup => lineup.quality === 'A').length, 37);
  assert.ok(data.lineups.some(lineup => lineup.members.some(member => member.kind === 'pet' && member.name === '石皮树')));
  assert.ok(data.lineups.every(lineup => lineup.members.length >= 7 && lineup.guide.position));
  assert.ok(data.lineups.flatMap(lineup => lineup.members).some(member => member.items.length === 3));
  assert.doesNotMatch(JSON.stringify(data), /"(?:picture|heroPaint|imgUrl|winrate|popularity)"/);
});

test('lineup loader enforces active patch compatibility and reports failed requests', async () => {
  const originalFetch = globalThis.fetch;
  const valid = buildOfficialLineupCatalog(fixture());
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => valid });
    assert.equal((await loadLineups(catalog)).lineups.length, 3);
    await assert.rejects(loadLineups({ ...catalog, patch: 'old-patch' }), /must match/);
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(loadLineups(catalog), /404/);
  } finally { globalThis.fetch = originalFetch; }
});

test('official guide markup is converted to text without losing Chinese or escaped symbols', () => {
  assert.equal(plainOfficialText('<p>主 C &amp; 前排<br/>&#x9635;&#23481;</p>'), '主 C & 前排\n阵容');
});

test('lineup loader aborts a stalled request instead of leaving guides loading forever', async t => {
  const originalFetch = globalThis.fetch;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const rejected = assert.rejects(loadLineups(catalog), { name: 'AbortError' });
    t.mock.timers.tick(10000);
    await rejected;
  } finally { globalThis.fetch = originalFetch; }
});
