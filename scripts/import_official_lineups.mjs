#!/usr/bin/env node
/**
 * Import complete text-only formations from the official sources recorded in
 * data/season.json. No role/equipment artwork is copied into the public build.
 * node scripts/import_official_lineups.mjs [--offline-dir local-packs]
 *   [--catalog data/season.json] [--output data/lineups.json] [--checked-at YYYY-MM-DD]
 * Offline files: upstream-{lineups,chess,equip}.json.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog } from '../src/catalog.mjs';
import { validateLineupCatalog } from '../src/lineups.mjs';

function assert(condition, message) { if (!condition) throw new Error(`Official lineup import: ${message}`); }

/** Official guide fields are plain text; discard any feed markup before storing. */
export function plainOfficialText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_, entity) => ({
      nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    })[entity.toLowerCase()])
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (all, hex, decimal) => {
      const code = parseInt(hex ?? decimal, hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : all;
    })
    .replace(/\r\n?/g, '\n').trim();
}

function position(value, label) {
  if (value === undefined || value === '') return null;
  const match = /^([1-4]),([1-7])$/.exec(String(value));
  assert(match, `invalid formation position for ${label}: ${value}`);
  return { row: Number(match[1]), column: Number(match[2]) };
}

/** Preserve official formation slots, including repeated special/summoned units. */
export function buildOfficialLineupCatalog({ catalog, lineups, chess, equip, checkedAt }) {
  validateCatalog(catalog);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(checkedAt), 'checkedAt must be YYYY-MM-DD');
  for (const [name, payload] of Object.entries({ chess, equip })) {
    assert(payload.version === catalog.patch && payload.season?.toLowerCase() === catalog.seasonId && String(payload.setId) === '18',
      `${name} data does not match the active hero catalog`);
    assert(payload.data && typeof payload.data === 'object', `${name} data is missing`);
  }
  assert(Array.isArray(lineups?.lineup_list), 'lineup feed has no lineup_list');
  const sourceIds = ['lineups', 'heroes', 'equipment'];
  const sources = sourceIds.map(sourceId => {
    const source = catalog.sources.find(entry => entry.id === sourceId);
    assert(source, `missing ${sourceId} source in catalog`);
    return { ...source, checkedAt };
  });
  const baseIds = new Set(catalog.heroes.map(hero => hero.id));
  const current = lineups.lineup_list.filter(row => row.simulator_edition === catalog.patch &&
    row.simulator_season?.toLowerCase() === catalog.seasonId && row.mode === '18' && row.status === '5' &&
    ['S', 'A'].includes(row.quality));
  assert(current.length, `no published S/A formations for ${catalog.patch}`);
  current.sort((a, b) => (a.quality === 'S' ? 0 : 1) - (b.quality === 'S' ? 0 : 1) ||
    Number(b.sortID) - Number(a.sortID) || String(a.id).localeCompare(String(b.id)));
  const formations = current.map(row => {
    let detail;
    try { detail = JSON.parse(row.detail); } catch { throw new Error(`Official lineup import: invalid detail JSON for ${row.id}`); }
    assert(detail && typeof detail.line_name === 'string' && detail.line_name.trim(), `missing formation name for ${row.id}`);
    assert(Array.isArray(detail.hero_location) && detail.hero_location.length, `missing formation slots for ${row.id}`);
    const members = detail.hero_location.map((slot, index) => {
      const unitId = String(slot.hero_id);
      const unit = chess.data[unitId];
      assert(unit?.name, `unknown unit ${unitId} in formation ${row.id}`);
      assert(['hero', 'pet'].includes(slot.chess_type), `unknown unit type ${slot.chess_type} in ${row.id}`);
      const cost = Number(unit.price);
      assert(Number.isInteger(cost) && cost >= 0 && cost <= 10, `invalid cost for ${unitId}`);
      const items = String(slot.equipment_id ?? '').split(',').filter(Boolean).map(itemId => {
        const item = equip.data[itemId];
        assert(item?.name, `unknown equipment ${itemId} in formation ${row.id}`);
        return { id: itemId, name: plainOfficialText(item.name) };
      });
      return {
        unitId, heroId: baseIds.has(`hero-${unitId}`) ? `hero-${unitId}` : null,
        name: plainOfficialText(unit.name), cost, kind: slot.chess_type,
        isCarry: slot.is_carry_hero === true,
        position: position(slot.location, `${row.id}/${index}`), items,
      };
    });
    return {
      id: `official-${row.id}`, officialId: String(row.id), name: plainOfficialText(detail.line_name),
      quality: row.quality, sortOrder: Number(row.sortID), author: plainOfficialText(row.lineupauthor_data?.name),
      sourceIds: [...sourceIds], members,
      guide: {
        early: plainOfficialText(detail.early_info), reroll: plainOfficialText(detail.d_time),
        position: plainOfficialText(detail.location_info), matchups: plainOfficialText(detail.enemy_info),
        equipment: plainOfficialText(detail.equipment_info), augments: plainOfficialText(detail.hex_info),
        adventure: plainOfficialText(detail.adventure_info),
      },
    };
  });
  return validateLineupCatalog({
    schemaVersion: 1, seasonId: catalog.seasonId, seasonName: catalog.seasonName,
    patch: catalog.patch, updatedAt: checkedAt, status: 'verified', sources, lineups: formations,
  }, { catalog });
}

async function main() {
  const options = { catalog: 'data/season.json', output: 'data/lineups.json', checkedAt: new Date().toISOString().slice(0, 10) };
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    assert(value && ['--offline-dir', '--catalog', '--output', '--checked-at'].includes(key), `unknown or incomplete option ${key}`);
    options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  const catalog = validateCatalog(JSON.parse(await readFile(resolve(options.catalog), 'utf8')));
  const offline = options.offlineDir && resolve(options.offlineDir);
  const payloads = await Promise.all([['lineups', 'lineups'], ['chess', 'heroes'], ['equip', 'equipment']].map(async ([name, sourceId]) => {
    if (offline) return JSON.parse(await readFile(join(offline, `upstream-${name}.json`), 'utf8'));
    const source = catalog.sources.find(entry => entry.id === sourceId);
    assert(source && /^https:\/\/game\.gtimg\.cn\/images\/lol\/act\/jkzlk(?:auto)?\//.test(source.url), `unexpected official source for ${name}`);
    const response = await fetch(source.url);
    assert(response.ok, `download failed for ${name} (${response.status})`);
    return response.json();
  }));
  const [lineups, chess, equip] = payloads;
  const data = buildOfficialLineupCatalog({ catalog, lineups, chess, equip, checkedAt: options.checkedAt });
  await writeFile(resolve(options.output), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${data.lineups.length} official formations for ${data.seasonId} ${data.patch}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
