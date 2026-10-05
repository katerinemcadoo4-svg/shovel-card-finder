import { readZipEntries } from './zip.mjs';

/**
 * Catalog v1 (JSON):
 * {
 *   schemaVersion: 1, seasonId, seasonName, patch, updatedAt, status,
 *   sources: [{ id, title, url, checkedAt }],
 *   heroes: [{ id, name, cost, traits: [string],
 *     skill: { name, description }, stats: { [label]: number|string },
 *     recommendations: { patch, items: [{name, reason?}],
 *       comps: [{name, description?}], sourceIds: [source id] },
 *     variants: [{ id, kind: 'card'|'splash', label?, url? }] }]
 * }
 *
 * `status: 'unverified'` with no heroes is a valid placeholder, but must not
 * be presented as current-season coverage. Verified and user-provided catalogs
 * must name their sources. Variant URLs are optional same-origin public assets;
 * locally imported images live in IndexedDB instead.
 *
 * Asset ZIP v1 has a root manifest.json:
 * { schemaVersion: 1, seasonId, patch, catalog?: <catalog v1>,
 *   references: [{ heroId, variantId, path }] }
 * The embedded catalog makes a ZIP usable even when the built-in catalog is
 * empty. If omitted, importAssetPack requires a matching `catalog` argument.
 */
export const CATALOG_SCHEMA_VERSION = 1;
export const ASSET_PACK_SCHEMA_VERSION = 1;

const DB_NAME = 'golden-spatula-local-assets';
const DB_VERSION = 1;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function invalid(path, reason) { throw new Error(`Invalid catalog at ${path}: ${reason}`); }
function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'expected an object');
  return value;
}
function array(value, path, max = 500) {
  if (!Array.isArray(value) || value.length > max) invalid(path, `expected an array of at most ${max} entries`);
  return value;
}
function string(value, path, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(path, 'expected nonempty text');
  return value;
}
function id(value, path) {
  if (typeof value !== 'string' || !ID.test(value)) invalid(path, 'expected a stable lowercase ASCII ID');
  return value;
}
function date(value, path) {
  string(value, path, 40);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/.test(value) || Number.isNaN(Date.parse(value))) {
    invalid(path, 'expected an ISO date or UTC timestamp');
  }
  return value;
}
function unique(values, path) {
  if (new Set(values).size !== values.length) invalid(path, 'duplicate IDs');
}
function optionalText(value, path, max = 500) {
  if (value !== undefined) string(value, path, max);
}
function safeAssetUrl(value, path) {
  string(value, path, 500);
  // Keep URLs as plain relative paths. URL/fetch parsing trims leading ASCII
  // whitespace, which otherwise turns `  https://...` into a cross-origin URL.
  if (!/^[a-z0-9][a-z0-9_./-]*\.(?:png|jpe?g|webp)$/i.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..')) {
    invalid(path, 'expected a same-origin relative PNG, JPEG, or WebP asset path');
  }
}

