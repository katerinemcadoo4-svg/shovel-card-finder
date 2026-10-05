/** Match official alternate forms by name when their unit ID is absent from the roster. */
function matchesHero(member, hero) {
  return member.heroId === hero.id || (member.kind === 'hero' && member.name === hero.name);
}

/** Return sourced recommendations, with this hero's carry lineups first, without changing input. */
export function selectHeroLineups(lineups, hero = null) {
  return lineups
    .filter(lineup => ['S', 'A'].includes(lineup.quality))
    .map(lineup => {
      const members = hero ? lineup.members.filter(member => matchesHero(member, hero)) : [];
      return { lineup, matched: !hero || members.length > 0, carry: members.some(member => member.isCarry) };
    })
    .filter(entry => entry.matched)
    .sort((left, right) => Number(right.carry) - Number(left.carry) ||
      Number(left.lineup.quality === 'A') - Number(right.lineup.quality === 'A') ||
      right.lineup.sortOrder - left.lineup.sortOrder)
    .map(entry => entry.lineup);
}
