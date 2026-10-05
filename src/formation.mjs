/** Map official formation positions to a 4 × 7 board, from front to back. */
export function layoutFormation(members) {
  const cells = Array.from({ length: 28 }, (_, index) => ({
    row: Math.floor(index / 7) + 1,
    column: index % 7 + 1,
    members: [],
  }));
  const unplaced = [];

  for (const member of members) {
    const position = member?.position;
    if (!Number.isInteger(position?.row) || position.row < 1 || position.row > 4 ||
        !Number.isInteger(position?.column) || position.column < 1 || position.column > 7) {
      unplaced.push(member);
      continue;
    }
    // Keep every slot record, including repeated summons or occupied positions.
    cells[(position.row - 1) * 7 + position.column - 1].members.push(member);
  }

  return { cells, unplaced };
}
