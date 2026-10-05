#!/usr/bin/env node
/**
 * Rebuild the S19 catalog from Tencent's public game-data JSON.
 * Usage: node scripts/import_official_s19.mjs [--offline-dir data] [--output data/season.json] [--checked-at YYYY-MM-DD]
 * Default mode fetches the official URLs. --offline-dir reads temporary files
 * named upstream-basic-config.js and
 * upstream-{versions,chess,race,job,equip,lineups}.json.
 * Art is deliberately not downloaded or redistributed by this script.
 * The current S19 patch is read from the official version list each run.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog } from '../src/catalog.mjs';

const CONFIG_URL = 'https://jcc.qq.com/data-js/basicConfig.js';
const VERSION_URL = 'https://game.gtimg.cn/images/lol/act/jkzlk/js/config/versiondataconfig.js';
const DATA_BASE = 'https://game.gtimg.cn/images/lol/act/jkzlk/js';

function lineupUrlFromConfig(basicConfig) {
  const channel = basicConfig.match(/^\s*var channel\s*=\s*['"]([^'"]+)['"]/m)?.[1];
  const template = basicConfig.match(/['"]18_S19['"]\s*:\s*`([^`]*lineup_detail_total\.json)`/)?.[1];
  assert(channel && template, 'missing current-season lineup feed in site configuration');
  const url = template.replaceAll('${channel}', channel);
  assert(/^https:\/\/game\.gtimg\.cn\/images\/lol\/act\/jkzlkauto\/json\/lineupJson\/m19\/\d+\/18\/lineup_detail_total\.json$/.test(url),
    `unexpected lineup URL ${url}`);
  return url;
}

function assert(condition, message) { if (!condition) throw new Error(`Official S19 import: ${message}`); }
function numeric(value, label) {
  const number = Number(value);
  assert(value !== '' && Number.isFinite(number) && number >= 0, `invalid ${label}: ${value}`);
  return number;
}
function traitNames(value, mapping, label) {
  return (value ?? '').split('|').filter((id) => id && id !== '0' && id !== '-1').map((id) => {
    const trait = mapping[id];
    assert(trait?.name, `unknown ${label} ID ${id}`);
    return trait.name;
  });
}

/** Keep equipment tied to one named official lineup, never a merged best-in-slot set. */
export function buildOfficialRecommendations({ heroes, lineups, equip, patch, season, mode }) {
  assert(Array.isArray(lineups?.lineup_list), 'lineup feed has no lineup_list');
  const current = lineups.lineup_list.filter((row) => row.simulator_edition === patch &&
    row.simulator_season === season && row.mode === mode && row.status === '5' &&
    ['S', 'A'].includes(row.quality));
  assert(current.length > 0, `no published S/A lineups for ${patch}`);
  current.sort((a, b) => (a.quality === 'S' ? 0 : 1) - (b.quality === 'S' ? 0 : 1) ||
    Number(b.sortID) - Number(a.sortID) || String(a.id).localeCompare(String(b.id)));
  const byId = new Map(heroes.map((hero) => [hero.id.slice('hero-'.length), hero]));
  for (const row of current) {
    let detail;
    try { detail = JSON.parse(row.detail); } catch { continue; }
    if (!detail || typeof detail.line_name !== 'string' || !detail.line_name.trim() ||
        !Array.isArray(detail.hero_location)) continue;
    const seen = new Set();
    for (const slot of detail.hero_location) {
      if (slot.chess_type !== 'hero' || seen.has(slot.hero_id)) continue;
      seen.add(slot.hero_id);
      const hero = byId.get(String(slot.hero_id));
      if (!hero) continue; // The feed also includes special units outside the base roster.
      const guide = hero.recommendations;
      if (guide.comps.length >= 3 || guide.comps.some((comp) => comp.name === detail.line_name)) continue;
      guide.comps.push({ name: detail.line_name.trim(), description: `${row.quality} 级 · 官方阵容 #${row.id}` });
      if (!guide.sourceIds.includes('lineups')) guide.sourceIds.push('lineups');
      if (guide.items.length || !slot.equipment_id) continue;
      const ids = String(slot.equipment_id).split(',').filter(Boolean).slice(0, 3);
      const equipment = ids.map((id) => equip.data[id]);
      if (!equipment.length || equipment.some((item) => !item?.name)) continue;
      guide.items = equipment.map((item) => ({ name: item.name, reason: `「${detail.line_name.trim()}」阵容配装` }));
      if (!guide.sourceIds.includes('equipment')) guide.sourceIds.push('equipment');
    }
  }
}