/** Validate a catalog and return the original value. Throws with a field path. */
export function validateCatalog(value) {
  const catalog = object(value, 'root');
  if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) invalid('schemaVersion', 'unsupported version');
  id(catalog.seasonId, 'seasonId');
  string(catalog.seasonName, 'seasonName', 120);
  string(catalog.patch, 'patch', 80);
  date(catalog.updatedAt, 'updatedAt');
  if (!['verified', 'user-provided', 'unverified'].includes(catalog.status)) invalid('status', 'unknown status');

  const sources = array(catalog.sources, 'sources', 100);
  const sourceIds = sources.map((source, index) => {
    const path = `sources[${index}]`;
    object(source, path);
    id(source.id, `${path}.id`);
    string(source.title, `${path}.title`, 200);
    string(source.url, `${path}.url`, 1000);
    if (!/^https:\/\//i.test(source.url)) invalid(`${path}.url`, 'expected an HTTPS source');
    date(source.checkedAt, `${path}.checkedAt`);
    return source.id;
  });
  unique(sourceIds, 'sources');

  const heroes = array(catalog.heroes, 'heroes', 400);
  if (heroes.length && catalog.status !== 'unverified' && !sources.length) invalid('sources', 'nonempty sourced catalog needs a source');
  if (catalog.status === 'verified' && !heroes.length) invalid('heroes', 'verified catalog cannot be empty');
  const heroIds = heroes.map((hero, index) => {
    const path = `heroes[${index}]`;
    object(hero, path);
    id(hero.id, `${path}.id`);
    string(hero.name, `${path}.name`, 120);
    if (!Number.isInteger(hero.cost) || hero.cost < 0 || hero.cost > 10) invalid(`${path}.cost`, 'expected a cost from 0 to 10');
    array(hero.traits, `${path}.traits`, 12).forEach((trait, i) => string(trait, `${path}.traits[${i}]`, 100));
    object(hero.skill, `${path}.skill`);
    string(hero.skill.name, `${path}.skill.name`, 120);
    string(hero.skill.description, `${path}.skill.description`, 3000);
    object(hero.stats, `${path}.stats`);
    if (Object.keys(hero.stats).length > 40) invalid(`${path}.stats`, 'too many stats');
    for (const [key, stat] of Object.entries(hero.stats)) {
      string(key, `${path}.stats key`, 80);
      if (!(typeof stat === 'number' && Number.isFinite(stat) && stat >= 0) &&
          !(typeof stat === 'string' && stat.trim() && stat.length <= 100)) {
        invalid(`${path}.stats.${key}`, 'expected a nonnegative number or short text');
      }
    }
    object(hero.recommendations, `${path}.recommendations`);
    if (hero.recommendations.patch !== catalog.patch) invalid(`${path}.recommendations.patch`, 'must match catalog patch');
    for (const group of ['items', 'comps']) {
      array(hero.recommendations[group], `${path}.recommendations.${group}`, 30).forEach((entry, i) => {
        const entryPath = `${path}.recommendations.${group}[${i}]`;
        object(entry, entryPath);
        string(entry.name, `${entryPath}.name`, 150);
        optionalText(entry.reason, `${entryPath}.reason`, 500);
        optionalText(entry.description, `${entryPath}.description`, 800);
      });
    }
    array(hero.recommendations.sourceIds, `${path}.recommendations.sourceIds`, 30).forEach((sourceId, i) => {
      id(sourceId, `${path}.recommendations.sourceIds[${i}]`);
      if (!sourceIds.includes(sourceId)) invalid(`${path}.recommendations.sourceIds[${i}]`, 'unknown source');
    });
    const variants = array(hero.variants, `${path}.variants`, 30);
    const variantIds = variants.map((variant, i) => {
      const variantPath = `${path}.variants[${i}]`;
      object(variant, variantPath);
      id(variant.id, `${variantPath}.id`);
      if (!['card', 'splash'].includes(variant.kind)) invalid(`${variantPath}.kind`, 'expected card or splash');
      optionalText(variant.label, `${variantPath}.label`, 120);
      if (variant.url !== undefined) safeAssetUrl(variant.url, `${variantPath}.url`);
      return variant.id;
    });
    unique(variantIds, `${path}.variants`);
    return hero.id;
  });
  unique(heroIds, 'heroes');
  return catalog;
}

function imageType(bytes, path) {
  const extension = path.split('.').at(-1)?.toLowerCase();
  if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 &&
      bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10 && extension === 'png') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && ['jpg', 'jpeg'].includes(extension)) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP' && extension === 'webp') return 'image/webp';
  throw new Error(`Asset ${path} must be a PNG, JPEG, or WebP image matching its file extension`);
}

/** Parse and validate a ZIP without writing it. Useful for import previews/tests. */
export async function parseAssetPack(file, { catalog: fallbackCatalog } = {}) {
  const entries = await readZipEntries(file);
  const manifestBytes = entries.get('manifest.json');
  if (!manifestBytes || manifestBytes.length > 1024 * 1024) throw new Error('Asset ZIP needs a root manifest.json under 1 MB');
  let manifest;
  try { manifest = JSON.parse(textDecoder.decode(manifestBytes)); }
  catch { throw new Error('Asset ZIP manifest.json is not valid UTF-8 JSON'); }
  object(manifest, 'manifest');
  if (manifest.schemaVersion !== ASSET_PACK_SCHEMA_VERSION) throw new Error('Unsupported asset ZIP manifest version');
  id(manifest.seasonId, 'manifest.seasonId');
  string(manifest.patch, 'manifest.patch', 80);
  const catalog = validateCatalog(manifest.catalog ?? fallbackCatalog);
  if (!catalog.heroes.length) throw new Error('Asset ZIP needs a nonempty catalog');
  if (manifest.seasonId !== catalog.seasonId || manifest.patch !== catalog.patch) {
    throw new Error('Asset ZIP season and patch must match its catalog');
  }
  const heroes = new Map(catalog.heroes.map((hero) => [hero.id, hero]));
  const records = [];
  const used = new Set();
  for (const [index, reference] of array(manifest.references, 'manifest.references', 500).entries()) {
    const path = `manifest.references[${index}]`;
    object(reference, path);
    id(reference.heroId, `${path}.heroId`);
    id(reference.variantId, `${path}.variantId`);
    string(reference.path, `${path}.path`, 300);
    const hero = heroes.get(reference.heroId);
    if (!hero) throw new Error(`Unknown hero ID ${reference.heroId} in asset ZIP`);
    if (!hero.variants.some((variant) => variant.id === reference.variantId)) {
      throw new Error(`Unknown variant ID ${reference.variantId} for ${reference.heroId} in asset ZIP`);
    }
    const key = `${reference.heroId}/${reference.variantId}`;
    if (used.has(key)) throw new Error(`Duplicate image for ${key} in asset ZIP`);
    used.add(key);
    const bytes = entries.get(reference.path);
    if (!bytes) throw new Error(`Missing image ${reference.path} in asset ZIP`);
    const type = imageType(bytes, reference.path);
    records.push({ key, heroId: reference.heroId, variantId: reference.variantId,
      blob: new Blob([bytes], { type }) });
  }
  if (!records.length) throw new Error('Asset ZIP needs at least one reference image');
  return { catalog, records };
}

