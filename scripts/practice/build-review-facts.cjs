'use strict';

// Project only whitelisted, static attack mechanics from the pinned practice build.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { Dex } = require(path.join(root, 'vendor/practice/dist/server/dist/sim/dex'));
const destination = path.join(root, 'app/battle-review-data.json');
const facts = JSON.parse(fs.readFileSync(destination, 'utf8'));
const ordinaryKeys = new Set(('num accuracy basePower category name pp priority flags target type contestType secondary ' +
  'zMove maxMove desc shortDesc isNonstandard').split(' '));

function group(entries) {
  const groups = new Map();
  for (const [key, value] of entries) {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return Object.fromEntries([...groups.keys()].sort().map(key => [key, groups.get(key).sort().join(' ')]));
}

const attacks = [];
const typedMoves = new Map(Object.entries(facts.moves).flatMap(([type, names]) => names.split(' ').map(name => [name, type])));
for (const name of Object.keys(Dex.data.Moves)) {
  const raw = Dex.data.Moves[name];
  if (Dex.moves.get(name).isNonstandard || !raw.basePower || raw.priority !== 0 || !raw.flags.protect ||
      !['normal', 'any', 'allAdjacentFoes', 'allAdjacent'].includes(raw.target) ||
      Object.keys(raw).some(key => !ordinaryKeys.has(key))) continue;
  // Only target-side, non-callback secondary effects can be treated as lost on immunity.
  if (raw.secondary && Object.keys(raw.secondary).some(key => !['chance', 'status', 'boosts', 'volatileStatus'].includes(key))) continue;
  const flags = Object.keys(raw.flags).sort().join(',');
  attacks.push([[raw.category, raw.basePower, raw.accuracy, raw.pp, flags, raw.secondary ? 'secondary' : 'plain'].join(' '), name]);
  typedMoves.set(name, raw.type);
}
facts.moves = group([...typedMoves].map(([name, type]) => [type, name]));
facts.attacks = group(attacks);
facts.abilities = group(Object.values(facts.species).flatMap(names => names.split(' ').map(name => {
  const abilities = Object.values(Dex.species.get(name).abilities).map(ability => Dex.toID(ability));
  return [[...new Set(abilities)].sort().join('/'), name];
})));
delete facts.stableDamage;
fs.writeFileSync(destination, JSON.stringify(facts, null, 2) + '\n');
