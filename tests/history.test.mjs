import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuizRecord, readQuizHistory, saveQuizRecord, getHistorySummary, QUIZ_HISTORY_STORAGE_KEY } from '../src/history.mjs';

function storageFixture(raw) {
  const values = new Map(raw === undefined ? [] : [[QUIZ_HISTORY_STORAGE_KEY, raw]]);
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function record(id = 'set-1', correctCount = 13, completedAt = '2026-10-05T10:00:00.000Z') {
  return createQuizRecord({ id, completedAt, seasonId: 's19', patch: '18.18.3', correctCount });
}

test('a completed quiz stores score and percentage from its twenty answers', () => {
  assert.deepEqual(record(), {
    id: 'set-1', completedAt: '2026-10-05T10:00:00.000Z', seasonId: 's19', patch: '18.18.3',
    correctCount: 13, totalQuestions: 20, score: 65, winRate: 65,
  });
  assert.equal(record('none', 0).winRate, 0);
  assert.equal(record('all', 20).score, 100);
  assert.throws(() => record('invalid', 21), RangeError);
  assert.throws(() => record('invalid', 1.5), RangeError);
  assert.throws(() => record('', 1), TypeError);
  assert.throws(() => record('invalid', 1, '2026-02-31T10:00:00.000Z'), TypeError);
  assert.throws(() => record('invalid', 1, 'tomorrow'), TypeError);
});

test('saved quizzes survive a fresh read and are sorted by completion time', () => {
  const storage = storageFixture();
  assert.deepEqual(readQuizHistory(storage), []);
  assert.equal(saveQuizRecord(record('later', 15, '2026-10-05T11:00:00.000Z'), storage).persisted, true);
  const saved = saveQuizRecord(record('earlier', 10), storage);
  assert.deepEqual(saved.records.map(item => item.id), ['earlier', 'later']);
  assert.deepEqual(readQuizHistory(storage), saved.records);
  assert.equal(JSON.parse(storage.getItem(QUIZ_HISTORY_STORAGE_KEY)).schemaVersion, 1);
});

test('duplicate set IDs do not add another completed set or replace the first result', () => {
  const storage = storageFixture();
  saveQuizRecord(record('same', 8), storage);
  const saved = saveQuizRecord(record('same', 20), storage);
  assert.equal(saved.records.length, 1);
  assert.equal(saved.records[0].correctCount, 8);
  assert.equal(getHistorySummary([...saved.records, saved.records[0]]).completedSets, 1);
});

test('history summaries calculate a cumulative answer rate and retain the highest score', () => {
  assert.deepEqual(getHistorySummary([]), { completedSets: 0, totalCorrect: 0, totalQuestions: 0, winRate: 0, bestScore: 0 });
  assert.deepEqual(getHistorySummary([record('a', 0), record('b', 12), record('c', 20)]), {
    completedSets: 3, totalCorrect: 32, totalQuestions: 60, winRate: 32 / 60 * 100, bestScore: 100,
  });
});

test('damaged JSON and unknown schemas produce empty history; invalid records are skipped', () => {
  assert.deepEqual(readQuizHistory(storageFixture('{broken')), []);
  assert.deepEqual(readQuizHistory(storageFixture(JSON.stringify({ schemaVersion: 2, records: [record()] }))), []);
  const invalid = [null, {}, { ...record('bad-count'), correctCount: -1 }, { ...record('bad-total'), totalQuestions: 10 }, { ...record('bad-rate'), winRate: 500 }];
  const storage = storageFixture(JSON.stringify({ schemaVersion: 1, records: [...invalid, record('good'), record('good')] }));
  assert.deepEqual(readQuizHistory(storage).map(item => item.id), ['good']);
  const result = saveQuizRecord({ ...record('bad'), score: 99 }, storage);
  assert.equal(result.persisted, false);
  assert.deepEqual(result.records.map(item => item.id), ['good']);
  assert.deepEqual(readQuizHistory(storage).map(item => item.id), ['good']);
});

test('unavailable storage and quota failures keep answer completion usable', () => {
  const next = record('next');
  const unavailable = saveQuizRecord(next, null);
  assert.equal(unavailable.persisted, false);
  assert.deepEqual(unavailable.records, [next]);
  const storage = storageFixture(JSON.stringify({ schemaVersion: 1, records: [record('previous')] }));
  storage.setItem = () => { throw new Error('Quota exceeded'); };
  const failed = saveQuizRecord(next, storage);
  assert.equal(failed.persisted, false);
  assert.equal(failed.error, 'Quota exceeded');
  assert.equal(failed.records.length, 2);
  assert.equal(readQuizHistory(storage).length, 1);
  assert.deepEqual(readQuizHistory({ getItem: () => { throw new Error('Disabled'); }, setItem() {} }), []);
});

test('a throwing localStorage getter is caught by both default-storage APIs', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
  try {
    assert.deepEqual(readQuizHistory(), []);
    const result = saveQuizRecord(record());
    assert.equal(result.persisted, false);
    assert.equal(result.error, 'Storage blocked');
    assert.equal(result.records.length, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('history preserves more than one thousand sets so cumulative totals never silently reset', () => {
  const records = Array.from({ length: 1001 }, (_, i) => record(`set-${i}`, 10));
  const storage = storageFixture(JSON.stringify({ schemaVersion: 1, records }));
  const result = saveQuizRecord(record('latest', 20), storage);
  assert.equal(result.persisted, true);
  assert.equal(result.records.length, 1002);
  assert.equal(getHistorySummary(readQuizHistory(storage)).totalQuestions, 20040);
});
