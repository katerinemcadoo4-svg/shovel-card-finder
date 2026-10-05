#!/usr/bin/env node
/**
 * Reproducible, local recognition evaluation. This CLI never uploads images.
 * It runs the application's recognizeImage() against a labeled set that is
 * separate from the imported reference pack. See README-evaluation.md.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { open, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAssetPack } from '../src/catalog.mjs';
import { hasOpenCvFeatures } from '../src/opencv-loader.mjs';
import { prepareReference, recognizeImage } from '../src/recognition.mjs';
import { summarizeEvaluation } from './evaluation_metrics.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SHA = bytes => createHash('sha256').update(bytes).digest('hex');
const ASSET_LIMIT = 24 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;

function usage() {
  return `Usage: node scripts/evaluate.mjs --pack FILE.zip --manifest CASES.json --output REPORT.json
       [--mode opencv|js] [--python PYTHON] [--max-orb-references 1..500]
       [--allow-synthetic-smoke]

The manifest format and independent-sample rules are in README-evaluation.md.
Pillow is required: python -m pip install Pillow`;
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage() + '\n');
    process.exit(0);
  }
  const result = { mode: 'opencv', python: 'python', allowSyntheticSmoke: false,
    maxOrbReferences: 32 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--allow-synthetic-smoke') {
      result.allowSyntheticSmoke = true;
      continue;
    }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--pack') result.pack = resolve(value);
    else if (key === '--manifest') result.manifest = resolve(value);
    else if (key === '--output') result.output = resolve(value);
    else if (key === '--mode') result.mode = value;
    else if (key === '--python') result.python = value;
    else if (key === '--max-orb-references') result.maxOrbReferences = Number(value);
    else throw new Error(`Unknown argument ${key}`);
  }
  if (!result.pack || !result.manifest || !result.output) throw new Error(usage());
  if (!['opencv', 'js'].includes(result.mode)) throw new Error('--mode must be opencv or js');
  if (!Number.isInteger(result.maxOrbReferences) || result.maxOrbReferences < 1 || result.maxOrbReferences > 500) {
    throw new Error('--max-orb-references must be an integer from 1 to 500');
  }
  if (result.output === result.pack || result.output === result.manifest) {
    throw new Error('Report path must differ from input files');
  }
  return result;
}

function imagePath(manifestPath, image) {
  if (typeof image !== 'string' || !image || isAbsolute(image) || image.includes('\\') ||
      image.split('/').some(part => part === '..' || part === '.' || !part) ||
      !/\.(?:png|jpe?g|webp)$/i.test(image)) {
    throw new Error(`Unsafe or unsupported image path ${JSON.stringify(image)}`);
  }
  const base = dirname(manifestPath);
  const absolute = resolve(base, image);
  if (!absolute.startsWith(base + sep)) throw new Error(`Image path escapes manifest folder: ${image}`);
  return absolute;
}

function validateManifest(value, catalog, manifestPath, allowSyntheticSmoke) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    throw new Error('Manifest must be a schemaVersion 1 object');
  }
  if (value.seasonId !== catalog.seasonId || value.patch !== catalog.patch) {
    throw new Error(`Test set ${value.seasonId}/${value.patch} does not match reference pack ${catalog.seasonId}/${catalog.patch}`);
  }
  if (!['independent', 'synthetic-smoke'].includes(value.datasetKind)) {
    throw new Error('datasetKind must be independent or synthetic-smoke');
  }
  if (value.datasetKind === 'synthetic-smoke' && !allowSyntheticSmoke) {
    throw new Error('Synthetic smoke fixtures require --allow-synthetic-smoke and cannot serve as acceptance evidence');
  }
  if (!Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 500) {
    throw new Error('Manifest needs 1–500 cases');
  }
  const heroIds = new Set(catalog.heroes.map(hero => hero.id));
  const ids = new Set();
  const paths = new Set();
  const sources = new Set();
  return value.cases.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Case ${index} must be an object`);
    if (!ID.test(item.id) || ids.has(item.id)) throw new Error(`Case ${index} needs a unique lowercase ASCII id`);
    ids.add(item.id);
    if (!['game', 'splash', 'unknown'].includes(item.category)) {
      throw new Error(`Case ${item.id} has an invalid category`);
    }
    if (item.category === 'unknown') {
      if (item.expectedHeroId !== undefined && item.expectedHeroId !== null) {
        throw new Error(`Unknown case ${item.id} must not have expectedHeroId`);
      }
    } else if (!heroIds.has(item.expectedHeroId)) {
      throw new Error(`Case ${item.id} has an unknown expectedHeroId`);
    }
    if (value.datasetKind === 'independent') {
      if (!ID.test(item.sourceId) || sources.has(item.sourceId)) {
        throw new Error(`Independent case ${item.id} needs a unique sourceId (one distinct capture/source per case)`);
      }
      sources.add(item.sourceId);
    }
    const absolutePath = imagePath(manifestPath, item.path);
    if (paths.has(absolutePath)) throw new Error(`Image path is reused by multiple cases: ${item.path}`);
    paths.add(absolutePath);
    return { id: item.id, category: item.category,
      expectedHeroId: item.expectedHeroId ?? null, sourceId: item.sourceId ?? null,
      path: item.path, absolutePath };
  });
}

async function checkedBytes(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > ASSET_LIMIT) {
    throw new Error(`Image must be a nonempty file under 24 MB: ${path}`);
  }
  return readFile(path);
}

async function decodeWithPillow(python, bytes, maxDimension) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, [join(scriptDirectory, 'evaluation_decode.py'),
      '--max-dimension', String(maxDimension)], { stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true });
    const output = [];
    const errors = [];
    let outputSize = 0;
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.on('error', error => reject(error));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      outputSize += chunk.length;
      if (outputSize > 16 * 1024 * 1024) child.kill();
      else output.push(chunk);
    });
    child.stderr.on('data', chunk => errors.push(chunk));
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(Buffer.concat(errors).toString('utf8').trim() ||
          `Python image decoder exited with code ${code}`));
        return;
      }
      const buffer = Buffer.concat(output);
      if (buffer.length < 16) { reject(new Error('Python image decoder returned no pixels')); return; }
      const originalWidth = buffer.readUInt32LE(0);
      const originalHeight = buffer.readUInt32LE(4);
      const width = buffer.readUInt32LE(8);
      const height = buffer.readUInt32LE(12);
      if (!width || !height || width > maxDimension || height > maxDimension ||
          buffer.length !== 16 + width * height * 4) {
        reject(new Error('Python image decoder returned invalid dimensions')); return;
      }
      resolvePromise({ originalWidth, originalHeight, width, height,
        data: new Uint8ClampedArray(buffer.subarray(16)) });
    });
    child.stdin.end(bytes);
  });
}

async function loadNodeOpenCv() {
  return new Promise((resolvePromise, reject) => {
    let finished = false;
    const timeout = setTimeout(() => finish(new Error('OpenCV initialization timed out')), 30_000);
    function finish(error, cv) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (error) reject(error);
      // Emscripten's Module is thenable; wrapping avoids Promise assimilation.
      else resolvePromise({ cv });
    }
    globalThis.Module = {
      onRuntimeInitialized() {
        const cv = hasOpenCvFeatures(this) ? this : globalThis.Module;
        if (hasOpenCvFeatures(cv)) finish(null, cv);
        else finish(new Error('Pinned OpenCV.js build has no ORB/homography features'));
      },
    };
    try {
      const exported = require('../vendor/opencv-4.8.0.js');
      const cv = hasOpenCvFeatures(exported) ? exported : globalThis.Module;
      if (hasOpenCvFeatures(cv)) finish(null, cv);
    } catch (error) { finish(error); }
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  try { await stat(args.output); throw new Error(`Report already exists: ${args.output}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const packBytes = await readFile(args.pack);
  const manifestBytes = await readFile(args.manifest);
  if (manifestBytes.length > 1024 * 1024) throw new Error('Test manifest exceeds 1 MB');
  const { catalog, records } = await parseAssetPack(packBytes);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw new Error('Test manifest is not valid JSON'); }
  const cases = validateManifest(manifest, catalog, args.manifest, args.allowSyntheticSmoke);
  const referenceHashes = new Set();
  const references = [];
  process.stderr.write(`Decoding ${records.length} local references with Pillow...\n`);
  const referenceStarted = performance.now();
  for (const record of records) {
    const bytes = Buffer.from(await record.blob.arrayBuffer());
    referenceHashes.add(SHA(bytes));
    const pixels = await decodeWithPillow(args.python, bytes, 480);
    references.push({ heroId: record.heroId, variantId: record.variantId, blob: pixels });
  }
  const decodeImage = async pixels => pixels;
  for (const reference of references) {
    await prepareReference(reference.blob, { decodeImage, maxReferenceDimension: 480 });
  }
  const referencePreparationMs = Number((performance.now() - referenceStarted).toFixed(1));
  let cv = null;
  if (args.mode === 'opencv') {
    process.stderr.write('Loading pinned local OpenCV.js...\n');
    ({ cv } = await loadNodeOpenCv());
  }
  const seenCaseHashes = new Set();
  let referenceReuseCount = 0;
  const rows = [];
  for (const [index, item] of cases.entries()) {
    process.stderr.write(`[${index + 1}/${cases.length}] ${item.category} ${item.id}\n`);
    const bytes = await checkedBytes(item.absolutePath);
    const imageSha256 = SHA(bytes);
    if (seenCaseHashes.has(imageSha256) && manifest.datasetKind === 'independent') {
      throw new Error(`Test image is duplicated within the independent set: ${item.path}`);
    }
    seenCaseHashes.add(imageSha256);
    if (referenceHashes.has(imageSha256)) {
      referenceReuseCount++;
      if (manifest.datasetKind === 'independent') {
        throw new Error(`Test image is byte-for-byte identical to a reference: ${item.path}`);
      }
    }
    const decodingStarted = performance.now();
    const pixels = await decodeWithPillow(args.python, bytes, 960);
    const decodeMs = Number((performance.now() - decodingStarted).toFixed(1));
    const started = performance.now();
    const result = await recognizeImage(pixels, references, { cv, decodeImage,
      maxImageDimension: 960, maxReferenceDimension: 480,
      maxOrbReferences: args.maxOrbReferences });
    const recognitionMs = Number((performance.now() - started).toFixed(1));
    rows.push({ id: item.id, category: item.category,
      expectedHeroId: item.expectedHeroId, sourceId: item.sourceId,
      path: item.path, imageSha256, status: result.status,
      predictedHeroId: result.status === 'match' ? result.matches[0]?.heroId ?? null : null,
      candidates: result.matches.map(candidate => ({ heroId: candidate.heroId,
        score: candidate.score, evidence: candidate.evidence, box: candidate.box })),
      reason: result.reason, decodeMs, recognitionMs,
      diagnostics: result.diagnostics ?? null });
  }
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    acceptanceEvidence: false,
    independentDatasetDeclared: manifest.datasetKind === 'independent',
    fullAlgorithm: args.mode === 'opencv',
    limitations: [
      'Independence is declared by the manifest author; exact byte reuse is checked, but crops/resizes cannot be proved independent.',
      'CLI timings use warmed references and Pillow-decoded inputs on this computer. Measure Safari on the target iPhone separately.',
      ...(args.mode === 'js' ? ['Pure JS comparison mode omits OpenCV geometric matching.'] : []),
      ...(manifest.datasetKind === 'synthetic-smoke' ? ['Synthetic smoke images are generated/non-independent and cannot establish accuracy.'] : []),
    ],
    pack: { seasonId: catalog.seasonId, patch: catalog.patch, sha256: SHA(packBytes),
      referenceCount: records.length },
    dataset: { kind: manifest.datasetKind, manifestSha256: SHA(manifestBytes),
      count: cases.length, referenceReuseCount },
    runtime: { mode: args.mode, node: process.version, platform: process.platform,
      arch: process.arch, referencePreparationMs, maxOrbReferences: args.maxOrbReferences,
      maxImageDimension: 960, maxReferenceDimension: 480,
      recognitionSourceSha256: SHA(await readFile(join(scriptDirectory, '..', 'src', 'recognition.mjs'))),
      openCvSourceSha256: args.mode === 'opencv'
        ? SHA(await readFile(join(scriptDirectory, '..', 'vendor', 'opencv-4.8.0.js'))) : null },
    summary: summarizeEvaluation(rows), cases: rows,
  };
  const file = await open(args.output, 'wx');
  try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); }
  finally { await file.close(); }
  const pct = value => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
  process.stdout.write(`Report: ${args.output}\n`);
  process.stdout.write(`Game top-1: ${pct(report.summary.game.top1Rate)} (${report.summary.game.top1Correct}/${report.summary.game.count})\n`);
  process.stdout.write(`Splash top-1: ${pct(report.summary.splash.top1Rate)} (${report.summary.splash.top1Correct}/${report.summary.splash.count})\n`);
  process.stdout.write(`Unknown false positives: ${pct(report.summary.unknown.falsePositiveRate)} (${report.summary.unknown.falsePositives}/${report.summary.unknown.count})\n`);
  process.stdout.write(`Reference reuse: ${referenceReuseCount}; desktop CLI run is NOT iPhone acceptance evidence\n`);
}

run().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
