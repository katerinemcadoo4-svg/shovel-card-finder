import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { layoutFormation } from '../src/formation.mjs';

const catalog = JSON.parse(await readFile(new URL('../data/lineups.json', import.meta.url), 'utf8'));

test('all 59 official formations retain every unit and repeated summon in its original position', () => {
  assert.equal(catalog.lineups.length, 59);
  for (const lineup of catalog.lineups) {
    const { cells, unplaced } = layoutFormation(lineup.members);
    assert.equal(cells.length, 28, lineup.id);
    assert.deepEqual(unplaced, [], lineup.id);
    const placed = cells.flatMap(cell => cell.members);
    assert.equal(placed.length, lineup.members.length, lineup.id);
    for (const member of lineup.members) {
      assert.equal(placed.filter(entry => entry === member).length, 1, `${lineup.id}/${member.name}`);
      const cell = cells.find(entry => entry.row === member.position.row && entry.column === member.position.column);
      assert.ok(cell.members.includes(member), `${lineup.id}/${member.name}`);
    }
  }
  const repeatedSummons = catalog.lineups.find(lineup => lineup.id === 'official-4838').members
    .filter(member => member.name === '石皮树');
  assert.equal(repeatedSummons.length, 2);
  const board = layoutFormation(repeatedSummons);
  assert.equal(board.cells[1].members[0], repeatedSummons[0]);
  assert.equal(board.cells[4].members[0], repeatedSummons[1]);
});

test('row-major cells place the first row at the front and fourth row at the back without mirroring columns', () => {
  const frontLeft = { name: '前排左', position: { row: 1, column: 1 } };
  const frontRight = { name: '前排右', position: { row: 1, column: 7 } };
  const backLeft = { name: '后排左', position: { row: 4, column: 1 } };
  const backRight = { name: '后排右', position: { row: 4, column: 7 } };
  const { cells } = layoutFormation([backRight, frontLeft, backLeft, frontRight]);
  assert.deepEqual(cells.map(({ row, column }) => [row, column]),
    Array.from({ length: 28 }, (_, index) => [Math.floor(index / 7) + 1, index % 7 + 1]));
  assert.equal(cells[0].members[0], frontLeft);
  assert.equal(cells[6].members[0], frontRight);
  assert.equal(cells[21].members[0], backLeft);
  assert.equal(cells[27].members[0], backRight);
});

test('members sharing a position stay in input order without overwriting or mutating the records', () => {
  const first = Object.freeze({ unitId: '18704', position: Object.freeze({ row: 2, column: 3 }) });
  const second = Object.freeze({ unitId: '18704', position: Object.freeze({ row: 2, column: 3 }) });
  const { cells, unplaced } = layoutFormation(Object.freeze([first, second]));
  assert.deepEqual(cells[9].members, [first, second]);
  assert.equal(cells.flatMap(cell => cell.members).length, 2);
  assert.deepEqual(unplaced, []);
  assert.ok(cells.filter((_, index) => index !== 9).every(cell => cell.members.length === 0));
});

test('missing and invalid positions remain available outside the board instead of being discarded or guessed', () => {
  const unpositioned = [
    { position: null }, {}, { position: { row: 0, column: 1 } },
    { position: { row: 5, column: 1 } }, { position: { row: 1, column: 0 } },
    { position: { row: 1, column: 8 } }, { position: { row: 1.5, column: 2 } },
    { position: { row: '1', column: 2 } }, { position: { row: 1 } }, null,
  ];
  const valid = { position: { row: 3, column: 4 } };
  const { cells, unplaced } = layoutFormation([...unpositioned, valid]);
  assert.deepEqual(unplaced, unpositioned);
  assert.equal(cells[17].members[0], valid);
  assert.equal(cells.flatMap(cell => cell.members).length, 1);
  assert.equal(layoutFormation([]).cells.length, 28);
});