export function buildCatalogFromOfficial({ basicConfig, versions, chess, race, job, equip, lineups, checkedAt }) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(checkedAt), 'checkedAt must be YYYY-MM-DD');
  const mode = basicConfig.match(/^\s*var mode\s*=\s*['"]([^'"]+)['"]/m)?.[1];
  const season = basicConfig.match(/^\s*var season\s*=\s*['"]([^'"]+)['"]/m)?.[1];
  assert(mode === '18' && season === 'S19', `current config is ${mode}/${season}, not 18/S19`);
  assert(Array.isArray(versions), 'version list is not an array');
  const current = versions.filter((entry) => entry.mode === mode && entry.season === season && entry.is_newest_version === 1);
  assert(current.length === 1, `expected one latest ${mode}/${season} version, found ${current.length}`);
  const version = current[0];
  assert(/^18\.\d+(?:\.\d+[a-z]?)?$/.test(version.version) && version.name === '自然之力',
    `unexpected version ${version.version}/${version.name}`);
  const urls = {
    chess: `${DATA_BASE}${version.herourl}`,
    race: `${DATA_BASE}${version.raceurl}`,
    job: `${DATA_BASE}${version.joburl}`,
    equip: `${DATA_BASE}${version.equipurl}`,
    lineups: lineupUrlFromConfig(basicConfig),
  };
  for (const [name, url] of Object.entries(urls).filter(([name]) => name !== 'lineups')) {
    assert(url.startsWith(`${DATA_BASE}/18/${version.version}-S19/`) && url.endsWith(`/${name}.js`), `unexpected ${name} URL`);
  }
  for (const [name, payload] of Object.entries({ chess, race, job, equip })) {
    assert(payload.version === version.version && payload.season === season && String(payload.setId) === mode,
      `${name} payload version/season does not match the version list`);
    assert(payload.data && typeof payload.data === 'object', `${name} payload has no data`);
  }
  const baseHeroes = Object.values(chess.data).filter((hero) => hero.showHeroTag === '1' && /^1\d+$/.test(hero.id));
  assert(baseHeroes.length === 65, `expected 65 base heroes, found ${baseHeroes.length}`);
  assert(new Set(baseHeroes.map((hero) => hero.id)).size === 65, 'duplicate base hero IDs');
  assert(new Set(baseHeroes.map((hero) => hero.name)).size === 65, 'duplicate base hero names');

  const heroes = baseHeroes.map((hero) => {
    assert(hero.name && hero.skillName && hero.skillDesc, `missing identity or skill for ${hero.id}`);
    const traits = [...new Set([
      ...traitNames(hero.species, race.data, 'race'),
      ...traitNames(hero.class, job.data, 'job'),
    ])];
    assert(traits.length, `no traits for ${hero.name}`);
    const stats = {
      health: numeric(hero.initHP, `${hero.name} health`),
      attackDamage: numeric(hero.initAttackDamage, `${hero.name} attack damage`),
      attackSpeed: numeric(hero.attackSpeed, `${hero.name} attack speed`),
      armor: numeric(hero.armor, `${hero.name} armor`),
      magicResist: numeric(hero.magicResist, `${hero.name} magic resist`),
      mana: `${numeric(hero.initMP, `${hero.name} initial mana`)}/${numeric(hero.maxMP, `${hero.name} maximum mana`)}`,
      range: numeric(hero.attackRange, `${hero.name} range`),
      critChance: `${numeric(hero.criticalStrikeChance, `${hero.name} critical chance`)}%`,
    };
    return {
      id: `hero-${hero.id}`,
      name: hero.name,
      cost: numeric(hero.price, `${hero.name} cost`),
      traits,
      skill: { name: hero.skillName.trim(), description: hero.skillDesc.trim() },
      stats,
      recommendations: { patch: version.version, items: [], comps: [], sourceIds: [] },
      variants: [{ id: 'card', kind: 'card' }, { id: 'splash', kind: 'splash' }],
    };
  }).sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
  buildOfficialRecommendations({ heroes, lineups, equip, patch: version.version, season, mode });

  const catalog = {
    schemaVersion: 1,
    seasonId: season.toLowerCase(),
    seasonName: version.name,
    patch: version.version,
    updatedAt: checkedAt,
    status: 'verified',
    sources: [
      { id: 'current-season', title: '金铲铲之战官方当前赛季配置', url: CONFIG_URL, checkedAt },
      { id: 'version', title: '金铲铲之战官方版本清单', url: VERSION_URL, checkedAt },
      { id: 'heroes', title: '金铲铲之战官方角色数据', url: urls.chess, checkedAt },
      { id: 'races', title: '金铲铲之战官方特质数据', url: urls.race, checkedAt },
      { id: 'jobs', title: '金铲铲之战官方职业数据', url: urls.job, checkedAt },
      { id: 'lineups', title: '金铲铲之战官方当前版本阵容攻略', url: urls.lineups, checkedAt },
      { id: 'equipment', title: '金铲铲之战官方当前版本装备数据', url: urls.equip, checkedAt },
    ],
    heroes,
  };
  return validateCatalog(catalog);
}

async function main() {
  const options = { output: 'data/season.json', checkedAt: new Date().toISOString().slice(0, 10) };
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    assert(value && ['--offline-dir', '--output', '--checked-at'].includes(key), `unknown or incomplete option ${key}`);
    options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  const offline = options.offlineDir && resolve(options.offlineDir);
  const read = async (name, url) => {
    if (offline) return readFile(join(offline, `upstream-${name}.${name === 'basic-config' ? 'js' : 'json'}`), 'utf8');
    const response = await fetch(url);
    assert(response.ok, `download failed for ${url} (${response.status})`);
    return response.text();
  };
  const basicConfig = await read('basic-config', CONFIG_URL);
  const versions = JSON.parse(await read('versions', VERSION_URL));
  const current = versions.find((entry) => entry.mode === '18' && entry.season === 'S19' && entry.is_newest_version === 1);
  assert(current, 'current S19 version not found');
  const names = ['chess', 'race', 'job', 'equip'];
  const [chess, race, job, equip] = await Promise.all(names.map(async (name) =>
    JSON.parse(await read(name, `${DATA_BASE}${current[name === 'chess' ? 'herourl' : `${name}url`]}`))));
  const lineups = JSON.parse(await read('lineups', lineupUrlFromConfig(basicConfig)));
  const catalog = buildCatalogFromOfficial({ basicConfig, versions, chess, race, job, equip, lineups, checkedAt: options.checkedAt });
  await writeFile(resolve(options.output), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${catalog.heroes.length} official heroes for ${catalog.seasonId} ${catalog.patch}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
