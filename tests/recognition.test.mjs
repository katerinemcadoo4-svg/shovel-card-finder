import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { recognizeImage, prepareReference } from '../src/recognition.mjs';
import { hasOpenCvFeatures } from '../src/opencv-loader.mjs';

const require = createRequire(import.meta.url);

function pixels(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const at = (y * width + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

function card(seed) {
  return pixels(64, 80, (x, y) => {
    const tile = ((x >> 3) * 19 + (y >> 3) * 29 + seed * 37) >>> 0;
    return [
      (tile * 41 + x * 7 + y * 3) % 256,
      (tile * 67 + x * 3 + y * 11) % 256,
      (tile * 17 + x * 13 + y * 5) % 256,
    ];
  });
}

function embed(reference, x0, y0) {
  return pixels(Math.max(220, x0 + reference.width + 40),
    Math.max(260, y0 + reference.height + 40), (x, y) => {
    if (x >= x0 && x < x0 + reference.width &&
        y >= y0 && y < y0 + reference.height) {
      const at = ((y - y0) * reference.width + x - x0) * 4;
      return [...reference.data.slice(at, at + 3)];
    }
    return [17, 23, 39];
  });
}

const decodeImage = async image => image;
const reference = (heroId, image) => ({ heroId, variantId: 'art', blob: image });

test('no reference data is explicitly unavailable', async () => {
  const result = await recognizeImage(card(1), [], { decodeImage });
  assert.deepEqual(result, { status: 'unavailable', matches: [], reason: 'no_references' });
});

test('the exact image matches its own reference', async () => {
  const first = card(1);
  const second = card(2);
  const result = await recognizeImage(first,
    [reference('first', first), reference('second', second)], { decodeImage });
  assert.equal(result.status, 'match');
  assert.equal(result.matches[0].heroId, 'first');
  assert.equal(result.matches[0].score, 1);
  assert.deepEqual(result.matches[0].box, { x: 0, y: 0, width: 64, height: 80 });
  assert.equal(result.matches[0].evidence.method, 'phash');
});

test('a local card in a larger screenshot is found without a crop', async () => {
  const wanted = card(5);
  const screenshot = embed(wanted, 92, 104);
  const result = await recognizeImage(screenshot,
    [reference('wanted', wanted), reference('other', card(2))], { decodeImage });
  assert.equal(result.status, 'match', JSON.stringify(result));
  assert.equal(result.matches[0].heroId, 'wanted');
  const box = result.matches[0].box;
  assert.ok(Math.abs(box.x - 92) <= 8, `x=${box.x}`);
  assert.ok(Math.abs(box.y - 104) <= 10, `y=${box.y}`);
});

test('an unrelated image does not become a confident match', async () => {
  const image = pixels(220, 260, (x, y) => [
    (x * 9 + y * 13) % 256,
    (x * 31 + y * 7) % 256,
    (x * 3 + y * 47) % 256,
  ]);
  const result = await recognizeImage(image,
    [reference('first', card(1)), reference('second', card(2))], { decodeImage });
  assert.equal(result.status, 'uncertain');
  assert.ok(result.matches.length <= 3);
  assert.equal(result.reason, 'insufficient_evidence');
});

test('visually identical references for different heroes remain uncertain', async () => {
  const art = card(8);
  const result = await recognizeImage(art,
    [reference('hero-a', art), reference('hero-b', art)], { decodeImage });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].score, 1);
  assert.equal(result.matches[1].score, 1);
});

test('bad imported files are skipped and do not prevent a usable reference', async () => {
  const wanted = card(3);
  const result = await recognizeImage(wanted,
    [{ heroId: 'broken', blob: {} }, reference('wanted', wanted)],
    { decodeImage });
  assert.equal(result.status, 'match');
  assert.equal(result.matches[0].heroId, 'wanted');
  const prepared = await prepareReference(wanted, { decodeImage });
  assert.equal(prepared.aspect, 0.8);
});

test('prepared references cache per decoder without crossing decoder identities', async () => {
  const blob = {};
  let firstCalls = 0;
  let secondCalls = 0;
  const first = async () => { firstCalls++; return card(1); };
  const second = async () => { secondCalls++; return card(2); };
  const initial = await prepareReference(blob, { decodeImage: first });
  assert.strictEqual(await prepareReference(blob, { decodeImage: first }), initial);
  assert.equal(firstCalls, 1);
  assert.notStrictEqual(await prepareReference(blob, { decodeImage: second }), initial);
  assert.equal(secondCalls, 1);
});

test('the pinned local OpenCV build geometrically locates a textured card', async () => {
  const { cv } = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('OpenCV runtime did not initialize')), 10_000);
    globalThis.Module = {
      onRuntimeInitialized() {
        clearTimeout(timeout);
        // Emscripten Module is thenable; wrap it to avoid Promise assimilation.
        resolve({ cv: this });
      },
    };
    require('../vendor/opencv-4.8.0.js');
  });
  assert.equal(hasOpenCvFeatures(cv), true);

  const art = pixels(240, 300, (x, y) => {
    let value = Math.imul((x >> 4) + 19, 374761393) +
      Math.imul((y >> 4) + 31, 668265263);
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255];
  });
  const screenshot = embed(art, 93, 107);
  const phases = [];
  const result = await recognizeImage(screenshot, [reference('textured', art)], {
    cv, decodeImage,
    onProgress: progress => phases.push(progress.phase),
  });
  assert.equal(result.status, 'match', JSON.stringify(result));
  assert.equal(result.matches[0].heroId, 'textured');
  assert.equal(result.matches[0].evidence.method, 'orb', JSON.stringify(result));
  assert.ok(result.matches[0].evidence.inliers >= 12);
  assert.equal(result.diagnostics.orbAvailable, true);
  assert.equal(result.diagnostics.orbChecked, 1);
  for (const stage of ['prepareMs', 'coarseMs', 'cvWaitMs', 'orbMs', 'opencvMs']) {
    assert.ok(Number.isInteger(result.diagnostics[stage]));
  }
  assert.ok(phases.includes('orb'));
  const box = result.matches[0].box;
  assert.ok(Math.abs(box.x - 93) <= 8, `x=${box.x}`);
  assert.ok(Math.abs(box.y - 107) <= 8, `y=${box.y}`);
});
