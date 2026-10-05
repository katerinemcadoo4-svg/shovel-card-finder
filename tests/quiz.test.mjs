import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuiz, scoreQuiz } from '../src/quiz.mjs';

function fixtures(count) {
  const heroes = Array.from({ length: count }, (_, i) => ({ id: `hero-${i}`, name: `角色${i}`, variants: [{ id: 'portrait', kind: 'card' }, { id: 'art', kind: 'splash' }] }));
  const references = heroes.flatMap(hero => ['art', 'portrait'].map(variantId => ({ heroId: hero.id, variantId, blob: new Blob(['image']) })));
  return { catalog: { heroes }, references };
}

test('20-question set uses different pictured heroes and distinct correct options', () => {
  const { catalog, references } = fixtures(30);
  const quiz = createQuiz(catalog, references, { random: () => .37 });
  assert.equal(quiz.length, 20);
  assert.equal(new Set(quiz.map(question => question.heroId)).size, 20);
  for (const question of quiz) {
    assert.equal(question.reference.variantId, 'portrait');
    assert.equal(question.options.length, 4);
    assert.equal(new Set(question.options.map(option => option.name)).size, 4);
    assert.equal(question.options.filter(option => option.heroId === question.heroId).length, 1);
  }
});

test('small packs rotate pictured heroes without adjacent repeats and cannot start without two images', () => {
  const { catalog, references } = fixtures(2);
  const quiz = createQuiz(catalog, references, { random: () => .5 });
  assert.equal(quiz.length, 20);
  assert.ok(quiz.every((question, i) => !i || question.heroId !== quiz[i - 1].heroId));
  assert.ok(quiz.every(question => question.options.length === 2));
  assert.deepEqual(createQuiz(catalog, references.filter(reference => reference.heroId === 'hero-0')), []);
  assert.deepEqual(createQuiz(catalog, []), []);
});

test('duplicate names cannot produce indistinguishable answer choices', () => {
  const { catalog, references } = fixtures(5);
  catalog.heroes[4].name = catalog.heroes[0].name;
  for (const question of createQuiz(catalog, references)) {
    assert.equal(new Set(question.options.map(option => option.name)).size, question.options.length);
  }
});

test('correct answers are worth five points with a fixed 100-point maximum', () => {
  assert.deepEqual(scoreQuiz(13), { correctCount: 13, totalQuestions: 20, score: 65, maxScore: 100 });
  assert.equal(scoreQuiz(0).score, 0);
  assert.equal(scoreQuiz(20).score, 100);
  assert.equal(scoreQuiz(99).score, 100);
});
