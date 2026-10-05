import { QUESTIONS_PER_QUIZ, POINTS_PER_QUESTION } from './quiz.mjs';

export const QUIZ_HISTORY_STORAGE_KEY = 'shovel-card-finder.quiz-history.v1';
const SCHEMA_VERSION = 1;

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

/** Build one completed set. Rates are percentages from 0 to 100. */
export function createQuizRecord({ id, completedAt, seasonId, patch, correctCount } = {}) {
  if (!Number.isInteger(correctCount) || correctCount < 0 || correctCount > QUESTIONS_PER_QUIZ) {
    throw new RangeError(`correctCount must be an integer from 0 to ${QUESTIONS_PER_QUIZ}`);
  }
  const timestamp = requiredText(completedAt, 'completedAt');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) {
    throw new TypeError('completedAt must be an ISO timestamp');
  }
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new TypeError('completedAt must be a valid timestamp');
  // Date parsing silently rolls invalid calendar dates (for example February 31) forward.
  const calendarDate = new Date(`${timestamp.slice(0, 10)}T00:00:00.000Z`);
  if (calendarDate.toISOString().slice(0, 10) !== timestamp.slice(0, 10)) {
    throw new TypeError('completedAt must contain a valid calendar date');
  }
  return {
    id: requiredText(id, 'id'),
    completedAt: date.toISOString(),
    seasonId: requiredText(seasonId, 'seasonId'),
    patch: requiredText(patch, 'patch'),
    correctCount,
    totalQuestions: QUESTIONS_PER_QUIZ,
    score: correctCount * POINTS_PER_QUESTION,
    winRate: correctCount * 100 / QUESTIONS_PER_QUIZ,
  };
}

function validateRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid quiz record');
  const record = createQuizRecord(value);
  if (value.totalQuestions !== record.totalQuestions || value.score !== record.score || value.winRate !== record.winRate) {
    throw new TypeError('Quiz record totals do not match its correct answers');
  }
  return record;
}

function validRecords(values) {
  if (!Array.isArray(values)) return [];
  const recordsById = new Map();
  for (const value of values) {
    try {
      const record = validateRecord(value);
      if (!recordsById.has(record.id)) recordsById.set(record.id, record);
    } catch { /* Ignore malformed records without losing the remaining history. */ }
  }
  return [...recordsById.values()].sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.id.localeCompare(b.id));
}

function resolveStorage(storage) {
  const resolved = storage === undefined ? globalThis.localStorage : storage;
  if (!resolved || typeof resolved.getItem !== 'function' || typeof resolved.setItem !== 'function') {
    throw new TypeError('Local storage is unavailable');
  }
  return resolved;
}

function loadRecords(storage) {
  const raw = storage.getItem(QUIZ_HISTORY_STORAGE_KEY);
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const saved = JSON.parse(raw);
    return saved?.schemaVersion === SCHEMA_VERSION ? validRecords(saved.records) : [];
  } catch { return []; }
}

/** Read every valid completed set; refreshes and application updates use the same key. */
export function readQuizHistory(storage) {
  try { return loadRecords(resolveStorage(storage)); }
  catch { return []; }
}

/** Saving the same set ID again is idempotent. Failed writes still return the new records for this session. */
export function saveQuizRecord(record, storage) {
  let records = [];
  let resolved;
  let storageError;
  try {
    resolved = resolveStorage(storage);
    records = loadRecords(resolved);
  } catch (error) { storageError = error; }

  try {
    const validated = validateRecord(record);
    records = validRecords([...records, validated]);
    if (storageError) throw storageError;
    resolved.setItem(QUIZ_HISTORY_STORAGE_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, records }));
    return { records, persisted: true };
  } catch (error) {
    return { records, persisted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Aggregate all saved sets, including every season and patch. */
export function getHistorySummary(records) {
  const valid = validRecords(records);
  const totalCorrect = valid.reduce((sum, record) => sum + record.correctCount, 0);
  const totalQuestions = valid.reduce((sum, record) => sum + record.totalQuestions, 0);
  return {
    completedSets: valid.length,
    totalCorrect,
    totalQuestions,
    winRate: totalQuestions ? totalCorrect / totalQuestions * 100 : 0,
    bestScore: valid.reduce((best, record) => Math.max(best, record.score), 0),
  };
}
