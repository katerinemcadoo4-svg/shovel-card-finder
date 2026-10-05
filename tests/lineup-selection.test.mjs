import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { selectHeroLineups } from '../src/lineup-selection.mjs';

const catalog = JSON.parse(await readFile(new URL('../data/season.json', import.meta.url), 'utf8'));
const { lineups } = JSON.parse(await readFile(new URL('../data/lineups.json', import.meta.url), 'utf8'));
const heroNamed = name => catalog.heroes.find(hero => hero.name === name);

test('every current-season hero has recommendations even without a carry lineup or S grade', () => {
  assert.equal(catalog.heroes.length, 65);
  for (const hero of catalog.heroes) {
    assert.ok(selectHeroLineups(lineups, hero).length > 0, `${hero.id}/${hero.name}`);
  }
  const ornn = selectHeroLineups(lineups, heroNamed('奥恩'));
  assert.equal(ornn.length, 7);
  assert.ok(ornn.every(lineup => lineup.members.every(member => member.heroId !== 'hero-11500' || !member.isCarry)));
  const kubo = selectHeroLineups(lineups, heroNamed('可酷伯'));
  assert.equal(kubo.length, 2);
  assert.ok(kubo.every(lineup => lineup.quality === 'A'));
});

test('same-name alternate forms include Lux, Gnar, and Morgana with missing roster IDs', () => {
  const lux = selectHeroLineups(lineups, heroNamed('拉克丝'));
  assert.equal(lux.length, 5);
  assert.ok(lux.every(lineup => lineup.members.some(member =>
    member.name === '拉克丝' && member.kind === 'hero' && member.heroId === null)));
  assert.equal(selectHeroLineups(lineups, heroNamed('纳尔')).length, 12);
  const morgana = selectHeroLineups(lineups, heroNamed('莫甘娜'));
  assert.equal(morgana.length, 9);
  assert.equal(morgana[0].id, 'official-4777');
  assert.equal(morgana[0].quality, 'A');
  assert.ok(morgana.slice(1).some(lineup => lineup.quality === 'S'));
});

test('carry recommendations precede supporting lineups, then use grade and official order', () => {
  const aphelios = selectHeroLineups(lineups, heroNamed('厄斐琉斯'));
  assert.equal(aphelios.length, 7);
  assert.deepEqual(aphelios.slice(0, 3).map(lineup => lineup.id),
    ['official-4838', 'official-4768', 'official-4871']);
  const veigar = selectHeroLineups(lineups, heroNamed('维迦'));
  assert.equal(veigar.length, 4);
  assert.equal(veigar[0].id, 'official-4813');
});

test('pet names do not match a hero, repeated member slots do not duplicate a lineup', () => {
  const hero = { id: 'hero-1', name: '同名角色' };
  const pet = { heroId: null, name: hero.name, kind: 'pet', isCarry: true };
  const unit = { heroId: hero.id, name: '官方角色名', kind: 'hero', isCarry: false };
  const rows = [
    { id: 'pet-only', quality: 'S', sortOrder: 5, members: [pet] },
    { id: 'member', quality: 'A', sortOrder: 1, members: [unit, unit] },
  ];
  assert.deepEqual(selectHeroLineups(rows, hero).map(lineup => lineup.id), ['member']);
  assert.deepEqual(selectHeroLineups(rows, { id: 'hero-2', name: '其他角色' }), []);
});

test('without a selected hero, recommendations retain S/A grade order and descending official order', () => {
  const rows = [
    { id: 'a-high', quality: 'A', sortOrder: 99, members: [] },
    { id: 's-low', quality: 'S', sortOrder: 1, members: [] },
    { id: 's-high', quality: 'S', sortOrder: 5, members: [] },
    { id: 'unsupported', quality: 'B', sortOrder: 100, members: [] },
    { id: 'a-low', quality: 'A', sortOrder: 1, members: [] },
  ];
  assert.deepEqual(selectHeroLineups(rows).map(lineup => lineup.id), ['s-high', 's-low', 'a-high', 'a-low']);
});

test('selection never mutates frozen input arrays, lineups, or member records', () => {
  const hero = { id: 'hero-1', name: '角色' };
  const member = Object.freeze({ heroId: hero.id, name: hero.name, kind: 'hero', isCarry: true });
  const rows = Object.freeze([
    Object.freeze({ id: 'later', quality: 'A', sortOrder: 1, members: Object.freeze([member]) }),
    Object.freeze({ id: 'earlier', quality: 'S', sortOrder: 2, members: Object.freeze([member]) }),
  ]);
  const selected = selectHeroLineups(rows, hero);
  assert.deepEqual(selected.map(lineup => lineup.id), ['earlier', 'later']);
  assert.notEqual(selected, rows);
  assert.equal(selected[0], rows[1]);
  assert.deepEqual(rows.map(lineup => lineup.id), ['later', 'earlier']);
});
