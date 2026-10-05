/**
 * Optional, entirely same-origin Chinese OCR for close visual matches.
 * Importing this module does not load the OCR engine. Call it only after the
 * image matcher has produced ambiguous candidates; never use OCR alone to
 * promote an otherwise weak image match.
 */

const ENGINE_URL = new URL('../vendor/tesseract/tesseract.esm.min.js', import.meta.url);
const WORKER_URL = new URL('../vendor/tesseract/worker.min.js', import.meta.url);
const CORE_URL = new URL('../vendor/tesseract/core/', import.meta.url);
const LANGUAGE_URL = new URL('../vendor/tesseract/lang/', import.meta.url);

const now = () => globalThis.performance?.now?.() ?? Date.now();

class OcrTimeoutError extends Error {
  constructor() { super('Local OCR timed out'); }
}

function localPaths() {
  const urls = [ENGINE_URL, WORKER_URL, CORE_URL, LANGUAGE_URL];
  if (globalThis.location && urls.some(url => url.origin !== globalThis.location.origin)) {
    throw new Error('OCR assets must be served from the application origin');
  }
  return {
    workerPath: WORKER_URL.href,
    corePath: CORE_URL.href,
    langPath: LANGUAGE_URL.href,
  };
}

function waitUntil(promise, deadline) {
  const remaining = deadline - now();
  if (remaining <= 0) return Promise.reject(new OcrTimeoutError());
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new OcrTimeoutError()), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

function normalizedLine(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, '').toLocaleLowerCase('zh-CN');
}

/**
 * A literal name in one OCR line may separate close visual candidates.
 * The return value is null for weak OCR, partial names, or multiple hits.
 * candidates: [{ heroId, name, aliases? }]
 */
export function chooseChineseNameCandidate(ocr, candidates, options = {}) {
  if (ocr?.status !== 'ok' || !Array.isArray(candidates)) return null;
  const confidence = Number(ocr.confidence);
  if (!Number.isFinite(confidence) || confidence < (options.minConfidence ?? 35)) return null;
  const lines = String(ocr.text ?? '').split(/\r?\n/).map(normalizedLine).filter(Boolean);
  const hits = [];
  for (const candidate of candidates) {
    if (!candidate?.heroId) continue;
    const names = [candidate.name, ...(candidate.aliases ?? [])]
      .map(normalizedLine).filter(name => [...name].length >= 2);
    const matchedName = names.find(name => lines.some(line => line.includes(name)));
    if (matchedName) hits.push({ heroId: String(candidate.heroId), matchedName, confidence });
  }
  if (hits.length !== 1) return null;
  const hit = hits[0];
  return { matchedHeroId: hit.heroId,
    evidence: { method: 'ocr_name', matchedName: hit.matchedName,
      confidence: hit.confidence } };
}

/** Keep OCR out of routine and weak-image recognition. */
export function isOcrTieEligible(result, options = {}) {
  if (result?.status !== 'uncertain' || !Array.isArray(result.matches) ||
      result.matches.length < 2) return false;
  const [first, second] = result.matches;
  const firstScore = Number(first?.score);
  const secondScore = Number(second?.score);
  const orbAvailable = result.diagnostics?.orbAvailable !== false;
  const thresholdFor = match => match?.evidence?.method === 'orb'
    ? (options.orbMatchThreshold ?? 0.89)
    : (orbAvailable ? (options.phashWithOrbThreshold ?? 0.96)
      : (options.phashWithoutOrbThreshold ?? 0.88));
  return Number.isFinite(firstScore) && Number.isFinite(secondScore) &&
    firstScore >= secondScore &&
    firstScore >= thresholdFor(first) && secondScore >= thresholdFor(second) &&
    firstScore - secondScore <= (options.maxVisualGap ?? 0.045);
}

/**
 * Crop near the shared visual location of the two tied candidates. The extra
 * room below the art includes a card label without reading the whole screen.
 * A weak or spatially inconsistent pair must not trigger OCR.
 */
