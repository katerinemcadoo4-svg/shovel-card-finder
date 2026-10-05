import { loadLocalOpenCv, hasOpenCvFeatures } from './opencv-loader.mjs';

/**
 * Local image matching for the card finder. No image or descriptor leaves the browser.
 *
 * A reference is { heroId, variantId, blob }. Boxes use pixel coordinates in the
 * original, orientation-corrected input image. The pure JS path is deliberately
 * conservative: it is a coarse matcher, not a trained image classifier.
 */

const GRID = 16;
const HASH_SIZE = 8;
const COLOR_GRID = 4;
const referenceCache = new WeakMap();
const cosine = Array.from({ length: HASH_SIZE }, (_, frequency) =>
  Float64Array.from({ length: GRID }, (_, position) =>
    Math.cos(((2 * position + 1) * frequency * Math.PI) / (2 * GRID)),
  ),
);

function report(options, phase, done, total) {
  if (typeof options.onProgress === 'function') {
    try { options.onProgress({ phase, done, total }); } catch { /* UI callback is advisory. */ }
  }
}

const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
const nowMs = () => globalThis.performance?.now?.() ?? Date.now();

function validatePixels(image) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
      image.width < 1 || image.height < 1 || !image.data ||
      image.data.length < image.width * image.height * 4) {
    throw new Error('Image decoder did not return RGBA pixels');
  }
  return image;
}

function reducePixels(image, maxDimension) {
  if (Math.max(image.width, image.height) <= maxDimension) {
    return { ...image, originalWidth: image.originalWidth ?? image.width,
      originalHeight: image.originalHeight ?? image.height };
  }
  const scale = maxDimension / Math.max(image.width, image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x + 0.5) / scale));
      const from = (sy * image.width + sx) * 4;
      const to = (y * width + x) * 4;
      data[to] = image.data[from];
      data[to + 1] = image.data[from + 1];
      data[to + 2] = image.data[from + 2];
      data[to + 3] = image.data[from + 3];
    }
  }
  return { width, height, data,
    originalWidth: image.originalWidth ?? image.width,
    originalHeight: image.originalHeight ?? image.height };
}

async function decode(blob, maxDimension, options) {
  if (typeof options.decodeImage === 'function') {
    return reducePixels(validatePixels(await options.decodeImage(blob)), maxDimension);
  }
  let bitmap;
  let objectUrl;
  if (typeof globalThis.createImageBitmap === 'function') {
    try { bitmap = await globalThis.createImageBitmap(blob); } catch { /* Try Safari's img decoder. */ }
  }
  if (!bitmap && globalThis.document && globalThis.URL?.createObjectURL) {
    objectUrl = globalThis.URL.createObjectURL(blob);
    try {
      bitmap = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Image decoding failed'));
        image.src = objectUrl;
      });
    } catch {
      globalThis.URL.revokeObjectURL(objectUrl);
      throw new Error('Image decoding failed');
    }
  }
  if (!bitmap) throw new Error('Image decoding is unavailable in this browser');
  try {
    const sourceWidth = bitmap.naturalWidth ?? bitmap.width;
    const sourceHeight = bitmap.naturalHeight ?? bitmap.height;
    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : globalThis.document?.createElement('canvas');
    if (!canvas) throw new Error('Canvas is unavailable in this browser');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Cannot read image pixels');
    context.drawImage(bitmap, 0, 0, width, height);
    // ImageData exposes width, height and data through prototype accessors in
    // browsers. Spreading it drops all three and silently invalidates every
    // reference imported from a real PNG/JPEG Blob.
    const pixels = context.getImageData(0, 0, width, height);
    return { width: pixels.width, height: pixels.height, data: pixels.data,
      originalWidth: sourceWidth, originalHeight: sourceHeight };
  } finally {
    bitmap.close?.();
    if (objectUrl) globalThis.URL.revokeObjectURL(objectUrl);
  }
}

