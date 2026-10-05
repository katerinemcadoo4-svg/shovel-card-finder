/**
 * Versioned text-only official lineup catalog. Slots are preserved individually:
 * the same summon can occur more than once in an official formation.
 * No artwork URLs, live popularity, or match win rates are part of this schema.
 */
export const LINEUP_SCHEMA_VERSION = 1;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const UNIT_ID = /^\d{1,12}$/;
export const LINEUP_GUIDE_KEYS = ['early', 'reroll', 'position', 'matchups', 'equipment', 'augments', 'adventure'];

function invalid(path, reason) { throw new Error(`Invalid lineup catalog at ${path}: ${reason}`); }
function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'expected an object');
  return value;
}
function array(value, path, max) {
  if (!Array.isArray(value) || value.length > max) invalid(path, `expected an array of at most ${max} entries`);
  return value;
}
function text(value, path, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) invalid(path, 'expected text');
}
function id(value, path) {
  if (typeof value !== 'string' || !ID.test(value)) invalid(path, 'expected a stable lowercase ASCII ID');
}
function date(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    invalid(path, 'expected an ISO date');
  }
}
function unique(values, path) {
  if (new Set(values).size !== values.length) invalid(path, 'duplicate IDs');
}

/** Validate text, provenance, complete slot records, and optional catalog compatibility. */
export function validateLineupCatalog(value, { catalog } = {}) {
  const data = object(value, 'root');
  if (data.schemaVersion !== LINEUP_SCHEMA_VERSION) invalid('schemaVersion', 'unsupported version');
  id(data.seasonId, 'seasonId');
  text(data.seasonName, 'seasonName', 120);
  text(data.patch, 'patch', 80);
  date(data.updatedAt, 'updatedAt');
  if (data.status !== 'verified') invalid('status', 'expected verified source data');
  if (catalog && (data.seasonId !== catalog.seasonId || data.patch !== catalog.patch)) {
    invalid('patch', 'lineup season and patch must match the active hero catalog');
  }

  const sources = array(data.sources, 'sources', 20);
  const sourceIds = sources.map((source, index) => {
    const path = `sources[${index}]`;
    object(source, path);
    id(source.id, `${path}.id`);
    text(source.title, `${path}.title`, 200);
    text(source.url, `${path}.url`, 1000);
    if (!/^https:\/\//i.test(source.url)) invalid(`${path}.url`, 'expected an HTTPS source');
    date(source.checkedAt, `${path}.checkedAt`);
    return source.id;
  });
  unique(sourceIds, 'sources');
  if (!sources.length) invalid('sources', 'source data needs provenance');
  const heroMap = catalog && new Map(catalog.heroes.map(hero => [hero.id, hero]));
  const lineups = array(data.lineups, 'lineups', 200);
  if (!lineups.length) invalid('lineups', 'source data cannot be empty');
  unique(lineups.map((lineup, index) => {
    const path = `lineups[${index}]`;
    object(lineup, path);
    id(lineup.id, `${path}.id`);
    if (typeof lineup.officialId !== 'string' || !UNIT_ID.test(lineup.officialId)) invalid(`${path}.officialId`, 'expected the official numeric ID');
    if (lineup.id !== `official-${lineup.officialId}`) invalid(`${path}.id`, 'must match officialId');
    text(lineup.name, `${path}.name`, 200);
    if (!['S', 'A'].includes(lineup.quality)) invalid(`${path}.quality`, 'expected official S or A grade');
    if (!Number.isSafeInteger(lineup.sortOrder) || lineup.sortOrder < 0) invalid(`${path}.sortOrder`, 'expected official nonnegative order');
    text(lineup.author, `${path}.author`, 200, true);
    const references = array(lineup.sourceIds, `${path}.sourceIds`, 20);
    if (!references.length || !references.includes('lineups')) invalid(`${path}.sourceIds`, 'needs the lineup source');
    unique(references, `${path}.sourceIds`);
    references.forEach((reference, i) => {
      if (!sourceIds.includes(reference)) invalid(`${path}.sourceIds[${i}]`, 'unknown source');
    });
    const members = array(lineup.members, `${path}.members`, 40);
    if (!members.length) invalid(`${path}.members`, 'needs the official formation');
    members.forEach((member, i) => {
      const slotPath = `${path}.members[${i}]`;
      object(member, slotPath);
      if (typeof member.unitId !== 'string' || !UNIT_ID.test(member.unitId)) invalid(`${slotPath}.unitId`, 'expected a numeric unit ID');
      text(member.name, `${slotPath}.name`, 120);
      if (!['hero', 'pet'].includes(member.kind)) invalid(`${slotPath}.kind`, 'expected hero or pet');
      if (!Number.isInteger(member.cost) || member.cost < 0 || member.cost > 10) invalid(`${slotPath}.cost`, 'expected a cost from 0 to 10');
      if (typeof member.isCarry !== 'boolean') invalid(`${slotPath}.isCarry`, 'expected the official carry marker');
      if (member.heroId !== null) {
        id(member.heroId, `${slotPath}.heroId`);
        if (member.heroId !== `hero-${member.unitId}`) invalid(`${slotPath}.heroId`, 'must match unitId');
        if (heroMap) {
          const hero = heroMap.get(member.heroId);
          if (!hero || hero.name !== member.name || hero.cost !== member.cost) invalid(`${slotPath}.heroId`, 'does not match the active hero catalog');
        }
      }
      if (member.position !== null) {
        object(member.position, `${slotPath}.position`);
        if (!Number.isInteger(member.position.row) || member.position.row < 1 || member.position.row > 4 ||
            !Number.isInteger(member.position.column) || member.position.column < 1 || member.position.column > 7) {
          invalid(`${slotPath}.position`, 'expected a 4 by 7 board position');
        }
      }
      array(member.items, `${slotPath}.items`, 3).forEach((item, itemIndex) => {
        object(item, `${slotPath}.items[${itemIndex}]`);
        if (typeof item.id !== 'string' || !UNIT_ID.test(item.id)) invalid(`${slotPath}.items[${itemIndex}].id`, 'expected a numeric equipment ID');
        text(item.name, `${slotPath}.items[${itemIndex}].name`, 120);
      });
    });
    object(lineup.guide, `${path}.guide`);
    for (const key of LINEUP_GUIDE_KEYS) text(lineup.guide[key], `${path}.guide.${key}`, 6000, true);
    return lineup.id;
  }), 'lineups');
  return data;
}

/** Load the static text dataset; incompatible seasonal recommendations are rejected. */
export async function loadLineups(catalog, url = 'data/lineups.json') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { cache: 'no-cache', signal: controller.signal });
    if (!response.ok) throw new Error(`Could not load official lineups (${response.status})`);
    return validateLineupCatalog(await response.json(), { catalog });
  } finally {
    clearTimeout(timeout);
  }
}
