import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOcrTieBreak, chooseChineseNameCandidate,
  isOcrTieEligible, ocrBoxForTie, recognizeChineseText } from '../src/ocr.mjs';

const image = new Blob(['test-image'], { type: 'image/png' });

test('OCR only selects one complete candidate name with sufficient confidence', () => {
  const candidates = [
    { heroId: 'ahri', name: '阿狸' },
    { heroId: 'ashe', name: '艾希' },
  ];
  assert.equal(chooseChineseNameCandidate(
    { status: 'ok', text: '费用 4\n角色：阿 狸', confidence: 82 }, candidates)?.matchedHeroId, 'ahri');
  assert.equal(chooseChineseNameCandidate(
    { status: 'ok', text: '角色：阿', confidence: 95 }, candidates), null);
  assert.equal(chooseChineseNameCandidate(
    { status: 'ok', text: '阿狸\n艾希', confidence: 95 }, candidates), null);
  assert.equal(chooseChineseNameCandidate(
    { status: 'ok', text: '阿狸', confidence: 20 }, candidates), null);
});

test('strong close visual candidates can be resolved by a unique high-confidence name', () => {
  const result = { status: 'uncertain', reason: 'insufficient_evidence',
    diagnostics: { orbAvailable: true }, matches: [
    { heroId: 'ahri', score: 0.975, box: { x: 50, y: 60, width: 100, height: 120 },
      evidence: { method: 'phash' } },
    { heroId: 'ashe', score: 0.967, box: { x: 55, y: 62, width: 100, height: 120 },
      evidence: { method: 'orb', inliers: 14 } },
    { heroId: 'third', score: 0.71, evidence: { method: 'phash' } },
  ] };
  const heroes = [{ id: 'ahri', name: '阿狸' }, { id: 'ashe', name: '艾希' }];
  assert.equal(isOcrTieEligible(result), true);
  assert.deepEqual(ocrBoxForTie(result), { x: 41, y: 50, width: 122, height: 175 });
  const resolved = applyOcrTieBreak(result, heroes,
    { status: 'ok', text: '艾希', confidence: 91 });
  assert.equal(resolved.status, 'match');
  assert.equal(resolved.reason, 'ocr_tiebreak');
  assert.equal(resolved.matches[0].heroId, 'ashe');
  assert.equal(resolved.matches[0].score, 0.967);
  assert.deepEqual(resolved.matches[0].evidence, {
    method: 'orb', inliers: 14, visualScore: 0.967, visualRank: 2,
    ocr: { method: 'ocr_name', matchedName: '艾希', confidence: 91 },
  });
  assert.equal(result.matches[0].heroId, 'ahri');
});

test('weak, distant, or ambiguous evidence stays uncertain', () => {
  const heroes = [{ id: 'ahri', name: '阿狸' }, { id: 'ashe', name: '艾希' }];
  const box = { x: 10, y: 10, width: 100, height: 100 };
  const base = { status: 'uncertain', diagnostics: { orbAvailable: false }, matches: [
    { heroId: 'ahri', score: 0.91, box }, { heroId: 'ashe', score: 0.90, box },
  ] };
  const high = { status: 'ok', text: '艾希', confidence: 91 };
  assert.equal(applyOcrTieBreak({ ...base, matches: [
    { heroId: 'ahri', score: 0.87, box }, { heroId: 'ashe', score: 0.86, box },
  ] }, heroes, high).status, 'uncertain');
  assert.equal(applyOcrTieBreak({ ...base, matches: [
    { heroId: 'ahri', score: 0.96, box }, { heroId: 'ashe', score: 0.89, box },
  ] }, heroes, high).status, 'uncertain');
  assert.equal(applyOcrTieBreak(base, heroes,
    { status: 'ok', text: '艾希', confidence: 60 }), base);
  assert.equal(applyOcrTieBreak(base, heroes,
    { status: 'ok', text: '阿狸\n艾希', confidence: 91 }), base);
  assert.equal(applyOcrTieBreak(base, heroes,
    { status: 'unavailable', text: '', confidence: 0 }), base);
});

test('OpenCV availability raises the pHash OCR gate', () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };
  const result = { status: 'uncertain', diagnostics: { orbAvailable: true }, matches: [
    { heroId: 'ahri', score: 0.92, box, evidence: { method: 'phash' } },
    { heroId: 'ashe', score: 0.91, box, evidence: { method: 'phash' } },
  ] };
  assert.equal(isOcrTieEligible(result), false);
  assert.equal(ocrBoxForTie(result), null);
  assert.equal(applyOcrTieBreak(result,
    [{ id: 'ahri', name: '阿狸' }, { id: 'ashe', name: '艾希' }],
    { status: 'ok', text: '艾希', confidence: 95 }), result);
});

test('spatial disagreement and a third candidate name prevent promotion', () => {
  const result = { status: 'uncertain', diagnostics: { orbAvailable: false }, matches: [
    { heroId: 'ahri', score: 0.93, box: { x: 10, y: 10, width: 100, height: 100 } },
    { heroId: 'ashe', score: 0.92, box: { x: 30, y: 10, width: 100, height: 100 } },
    { heroId: 'third', score: 0.76, box: { x: 300, y: 10, width: 100, height: 100 } },
  ] };
  const heroes = [
    { id: 'ahri', name: '阿狸' }, { id: 'ashe', name: '艾希' },
    { id: 'third', name: '卡尔玛' },
  ];
  assert.ok(ocrBoxForTie(result));
  assert.equal(applyOcrTieBreak(result, heroes,
    { status: 'ok', text: '艾希\n卡尔玛', confidence: 92 }), result);
  const farApart = { ...result, matches: [result.matches[0],
    { ...result.matches[1], box: { x: 150, y: 10, width: 100, height: 100 } },
    result.matches[2]] };
  assert.equal(ocrBoxForTie(farApart), null);
  assert.equal(applyOcrTieBreak(farApart, heroes,
    { status: 'ok', text: '艾希', confidence: 92 }), farApart);
});

test('OCR factory receives same-app paths and worker is released', async () => {
  let terminated = false;
  let received;
  const result = await recognizeChineseText(image, {
    workerFactory: async (lang, oem, options) => {
      received = { lang, oem, options };
      return {
        recognize: async input => {
          assert.equal(input, image);
          return { data: { text: '阿狸', confidence: 83 } };
        },
        terminate: async () => { terminated = true; },
      };
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.text, '阿狸');
  assert.equal(result.confidence, 83);
  assert.equal(received.lang, 'chi_sim');
  assert.equal(received.oem, 1);
  for (const path of ['workerPath', 'corePath', 'langPath']) {
    assert.match(received.options[path], /^file:\/\/.*vendor\/tesseract\//);
  }
  assert.equal(received.options.workerBlobURL, false);
  assert.equal(received.options.cacheMethod, 'none');
  assert.equal(terminated, true);
});

test('OCR timeout remains uncertain and terminates an initialized worker', async () => {
  let terminated = false;
  const result = await recognizeChineseText(image, {
    timeoutMs: 5,
    workerFactory: async () => ({
      recognize: () => new Promise(() => {}),
      terminate: async () => { terminated = true; },
    }),
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'timeout');
  assert.equal(terminated, true);
});

test('a worker that initializes after timeout is terminated on arrival', async () => {
  let terminated = false;
  const result = await recognizeChineseText(image, {
    timeoutMs: 5,
    workerFactory: () => new Promise(resolve => setTimeout(() => resolve({
      terminate: async () => { terminated = true; },
    }), 15)),
  });
  assert.equal(result.reason, 'timeout');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(terminated, true);
});
