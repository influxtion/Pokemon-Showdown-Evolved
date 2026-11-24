'use strict';

// Offline research fixture. Run after build:practice with an optional number of seeds per cell.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const sim = path.resolve(__dirname, '../../vendor/practice/dist/server/dist/sim');

const tusk = { species: 'Great Tusk', ability: 'Protosynthesis', item: 'Heavy-Duty Boots',
  nature: 'Jolly', evs: { atk: 252, def: 4, spe: 252 }, moves: ['Earthquake', 'Stone Edge', 'Rapid Spin', 'Knock Off'] };
const rotom = { species: 'Rotom-Wash', ability: 'Levitate', item: 'Leftovers',
  nature: 'Bold', evs: { hp: 252, def: 252, spe: 4 }, moves: ['Hydro Pump', 'Volt Switch', 'Will-O-Wisp', 'Pain Split'] };
const gholdengo = { species: 'Gholdengo', ability: 'Good as Gold',
  nature: 'Modest', evs: { spa: 252, spd: 4, spe: 252 }, moves: ['Make It Rain', 'Shadow Ball', 'Trick', 'Focus Blast'] };
const moltres = { species: 'Moltres', ability: 'Flame Body', item: 'Heavy-Duty Boots',
  nature: 'Bold', evs: { hp: 248, def: 252, spe: 8 }, moves: ['Flamethrower', 'Hurricane', 'Roost', 'Will-O-Wisp'] };

const ownTeam = [tusk, rotom];
const worlds = ['Choice Specs', 'Choice Scarf'].map(item => ({ item, team: [{ ...gholdengo, item }, moltres] }));
const attacks = ['Earthquake', 'Stone Edge'];
const replies = ['Make It Rain', 'Switch to Moltres'];

function seedFor(index) {
  const hash = createHash('sha256').update('review-turn-1/' + index).digest();
  return [0, 2, 4, 6].map(offset => hash.readUInt16BE(offset));
}

function runExperiment(samplesPerCell) {
  assert.ok(Number.isInteger(samplesPerCell) && samplesPerCell >= 1 && samplesPerCell <= 4096, 'Use 1–4096 seeds per cell');
  const { Battle, TeamValidator } = require(sim);
  const { extractChannelMessages } = require(path.join(sim, 'battle'));
  const validator = TeamValidator.get('gen9ou');
  for (const team of [ownTeam, ...worlds.map(world => world.team)]) {
    assert.equal(validator.validateTeam(structuredClone(team)), null);
  }

  let opening;
  function resolveTurn(seed, world, move, reply, cell) {
    const battle = new Battle({ formatid: 'gen9ou', seed: [...seed],
      p1: { name: 'One', team: structuredClone(ownTeam) }, p2: { name: 'Two', team: structuredClone(world.team) } });
    try {
      battle.makeChoices('team 12', 'team 12');
      const visible = extractChannelMessages(battle.log.join('\n'), [1])[1].filter(line => !line.startsWith('|t:|'));
      const snapshot = JSON.stringify([visible, battle.p1.activeRequest]);
      opening ??= snapshot;
      assert.equal(snapshot, opening, 'Every fork must start with the same player-visible information');
      assert.ok(battle.p1.activeRequest.active[0].moves.some(slot => slot.move === move && !slot.disabled));
      battle.makeChoices('move ' + move, reply === 'Make It Rain' ? 'move Make It Rain' : 'switch 2');
      // Hidden simulator state is used only to measure outcomes after both submissions.
      cell.foeKO += Number(battle.p2.pokemonLeft === 1);
      cell.ownKO += Number(battle.p1.pokemonLeft === 1);
      cell.missed += Number(battle.log.some(line => line.startsWith('|-miss|p1a: Great Tusk')));
    } finally {
      battle.destroy();
    }
  }

  const seeds = Array.from({ length: samplesPerCell }, (_, i) => seedFor(i));
  const cells = [];
  for (const world of worlds) {
    for (const reply of replies) {
      for (const move of attacks) {
        const cell = { item: world.item, reply, move, foeKO: 0, ownKO: 0, missed: 0 };
        for (const seed of seeds) resolveTurn(seed, world, move, reply, cell);
        cells.push(cell);
      }
    }
  }
  return { samplesPerCell, cells };
}

function compareScenario({ samplesPerCell, cells }, scarf, specsSwitch, scarfSwitch) {
  for (const probability of [scarf, specsSwitch, scarfSwitch]) {
    assert.ok(Number.isFinite(probability) && probability >= 0 && probability <= 1, 'Probabilities must be between 0 and 1');
  }
  const estimates = Object.fromEntries(attacks.map(move => [move, { foeKO: 0, ownKO: 0 }]));
  for (const cell of cells) {
    const underScarf = cell.item === 'Choice Scarf';
    const worldWeight = underScarf ? scarf : 1 - scarf;
    const switchChance = underScarf ? scarfSwitch : specsSwitch;
    const replyWeight = cell.reply === 'Switch to Moltres' ? switchChance : 1 - switchChance;
    const weight = worldWeight * replyWeight / samplesPerCell;
    estimates[cell.move].foeKO += weight * cell.foeKO;
    estimates[cell.move].ownKO += weight * cell.ownKO;
  }
  return { scarf, specsSwitch, scarfSwitch, estimates };
}

if (require.main === module) {
  const experiment = runExperiment(Number(process.argv[2] ?? 1024));
  const assumptions = [[0.25, 0.2, 0.2], [0.25, 0.8, 0.8], [0.25, 0.6, 0.6],
    [0.75, 0.6, 0.6], [0.5, 0.9, 0.1], [0.5, 0.1, 0.9]];
  const scenarios = assumptions.map(weights => compareScenario(experiment, ...weights));
  console.log(JSON.stringify({ ...experiment, scenarios }, null, 2));
}

module.exports = { runExperiment, compareScenario };