function integrals(image) {
  const stride = image.width + 1;
  const size = stride * (image.height + 1);
  const red = new Uint32Array(size);
  const green = new Uint32Array(size);
  const blue = new Uint32Array(size);
  const gray = new Uint32Array(size);
  for (let y = 1; y <= image.height; y++) {
    let rr = 0; let gg = 0; let bb = 0; let yy = 0;
    for (let x = 1; x <= image.width; x++) {
      const pixel = ((y - 1) * image.width + x - 1) * 4;
      rr += image.data[pixel];
      gg += image.data[pixel + 1];
      bb += image.data[pixel + 2];
      yy += (77 * image.data[pixel] + 150 * image.data[pixel + 1] +
        29 * image.data[pixel + 2]) >>> 8;
      const at = y * stride + x;
      const above = at - stride;
      red[at] = red[above] + rr;
      green[at] = green[above] + gg;
      blue[at] = blue[above] + bb;
      gray[at] = gray[above] + yy;
    }
  }
  return { red, green, blue, gray, stride };
}

function mean(integral, stride, x0, y0, x1, y1) {
  const total = integral[y1 * stride + x1] - integral[y0 * stride + x1] -
    integral[y1 * stride + x0] + integral[y0 * stride + x0];
  return total / ((x1 - x0) * (y1 - y0));
}

function signature(index, box) {
  const { x, y, width, height } = box;
  const luminance = new Float64Array(GRID * GRID);
  let sum = 0;
  let squared = 0;
  for (let row = 0; row < GRID; row++) {
    const y0 = y + Math.floor((row * height) / GRID);
    const y1 = y + Math.max(Math.floor(((row + 1) * height) / GRID),
      Math.floor((row * height) / GRID) + 1);
    for (let col = 0; col < GRID; col++) {
      const x0 = x + Math.floor((col * width) / GRID);
      const x1 = x + Math.max(Math.floor(((col + 1) * width) / GRID),
        Math.floor((col * width) / GRID) + 1);
      const value = mean(index.gray, index.stride, x0, y0, x1, y1);
      luminance[row * GRID + col] = value;
      sum += value;
      squared += value * value;
    }
  }
  const average = sum / luminance.length;
  const deviation = Math.sqrt(Math.max(0, squared / luminance.length - average * average));
  const vertical = new Float64Array(HASH_SIZE * GRID);
  for (let v = 0; v < HASH_SIZE; v++) {
    for (let col = 0; col < GRID; col++) {
      let value = 0;
      for (let row = 0; row < GRID; row++) {
        value += luminance[row * GRID + col] * cosine[v][row];
      }
      vertical[v * GRID + col] = value;
    }
  }
  const coefficients = [];
  for (let v = 0; v < HASH_SIZE; v++) {
    for (let u = 0; u < HASH_SIZE; u++) {
      if (u === 0 && v === 0) continue;
      let value = 0;
      for (let col = 0; col < GRID; col++) {
        value += vertical[v * GRID + col] * cosine[u][col];
      }
      coefficients.push(value);
    }
  }
  const sorted = [...coefficients].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let low = 0; let high = 0;
  for (let bit = 0; bit < coefficients.length; bit++) {
    if (coefficients[bit] > median) {
      if (bit < 32) low |= 1 << bit;
      else high |= 1 << (bit - 32);
    }
  }
  const color = new Float32Array(COLOR_GRID * COLOR_GRID * 3);
  for (let row = 0; row < COLOR_GRID; row++) {
    const y0 = y + Math.floor((row * height) / COLOR_GRID);
    const y1 = y + Math.floor(((row + 1) * height) / COLOR_GRID);
    for (let col = 0; col < COLOR_GRID; col++) {
      const x0 = x + Math.floor((col * width) / COLOR_GRID);
      const x1 = x + Math.floor(((col + 1) * width) / COLOR_GRID);
      const offset = (row * COLOR_GRID + col) * 3;
      color[offset] = mean(index.red, index.stride, x0, y0, x1, y1);
      color[offset + 1] = mean(index.green, index.stride, x0, y0, x1, y1);
      color[offset + 2] = mean(index.blue, index.stride, x0, y0, x1, y1);
    }
  }
  return { low: low >>> 0, high: high >>> 0, color, deviation };
}

