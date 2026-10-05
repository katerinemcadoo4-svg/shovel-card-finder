#!/usr/bin/env node
/**
 * Download the current official S19 portraits into a personal-use ZIP.
 * This script writes game art only outside the project or under the excluded
 * local-packs/ directory, never into the public static build.
 *
 * Usage:
 *   node scripts/make_personal_s19_pack.mjs --output local-packs/jcc-s19-personal.zip
 *   node scripts/make_personal_s19_pack.mjs --output ... --overwrite
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog, parseAssetPack } from '../src/catalog.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_URL = 'https://jcc.qq.com/data-js/basicConfig.js';
const VERSION_URL = 'https://game.gtimg.cn/images/lol/act/jkzlk/js/config/versiondataconfig.js';
const CHESS_BASE = 'https://game.gtimg.cn/images/lol/act/jkzlk/js';
const CARD_PREFIX = 'https://game.gtimg.cn/images/lol/act/jkzlk/mode18s19/hero/';
const SPLASH_TEMPLATE = 'https://game.gtimg.cn/images/jk/jkimg/mode18s19/1624x750/{{pic_name}}.jpg';
const SPLASH_CONFIG_VALUE = SPLASH_TEMPLATE.replace(/^https:/, '');
const ZIP_MAX_BYTES = 80 * 1024 * 1024;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Personal S19 pack: ${message}`);
}

function officialUrl(url, hostname, pathPrefix) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Personal S19 pack: invalid URL ${url}`); }
  requireValue(parsed.protocol === 'https:' && parsed.hostname === hostname &&
    parsed.pathname.startsWith(pathPrefix) && !parsed.username && !parsed.password && !parsed.hash,
  `unexpected non-official URL ${url}`);
  return parsed.href;
}

async function fetchBytes(url, fetchImpl, maxBytes) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  requireValue(response.ok, `HTTP ${response.status} for ${url}`);
  if (response.url) {
    const expected = new URL(url);
    officialUrl(response.url, expected.hostname, expected.pathname);
    requireValue(new URL(response.url).href === expected.href, `redirected resource ${url}`);
  }
  const contentLength = Number(response.headers?.get?.('content-length'));
  requireValue(!Number.isFinite(contentLength) || contentLength <= maxBytes,
    `resource exceeds ${maxBytes} bytes: ${url}`);
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    requireValue(bytes.length <= maxBytes, `resource exceeds ${maxBytes} bytes: ${url}`);
    return { bytes, mime: response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() };
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      requireValue(total <= maxBytes, `resource exceeds ${maxBytes} bytes: ${url}`);
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return { bytes: Buffer.concat(chunks, total), mime: response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() };
}

async function fetchText(url, fetchImpl) {
  const { bytes } = await fetchBytes(url, fetchImpl, 12 * 1024 * 1024);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function source(catalog, id, hostname, pathPrefix) {
  const entry = catalog.sources.find((candidate) => candidate.id === id);
  requireValue(entry, `catalog is missing ${id} provenance`);
  return officialUrl(entry.url, hostname, pathPrefix);
}

function currentOfficialHeroes(catalog, basicConfig, versions, chess, chessUrl) {
  const mode = basicConfig.match(/^\s*var mode\s*=\s*['"]([^'"]+)['"]/m)?.[1];
  const season = basicConfig.match(/^\s*var season\s*=\s*['"]([^'"]+)['"]/m)?.[1];
  requireValue(mode === '18' && season === 'S19', `current game mode/season is ${mode}/${season}, expected 18/S19`);
  const splashMarker = basicConfig.indexOf('hero_pic_big');
  const templateMarker = basicConfig.indexOf(SPLASH_CONFIG_VALUE, splashMarker);
  requireValue(splashMarker >= 0 && templateMarker > splashMarker && templateMarker - splashMarker < 50_000,
    'official S19 splash template changed');
  requireValue(Array.isArray(versions), 'official version list is invalid');
  const latest = versions.filter((entry) => entry.mode === mode && entry.season === season && entry.is_newest_version === 1);
  requireValue(latest.length === 1, `expected one latest S19 version, found ${latest.length}`);
  requireValue(latest[0].version === catalog.patch,
    `catalog patch ${catalog.patch} is stale; official current patch is ${latest[0].version}`);
  requireValue(`${CHESS_BASE}${latest[0].herourl}` === chessUrl, 'catalog hero source does not match current version');
  requireValue(chess.version === catalog.patch && chess.season === 'S19' && String(chess.setId) === '18' &&
    chess.data && typeof chess.data === 'object', 'official hero data does not match catalog patch');
  const entries = Object.values(chess.data).filter((hero) => hero.showHeroTag === '1' && /^1\d+$/.test(hero.id));
  requireValue(entries.length === 65 && catalog.heroes.length === 65,
    `expected 65 official and catalog base heroes, found ${entries.length}/${catalog.heroes.length}`);
  const byId = new Map(entries.map((hero) => [`hero-${hero.id}`, hero]));
  requireValue(byId.size === 65, 'official hero IDs are duplicated');
  const cardUrls = new Set();
  const splashNames = new Set();
  return catalog.heroes.flatMap((hero) => {
    const official = byId.get(hero.id);
    requireValue(official && official.name === hero.name && Number(official.price) === hero.cost,
      `catalog hero ${hero.id}/${hero.name} does not match official data`);
    requireValue(hero.variants.some((variant) => variant.id === 'card' && variant.kind === 'card') &&
      hero.variants.some((variant) => variant.id === 'splash' && variant.kind === 'splash'),
    `catalog hero ${hero.id} needs card and splash variants`);
    const cardUrl = officialUrl(official.picture, 'game.gtimg.cn',
      '/images/lol/act/jkzlk/mode18s19/hero/');
    requireValue(cardUrl.startsWith(CARD_PREFIX) && /\.png$/i.test(new URL(cardUrl).pathname),
      `unexpected card image for ${hero.id}`);
    requireValue(/^[a-z0-9_-]+$/i.test(official.heroPaint), `invalid splash ID for ${hero.id}`);
    const splashUrl = SPLASH_TEMPLATE.replace('{{pic_name}}', official.heroPaint);
    requireValue(!cardUrls.has(cardUrl) && !splashNames.has(official.heroPaint),
      `duplicate official art for ${hero.id}`);
    cardUrls.add(cardUrl);
    splashNames.add(official.heroPaint);
    return [
      { heroId: hero.id, variantId: 'card', url: cardUrl, mime: 'image/png', path: `images/${hero.id}-card.png` },
      { heroId: hero.id, variantId: 'splash', url: splashUrl, mime: 'image/jpeg', path: `images/${hero.id}-splash.jpg` },
    ];
  });
}

function imageMatches(bytes, mime) {
  if (mime === 'image/png') return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return bytes.length >= 16 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
}

async function downloadImages(references, fetchImpl) {
  const results = new Array(references.length);
  for (let offset = 0; offset < references.length; offset += 4) {
    const batch = references.slice(offset, offset + 4);
    const downloaded = await Promise.all(batch.map(async (reference) => {
      const { bytes, mime } = await fetchBytes(reference.url, fetchImpl, IMAGE_MAX_BYTES);
      requireValue(mime === reference.mime && imageMatches(bytes, reference.mime),
        `wrong image type for ${reference.url} (received ${mime ?? 'none'})`);
      return { ...reference, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    }));
    downloaded.forEach((image, index) => { results[offset + index] = image; });
  }
  return results;
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}

function storedZip(entries) {
  const chunks = [];
  const directory = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    chunks.push(local, data);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    directory.push(central);
    offset += local.length + data.length;
  }
  const directoryLength = directory.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...directory, end], offset + directoryLength + end.length);
}

export function safeOutputPath(outputPath) {
  requireValue(typeof outputPath === 'string' && outputPath.trim(), 'pass --output with a ZIP path');
  const path = resolve(outputPath);
  const inside = relative(PROJECT_ROOT, path);
  const local = relative(resolve(PROJECT_ROOT, 'local-packs'), path);
  const isWithin = (part) => part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
  const outsideProject = inside !== '' && !isWithin(inside);
  const insideLocal = isWithin(local);
  requireValue(outsideProject || insideLocal,
    'output must be under local-packs/ or outside the app directory');
  requireValue(path.toLowerCase().endsWith('.zip'), 'output filename must end in .zip');
  return path;
}

/** Build and validate the ZIP, then save it outside the public static build. */
export async function makePersonalS19Pack({ catalog, outputPath, fetchImpl = fetch, overwrite = false }) {
  validateCatalog(catalog);
  requireValue(catalog.seasonId === 's19' && catalog.status === 'verified', 'need a verified S19 catalog');
  const destination = safeOutputPath(outputPath);
  const configUrl = source(catalog, 'current-season', 'jcc.qq.com', '/data-js/basicConfig.js');
  const versionUrl = source(catalog, 'version', 'game.gtimg.cn', '/images/lol/act/jkzlk/js/config/');
  const chessUrl = source(catalog, 'heroes', 'game.gtimg.cn', '/images/lol/act/jkzlk/js/18/');
  requireValue(configUrl === CONFIG_URL && versionUrl === VERSION_URL,
    'catalog configuration sources are not the expected official endpoints');
  const [basicConfig, versionText, chessText] = await Promise.all([
    fetchText(configUrl, fetchImpl), fetchText(versionUrl, fetchImpl), fetchText(chessUrl, fetchImpl),
  ]);
  const versions = JSON.parse(versionText);
  const chess = JSON.parse(chessText);
  const references = currentOfficialHeroes(catalog, basicConfig, versions, chess, chessUrl);
  const images = await downloadImages(references, fetchImpl);
  const manifest = {
    schemaVersion: 1,
    seasonId: catalog.seasonId,
    patch: catalog.patch,
    catalog,
    provenance: 'Official 金铲铲之战 images downloaded for personal local import; do not redistribute the ZIP.',
    references: images.map(({ heroId, variantId, path, url, sha256 }) =>
      ({ heroId, variantId, path, sourceUrl: url, sha256 })),
  };
  const entries = [['manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8')],
    ...images.map(({ path, bytes }) => [path, bytes])];
  const archive = storedZip(entries);
  requireValue(archive.length <= ZIP_MAX_BYTES, 'pack exceeds the app 80 MB import limit');
  await parseAssetPack(new Blob([archive]));
  await mkdir(dirname(destination), { recursive: true });
  safeOutputPath(resolve(await realpath(dirname(destination)), basename(destination)));
  const existing = await lstat(destination).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  requireValue(!existing?.isSymbolicLink(), 'output ZIP cannot be a symbolic link');
  await writeFile(destination, archive, { flag: overwrite ? 'w' : 'wx' });
  return { outputPath: destination, heroes: catalog.heroes.length, references: images.length, bytes: archive.length };
}

function optionsFromArgs(args) {
  const options = { catalogPath: resolve(PROJECT_ROOT, 'data/season.json'), overwrite: false };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--help') return { help: true };
    if (key === '--overwrite') { options.overwrite = true; continue; }
    requireValue(['--catalog', '--output'].includes(key) && args[index + 1], `unknown or incomplete option ${key}`);
    options[key === '--catalog' ? 'catalogPath' : 'outputPath'] = resolve(args[++index]);
  }
  requireValue(options.outputPath, 'pass --output under local-packs/ or outside the app directory');
  return options;
}

async function main() {
  const options = optionsFromArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/make_personal_s19_pack.mjs --output <local-packs/file.zip-or-outside-app> [--catalog <season.json>] [--overwrite]\n');
    return;
  }
  const catalog = JSON.parse(await readFile(options.catalogPath, 'utf8'));
  const result = await makePersonalS19Pack({ ...options, catalog });
  process.stdout.write(`Saved ${result.heroes} heroes / ${result.references} images (${result.bytes} bytes): ${result.outputPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