function openDb() {
  if (typeof indexedDB === 'undefined') throw new Error('Local asset storage is unavailable in this browser');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('references')) db.createObjectStore('references', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local asset storage'));
    request.onblocked = () => reject(new Error('Local asset storage is busy in another tab'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Local asset storage read failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Local asset storage transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Local asset storage transaction failed'));
  });
}

async function activeMeta() {
  if (typeof indexedDB === 'undefined') return null;
  let db;
  try {
    db = await openDb();
    return await requestResult(db.transaction('meta', 'readonly').objectStore('meta').get('active'));
  } catch {
    // Keep the bundled atlas available even when private or restricted browser
    // storage cannot be opened. ZIP import will report the storage error.
    return null;
  } finally { db?.close(); }
}

/** Import a local ZIP atomically and make its catalog active; returns import metadata. */
export async function importAssetPack(file, options = {}) {
  const { catalog, records } = await parseAssetPack(file, options);
  const importedAt = new Date().toISOString();
  const db = await openDb();
  try {
    const transaction = db.transaction(['meta', 'references'], 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore('references').clear();
    for (const record of records) transaction.objectStore('references').put(record);
    transaction.objectStore('meta').put({ catalog, referenceCount: records.length, importedAt }, 'active');
    await done;
  } finally { db.close(); }
  return { catalog, referenceCount: records.length, importedAt };
}

/**
 * Prefer verified site text over ZIP text, including corrections within one
 * patch. A ZIP catalog is used when the bundled catalog is unverified or
 * unavailable offline. getReferences() only uses images matching the selected
 * catalog's season and patch.
 */
export async function loadCatalog(url = 'data/season.json') {
  const active = await activeMeta();
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not load season catalog (${response.status})`);
    const bundled = validateCatalog(await response.json());
    // The site's verified text may be corrected within the same patch. A
    // locally imported ZIP supplies reference images, not a permanent override
    // of the published skills, stats, guides, and source links.
    if (active?.catalog && bundled.status === 'unverified') {
      return validateCatalog(active.catalog);
    }
    return bundled;
  } catch (error) {
    if (active?.catalog) return validateCatalog(active.catalog);
    throw error;
  }
}

/** Return local-pack state for UI status. */
export async function getAssetPackState() {
  const active = await activeMeta();
  return active ? { installed: true, catalog: validateCatalog(active.catalog),
    referenceCount: active.referenceCount, importedAt: active.importedAt }
    : { installed: false, catalog: null, referenceCount: 0, importedAt: null };
}

/** Remove the imported pack and return to the built-in catalog. */
export async function clearAssetPack() {
  if (typeof indexedDB === 'undefined') return;
  const db = await openDb();
  try {
    const transaction = db.transaction(['meta', 'references'], 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore('meta').clear();
    transaction.objectStore('references').clear();
    await done;
  } finally { db.close(); }
}

/** Return `{heroId, variantId, blob}` references for the given catalog. */
export async function getReferences(catalog) {
  validateCatalog(catalog);
  const references = new Map();
  const allowedKeys = new Set(catalog.heroes.flatMap((hero) => hero.variants.map((variant) => `${hero.id}/${variant.id}`)));
  if (typeof indexedDB !== 'undefined') {
    let db;
    try {
      db = await openDb();
      const transaction = db.transaction(['meta', 'references'], 'readonly');
      const metaRequest = requestResult(transaction.objectStore('meta').get('active'));
      const referencesRequest = requestResult(transaction.objectStore('references').getAll());
      const [meta, storedReferences] = await Promise.all([metaRequest, referencesRequest]);
      if (meta?.catalog?.seasonId === catalog.seasonId && meta.catalog.patch === catalog.patch) {
        for (const record of storedReferences) {
          if (allowedKeys.has(record.key)) {
            references.set(record.key, { heroId: record.heroId, variantId: record.variantId, blob: record.blob });
          }
        }
      }
    } catch {
      // Public references and the built-in atlas can still work without IDB.
    } finally { db?.close(); }
  }
  for (const hero of catalog.heroes) {
    for (const variant of hero.variants) {
      const key = `${hero.id}/${variant.id}`;
      if (!variant.url || references.has(key)) continue;
      const response = await fetch(variant.url);
      if (!response.ok) throw new Error(`Could not load reference ${variant.url} (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 24 * 1024 * 1024) throw new Error(`Reference image ${variant.url} exceeds size limit`);
      const type = imageType(bytes, variant.url);
      references.set(key, { heroId: hero.id, variantId: variant.id, blob: new Blob([bytes], { type }) });
    }
  }
  return [...references.values()];
}