function bitCount(number) {
  let value = number - ((number >>> 1) & 0x55555555);
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function similarity(left, right, floor = 0) {
  const distance = bitCount(left.low ^ right.low) + bitCount(left.high ^ right.high);
  const hashScore = 1 - distance / 63;
  // Color can contribute at most 0.22. Skip its 48-channel comparison when
  // even that upper bound cannot improve this reference's current best box.
  if (0.78 * hashScore + 0.22 <= floor) return null;
  let colorDistance = 0;
  for (let i = 0; i < left.color.length; i++) {
    colorDistance += Math.abs(left.color[i] - right.color[i]);
  }
  const colorScore = 1 - colorDistance / (left.color.length * 255);
  return { score: 0.78 * hashScore + 0.22 * colorScore,
    hashDistance: distance, colorScore };
}

/** Prepares one image without retaining its pixels. */
export async function prepareReference(blob, options = {}) {
  const cacheable = blob && typeof blob === 'object';
  const maxDimension = options.maxReferenceDimension ?? 480;
  const cached = cacheable ? referenceCache.get(blob) : undefined;
  if (cached?.maxDimension === maxDimension &&
      cached.decodeImage === options.decodeImage) return cached.value;
  const image = await decode(blob, maxDimension, options);
  if (image.width < 16 || image.height < 16) {
    throw new Error('Reference image is too small');
  }
  const value = {
    width: image.width,
    height: image.height,
    aspect: image.width / image.height,
    signature: signature(integrals(image),
      { x: 0, y: 0, width: image.width, height: image.height }),
  };
  if (cacheable) referenceCache.set(blob,
    { maxDimension, decodeImage: options.decodeImage, value });
  return value;
}

function positions(span, window, step) {
  const last = span - window;
  if (last <= 0) return [0];
  const values = [];
  for (let point = 0; point < last; point += step) values.push(point);
  values.push(last);
  return values;
}

function aspectKey(aspect) {
  return Math.round(Math.log(aspect) / Math.log(1.13));
}

async function scanCoarse(image, prepared, options) {
  const index = integrals(image);
  function consider(item, candidate, box) {
    const result = similarity(candidate, item.prepared.signature, item.best.score);
    if (result && result.score > item.best.score) {
      item.bestSourceBox = box;
      item.best = {
        score: result.score,
        box: {
          x: Math.round(box.x * image.originalWidth / image.width),
          y: Math.round(box.y * image.originalHeight / image.height),
          width: Math.round(box.width * image.originalWidth / image.width),
          height: Math.round(box.height * image.originalHeight / image.height),
        },
        evidence: { method: 'phash', hashDistance: result.hashDistance,
          colorScore: Number(result.colorScore.toFixed(3)),
          variantId: item.variantId },
      };
    }
  }
  const groups = new Map();
  for (const item of prepared) {
    const key = aspectKey(item.prepared.aspect);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
    item.best = { score: 0, box: null, evidence: { method: 'phash' } };
  }
  let groupIndex = 0;
  let windowCount = 0;
  for (const [key, entries] of groups) {
    groupIndex++;
    const aspect = Math.pow(1.13, key);
    const maximum = Math.floor(Math.min(image.width, image.height * aspect));
    const minimum = Math.max(48, Math.ceil(48 * aspect),
      Math.floor(Math.min(image.width, image.height) * 0.07));
    const widths = [];
    for (let width = minimum; width <= maximum; width = Math.max(width + 1, Math.round(width * 1.32))) {
      widths.push(width);
    }
    if (maximum >= minimum && widths.at(-1) !== maximum) widths.push(maximum);
    if (Math.abs(image.width / image.height - aspect) / aspect < 0.16) {
      widths.push(image.width);
    }
    const seen = new Set();
    for (const candidateWidth of widths) {
      const width = Math.min(image.width, candidateWidth);
      const height = Math.min(image.height, Math.round(width / aspect));
      if (width < 16 || height < 16 || seen.has(`${width}x${height}`)) continue;
      seen.add(`${width}x${height}`);
      const xs = positions(image.width, width, Math.max(10, Math.round(width * 0.26)));
      const ys = positions(image.height, height, Math.max(10, Math.round(height * 0.26)));
      for (const y of ys) {
        for (const x of xs) {
          windowCount++;
          const candidate = signature(index, { x, y, width, height });
          if (windowCount % 128 === 0) await yieldTask();
          if (candidate.deviation < 7) continue;
          for (const item of entries) {
            consider(item, candidate, { x, y, width, height });
          }
        }
      }
    }
    // Coarse strides make scanning affordable on a phone. Refine only the most
    // plausible references at pixel precision so a small card is not missed.
    const leaders = [...entries].sort((a, b) => b.best.score - a.best.score).slice(0, 12);
    for (const item of leaders) {
      if (!item.bestSourceBox) continue;
      const initial = item.bestSourceBox;
      for (let y = Math.max(0, initial.y - Math.round(initial.height * 0.13));
        y <= Math.min(image.height - initial.height, initial.y + Math.round(initial.height * 0.13)); y += 2) {
        for (let x = Math.max(0, initial.x - Math.round(initial.width * 0.13));
          x <= Math.min(image.width - initial.width, initial.x + Math.round(initial.width * 0.13)); x += 2) {
          const box = { x, y, width: initial.width, height: initial.height };
          const candidate = signature(index, box);
          if (candidate.deviation >= 7) consider(item, candidate, box);
        }
      }
      const shifted = item.bestSourceBox;
      for (let width = Math.max(16, shifted.width - 3);
        width <= Math.min(image.width, shifted.width + 3); width++) {
        const height = Math.round(width / item.prepared.aspect);
        if (height < 16 || height > image.height) continue;
        for (let y = Math.max(0, shifted.y - 2); y <= Math.min(image.height - height, shifted.y + 2); y++) {
          for (let x = Math.max(0, shifted.x - 2); x <= Math.min(image.width - width, shifted.x + 2); x++) {
            const box = { x, y, width, height };
            const candidate = signature(index, box);
            if (candidate.deviation >= 7) consider(item, candidate, box);
          }
        }
      }
      await yieldTask();
    }
    report(options, 'coarse', groupIndex, groups.size);
  }
  return windowCount;
}

function safeDelete(value) {
  try { value?.delete?.(); } catch { /* Best-effort cleanup of OpenCV WASM allocations. */ }
}

function createOrb(cv) {
  try {
    if (typeof cv.ORB?.create === 'function') return cv.ORB.create(900);
    if (typeof cv.ORB === 'function') return new cv.ORB(900);
  } catch { /* OpenCV builds expose different constructors. */ }
  return null;
}

function extractOrb(cv, image, orb) {
  const rgba = cv.matFromImageData({ width: image.width, height: image.height,
    data: new Uint8ClampedArray(image.data) });
  const gray = new cv.Mat();
  const mask = new cv.Mat();
  const points = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    orb.detectAndCompute(gray, mask, points, descriptors);
    return { points, descriptors };
  } catch (error) {
    safeDelete(points); safeDelete(descriptors);
    throw error;
  } finally {
    safeDelete(rgba); safeDelete(gray); safeDelete(mask);
  }
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    area += points[i].x * next.y - next.x * points[i].y;
  }
  return Math.abs(area) / 2;
}