export function ocrBoxForTie(result, options = {}) {
  if (!isOcrTieEligible(result, options)) return null;
  const [first, second] = result.matches;
  const validBox = box => box && [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
    box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0;
  const a = first.box; const b = second.box;
  if (!validBox(a) || !validBox(b)) return null;
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const iou = intersection / (areaA + areaB - intersection);
  if (!Number.isFinite(iou) || iou < (options.minBoxIoU ?? 0.5)) return null;
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  const width = right - left;
  const height = bottom - top;
  const padX = width * 0.08;
  const padTop = height * 0.08;
  const padBottom = height * 0.35;
  return { x: Math.max(0, Math.floor(left - padX)),
    y: Math.max(0, Math.floor(top - padTop)),
    width: Math.ceil(width + 2 * padX),
    height: Math.ceil(height + padTop + padBottom) };
}

/**
 * Promote one of the two close image matches only when OCR spells exactly one
 * complete displayed hero name with high confidence. The visual score is never changed.
 * heroes is the versioned catalog's hero array.
 */
export function applyOcrTieBreak(result, heroes, ocr, options = {}) {
  if (!ocrBoxForTie(result, options) || !Array.isArray(heroes)) return result;
  const byId = new Map(heroes.map(hero => [String(hero.id), hero]));
  const candidates = result.matches.slice(0, 3).map(match => {
    const hero = byId.get(String(match.heroId));
    return { heroId: match.heroId, name: hero?.name, aliases: hero?.aliases };
  });
  const hit = chooseChineseNameCandidate(ocr, candidates,
    { minConfidence: options.minOcrConfidence ?? 75 });
  if (!hit) return result;
  const originalRank = result.matches.findIndex(
    match => String(match.heroId) === hit.matchedHeroId);
  if (originalRank < 0 || originalRank > 1) return result;
  const matches = [...result.matches];
  const [selected] = matches.splice(originalRank, 1);
  matches.unshift({ ...selected, evidence: {
    ...selected.evidence,
    visualScore: selected.score,
    visualRank: originalRank + 1,
    ocr: hit.evidence,
  } });
  return { ...result, status: 'match', reason: 'ocr_tiebreak', matches };
}

async function prepareInput(blob, box, maxDimension) {
  if (!globalThis.document || !globalThis.URL?.createObjectURL) return blob;
  let image;
  let objectUrl;
  try {
    if (typeof globalThis.createImageBitmap === 'function') {
      try { image = await globalThis.createImageBitmap(blob); } catch { /* Safari image fallback. */ }
    }
    if (!image) {
      objectUrl = globalThis.URL.createObjectURL(blob);
      image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('OCR image could not be decoded'));
        element.src = objectUrl;
      });
    }
    const sourceWidth = image.naturalWidth ?? image.width;
    const sourceHeight = image.naturalHeight ?? image.height;
    let x = 0; let y = 0; let width = sourceWidth; let height = sourceHeight;
    if (box && [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
        box.width > 0 && box.height > 0) {
      x = Math.max(0, Math.min(sourceWidth - 1, Math.floor(box.x)));
      y = Math.max(0, Math.min(sourceHeight - 1, Math.floor(box.y)));
      width = Math.max(1, Math.min(sourceWidth - x, Math.ceil(box.width)));
      height = Math.max(1, Math.min(sourceHeight - y, Math.ceil(box.height)));
    }
    if (x === 0 && y === 0 && width === sourceWidth && height === sourceHeight &&
        Math.max(width, height) <= maxDimension) return blob;
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('OCR canvas is unavailable');
    context.drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(
      result => result ? resolve(result) : reject(new Error('OCR crop failed')), 'image/png'));
  } finally {
    image?.close?.();
    if (objectUrl) globalThis.URL.revokeObjectURL(objectUrl);
  }
}
/**
 * Recognize image text without uploading it. The engine, worker, WASM and
 * chi_sim model are explicit local paths and the worker is always terminated.
 * A timeout or missing runtime returns unavailable; it never guesses a hero.
 */
export async function recognizeChineseText(imageBlob, options = {}) {
  const started = now();
  const timeoutMs = Math.max(1, Math.min(30000, Number(options.timeoutMs) || 12000));
  const deadline = started + timeoutMs;
  if (!(imageBlob instanceof Blob) || imageBlob.size === 0) {
    return { status: 'unavailable', text: '', confidence: 0, reason: 'invalid_image', elapsedMs: 0 };
  }
  let worker;
  let finished = false;
  try {
    const paths = localPaths();
    const input = await waitUntil(prepareInput(imageBlob, options.box, options.maxDimension ?? 1800), deadline);
    const engine = options.workerFactory ? null :
      await waitUntil(import(ENGINE_URL.href), deadline);
    const factory = options.workerFactory ?? engine?.createWorker ?? engine?.default?.createWorker;
    if (typeof factory !== 'function') throw new Error('Local OCR engine is unavailable');
    const pendingWorker = Promise.resolve(factory('chi_sim', 1, {
      ...paths,
      workerBlobURL: false,
      cacheMethod: 'none',
      logger(message) {
        try { options.onProgress?.(message); } catch { /* Progress is advisory. */ }
      },
    }));
    // A late successful initialization must not leave a worker running after
    // a timeout. Tesseract.js does not offer an initialization abort signal.
    pendingWorker.then(lateWorker => {
      if (finished) {
        try { void Promise.resolve(lateWorker?.terminate?.()).catch(() => {}); }
        catch { /* Worker initialization timed out and cleanup is best effort. */ }
      }
    }, () => {});
    worker = await waitUntil(pendingWorker, deadline);
    const output = await waitUntil(worker.recognize(input), deadline);
    const confidence = Number(output?.data?.confidence);
    return {
      status: 'ok',
      text: String(output?.data?.text ?? '').slice(0, 10000),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : 0,
      elapsedMs: Math.round(now() - started),
    };
  } catch (error) {
    try { options.onError?.(error); } catch { /* Diagnostics are advisory. */ }
    return {
      status: 'unavailable', text: '', confidence: 0,
      reason: error instanceof OcrTimeoutError ? 'timeout' : 'ocr_failed',
      elapsedMs: Math.round(now() - started),
    };
  } finally {
    finished = true;
    try { await worker?.terminate?.(); } catch { /* Best-effort worker cleanup. */ }
  }
}

