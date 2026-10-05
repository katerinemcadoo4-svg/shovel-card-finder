export const QUESTIONS_PER_QUIZ = 20;
export const POINTS_PER_QUESTION = 5;

function shuffled(values, random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Make a fresh 20-question set using images stored on this device. */
export function createQuiz(catalog, references, { random = Math.random } = {}) {
  const heroes = catalog?.heroes || [];
  const candidates = [];
  const names = new Set();
  for (const hero of heroes) {
    if (names.has(hero.name)) continue;
    const images = references.filter(reference => reference.heroId === hero.id && reference.blob?.size > 0);
    const reference = images.find(image => hero.variants?.some(variant => variant.id === image.variantId && variant.kind === 'card')) || images[0];
    if (!reference) continue;
    names.add(hero.name);
    candidates.push({ hero, reference });
  }
  if (candidates.length < 2) return [];

  const questions = [];
  while (questions.length < QUESTIONS_PER_QUIZ) {
    const round = shuffled(candidates, random);
    if (round[0].hero.id === questions.at(-1)?.heroId) [round[0], round[1]] = [round[1], round[0]];
    for (const { hero, reference } of round) {
      const otherNames = new Set([hero.name]);
      const distractors = shuffled(heroes, random).filter(other => {
        if (otherNames.has(other.name)) return false;
        otherNames.add(other.name);
        return true;
      }).slice(0, 3);
      const options = shuffled([hero, ...distractors], random).map(option => ({ heroId: option.id, name: option.name }));
      questions.push({ heroId: hero.id, reference, options });
      if (questions.length === QUESTIONS_PER_QUIZ) break;
    }
  }
  return questions;
}

export function scoreQuiz(correctCount) {
  const count = Number.isFinite(correctCount) ? Math.max(0, Math.min(QUESTIONS_PER_QUIZ, Math.trunc(correctCount))) : 0;
  return { correctCount: count, totalQuestions: QUESTIONS_PER_QUIZ, score: count * POINTS_PER_QUESTION, maxScore: 100 };
}