function projectHomography(matrix, width, height) {
  const data = matrix.data64F?.length >= 9 ? matrix.data64F : matrix.data32F;
  if (!data || data.length < 9) return null;
  return [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => {
    const divisor = data[6] * x + data[7] * y + data[8];
    return { x: (data[0] * x + data[1] * y + data[2]) / divisor,
      y: (data[3] * x + data[4] * y + data[5]) / divisor };
  });
}

function geometricMatch(cv, source, reference, image, refImage) {
  if (source.descriptors.empty?.() || reference.descriptors.empty?.() ||
      source.points.size() < 12 || reference.points.size() < 12) return null;
  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const pairs = new cv.DMatchVectorVector();
  const sourcePoints = [];
  const referencePoints = [];
  try {
    matcher.knnMatch(reference.descriptors, source.descriptors, pairs, 2);
    const usedSource = new Set();
    for (let i = 0; i < pairs.size(); i++) {
      const pair = pairs.get(i);
      try {
        if (pair.size() < 2) continue;
        const best = pair.get(0);
        const runnerUp = pair.get(1);
        if (best.distance > 70 || best.distance >= 0.75 * runnerUp.distance ||
            usedSource.has(best.trainIdx)) continue;
        usedSource.add(best.trainIdx);
        const from = reference.points.get(best.queryIdx).pt;
        const to = source.points.get(best.trainIdx).pt;
        referencePoints.push(from.x, from.y);
        sourcePoints.push(to.x, to.y);
      } finally { safeDelete(pair); }
    }
    if (referencePoints.length < 24) return null;
    const refXs = referencePoints.filter((_, i) => i % 2 === 0);
    const refYs = referencePoints.filter((_, i) => i % 2 === 1);
    if (Math.max(...refXs) - Math.min(...refXs) < refImage.width * 0.2 ||
        Math.max(...refYs) - Math.min(...refYs) < refImage.height * 0.2) return null;
    const from = cv.matFromArray(referencePoints.length / 2, 1, cv.CV_32FC2, referencePoints);
    const to = cv.matFromArray(sourcePoints.length / 2, 1, cv.CV_32FC2, sourcePoints);
    const inlierMask = new cv.Mat();
    let homography;
    try {
      homography = cv.findHomography(from, to, cv.RANSAC, 3, inlierMask);
      if (!homography || homography.empty?.()) return null;
      const inliers = Array.from(inlierMask.data ?? []).reduce((count, value) => count + (value ? 1 : 0), 0);
      const count = referencePoints.length / 2;
      const ratio = inliers / count;
      if (inliers < 12 || ratio < 0.55) return null;
      const corners = projectHomography(homography, refImage.width, refImage.height);
      if (!corners || corners.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
      const toleranceX = image.width * 0.1;
      const toleranceY = image.height * 0.1;
      if (corners.some(point => point.x < -toleranceX || point.x > image.width + toleranceX ||
          point.y < -toleranceY || point.y > image.height + toleranceY)) return null;
      const area = polygonArea(corners);
      if (area < image.width * image.height * 0.0015 || area > image.width * image.height * 0.9) return null;
      const xs = corners.map(point => point.x);
      const ys = corners.map(point => point.y);
      const x0 = Math.max(0, Math.min(...xs));
      const y0 = Math.max(0, Math.min(...ys));
      const x1 = Math.min(image.width, Math.max(...xs));
      const y1 = Math.min(image.height, Math.max(...ys));
      return {
        score: Math.min(0.99, 0.83 + 0.08 * Math.min(1, inliers / 25) + 0.06 * ratio),
        box: { x: Math.round(x0 * image.originalWidth / image.width),
          y: Math.round(y0 * image.originalHeight / image.height),
          width: Math.round((x1 - x0) * image.originalWidth / image.width),
          height: Math.round((y1 - y0) * image.originalHeight / image.height) },
        evidence: { method: 'orb', inliers, correspondences: count,
          inlierRatio: Number(ratio.toFixed(3)) },
      };
    } finally {
      safeDelete(from); safeDelete(to); safeDelete(inlierMask); safeDelete(homography);
    }
  } finally { safeDelete(pairs); safeDelete(matcher); }
}

async function scanOrb(cv, image, prepared, options) {
  const info = { available: false, checked: 0, matches: 0 };
  if (!hasOpenCvFeatures(cv)) return info;
  const orb = createOrb(cv);
  if (!orb) return info;
  info.available = true;
  let source;
  try {
    source = extractOrb(cv, image, orb);
    // A bounded candidate set keeps a 130-image pack from running 130 costly
    // ORB decodes and matcher passes on an iPhone. Weak or ambiguous coarse
    // evidence remains uncertain instead of being promoted to a guess.
    const limit = Math.max(1, Math.min(prepared.length,
      Math.floor(options.maxOrbReferences ?? 32)));
    const ordered = [...prepared]
      .sort((a, b) => b.best.score - a.best.score)
      .slice(0, limit);
    for (let i = 0; i < ordered.length; i++) {
      const item = ordered[i];
      let reference;
      try {
        info.checked++;
        const refImage = await decode(item.blob, options.maxReferenceDimension ?? 480, options);
        reference = extractOrb(cv, refImage, orb);
        const result = geometricMatch(cv, source, reference, image, refImage);
        if (result) {
          info.matches++;
          // A verified homography is stronger evidence than a coarse visual
          // hash, even when the latter scores 1 on an exact reference crop.
          item.best = { ...result, score: Math.max(result.score, item.best.score),
            evidence: { ...result.evidence,
            variantId: item.variantId } };
        }
      } catch { /* OpenCV failure on one image must not hide the coarse result. */ }
      finally { safeDelete(reference?.points); safeDelete(reference?.descriptors); }
      report(options, 'orb', i + 1, ordered.length);
      if ((i + 1) % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  } catch { /* A partial or incompatible OpenCV.js build leaves JS matching available. */ }
  finally { safeDelete(source?.points); safeDelete(source?.descriptors); safeDelete(orb); }
  return info;
}

function rank(prepared, options, orbInfo) {
  const byHero = new Map();
  for (const item of prepared) {
    const previous = byHero.get(item.heroId);
    if (!previous || item.best.score > previous.score) {
      byHero.set(item.heroId, { heroId: item.heroId,
        score: Number(item.best.score.toFixed(4)),
        box: item.best.box,
        evidence: item.best.evidence });
    }
  }
  const all = [...byHero.values()].sort((a, b) => b.score - a.score);
  const minimumCandidateScore = options.minCandidateScore ?? 0.72;
  const matches = all.filter(item => item.score >= minimumCandidateScore).slice(0, 3);
  const best = all[0];
  const second = all[1];
  const threshold = best?.evidence.method === 'orb'
    ? (options.orbMatchThreshold ?? 0.89)
    : (options.matchThreshold ?? (orbInfo.available ? 0.96 : 0.88));
  const margin = options.matchMargin ?? (orbInfo.available &&
    best?.evidence.method !== 'orb' ? 0.06 : 0.045);
  const confident = best && best.score >= threshold &&
    (!second || best.score - second.score >= margin);
  return { status: confident ? 'match' : 'uncertain', matches,
    reason: confident ? 'confident_match' : 'insufficient_evidence' };
}

/**
 * Locate and rank a card or artwork inside an entire photo/screenshot.
 * options.decodeImage(blob) may be injected for tests; production uses local Canvas.
 */
export async function recognizeImage(imageBlob, references, options = {}) {
  const startedAt = nowMs();
  if (!Array.isArray(references) || references.length === 0) {
    return { status: 'unavailable', matches: [], reason: 'no_references' };
  }
  let image;
  try {
    image = await decode(imageBlob, options.maxImageDimension ?? 960, options);
    if (image.width < 16 || image.height < 16) throw new Error('Input image is too small');
  } catch {
    return { status: 'unavailable', matches: [], reason: 'image_decode_failed' };
  }
  const prepared = [];
  for (let i = 0; i < references.length; i++) {
    const reference = references[i];
    if (!reference?.heroId || !reference?.blob) continue;
    try {
      const value = await prepareReference(reference.blob, options);
      if (value.signature.deviation >= 7) {
        prepared.push({ heroId: String(reference.heroId),
          variantId: reference.variantId ?? null,
          blob: reference.blob, prepared: value });
      }
    } catch { /* Invalid files from an imported pack are skipped. */ }
    report(options, 'references', i + 1, references.length);
    if ((i + 1) % 8 === 0) await yieldTask();
  }
  if (prepared.length === 0) {
    return { status: 'unavailable', matches: [], reason: 'no_usable_references' };
  }
  const prepareMs = Math.round(nowMs() - startedAt);
  // Begin loading the local WASM build while the pure JS locator scans. Tests
  // can pass a specific cv implementation, including null to exercise JS only.
  const cvPromise = options.cv !== undefined
    ? Promise.resolve({ cv: options.cv }) : loadLocalOpenCv();
  const coarseStartedAt = nowMs();
  const coarseWindows = await scanCoarse(image, prepared, options);
  const coarseMs = Math.round(nowMs() - coarseStartedAt);
  const cvWaitStartedAt = nowMs();
  const { cv } = await cvPromise;
  const cvWaitMs = Math.round(nowMs() - cvWaitStartedAt);
  const orbStartedAt = nowMs();
  const orbInfo = await scanOrb(cv, image, prepared, options);
  const orbMs = Math.round(nowMs() - orbStartedAt);
  return { ...rank(prepared, options, orbInfo),
    diagnostics: {
      elapsedMs: Math.round(nowMs() - startedAt),
      prepareMs,
      coarseMs,
      cvWaitMs,
      orbMs,
      opencvMs: cvWaitMs + orbMs,
      referenceCount: prepared.length,
      coarseWindows,
      orbAvailable: orbInfo.available,
      orbChecked: orbInfo.checked,
      orbMatched: orbInfo.matches,
    } };
}
