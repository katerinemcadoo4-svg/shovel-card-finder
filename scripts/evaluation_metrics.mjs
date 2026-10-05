/** Pure aggregation of recognition outcomes. Only status=match counts as a decision. */
const CATEGORIES = ['game', 'splash', 'unknown'];

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return Number(sorted[Math.max(0, rank)].toFixed(1));
}

function timing(rows, key) {
  const values = rows.map(row => row[key]).filter(value => Number.isFinite(value));
  return { medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95),
    maxMs: values.length ? Number(Math.max(...values).toFixed(1)) : null };
}

export function summarizeEvaluation(rows) {
  if (!Array.isArray(rows)) throw new TypeError('Expected evaluation rows');
  const result = {};
  for (const category of CATEGORIES) {
    const group = rows.filter(row => row.category === category);
    const decided = group.filter(row => row.status === 'match');
    const unavailable = group.filter(row => row.status === 'unavailable').length;
    const uncertain = group.filter(row => row.status === 'uncertain').length;
    const base = { count: group.length, decided: decided.length, uncertain, unavailable,
      recognitionTime: timing(group, 'recognitionMs'), decodeTime: timing(group, 'decodeMs') };
    if (category === 'unknown') {
      result[category] = { ...base, falsePositives: decided.length,
        falsePositiveRate: group.length ? decided.length / group.length : null };
    } else {
      const top1Correct = decided.filter(row => row.predictedHeroId === row.expectedHeroId).length;
      result[category] = { ...base, top1Correct,
        top1Rate: group.length ? top1Correct / group.length : null,
        wrongDecisions: decided.length - top1Correct,
        distinctHeroes: new Set(group.map(row => row.expectedHeroId)).size };
    }
  }
  return result;
}
