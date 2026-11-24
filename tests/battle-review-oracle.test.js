'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { analyzeBattle } = require('../app/battle-review-model');

// Exercise public logs produced by the pinned engine, including split HP messages and
// move/ability activations. The reviewer receives the spectator channel, never the sets.
const server = path.resolve(__dirname, '../vendor/practice/dist/server');
const sim = path.join(server, 'dist/sim');
const options = { skip: fs.existsSync(path.join(sim, 'battle.js')) ? false : 'run npm run build:practice' };
function set(species, ability, moves, item = '') {
  return { species, name: species, ability, moves, item, nature: 'Serious', evs: { hp: 4, def: 252, spd: 252 } };
}
function team(lead, bench = set('Blissey', 'Natural Cure', ['Soft-Boiled'])) {
  return [lead, bench];
}
function battle(left, right, choices) {
  const { Battle, TeamValidator } = require(sim);
  const { extractChannelMessages } = require(path.join(sim, 'battle'));
  const validator = TeamValidator.get('gen9ou');
  for (const roster of [left, right]) assert.equal(validator.validateTeam(structuredClone(roster)), null);
  const game = new Battle({ formatid: 'gen9ou', seed: [1, 2, 3, 4],
    p1: { name: 'Alpha', team: left }, p2: { name: 'Beta', team: right } });
  try {
    game.makeChoices('team 1', 'team 1');
    for (const pair of choices) game.makeChoices(...pair);
    if (!game.ended) game.win(game.p1);
    const log = extractChannelMessages(game.log.join('\n'), [0])[0]
      .filter(line => !line.startsWith('|t:|')).join('\n');
    // Exact HP is an oracle observation only. The model gets the public percentages above.
    const targetHpLosses = extractChannelMessages(game.log.join('\n'), [2])[2]
      .filter(line => line.startsWith('|-damage|p2a: '));
    return { log, targetHpLosses, report: analyzeBattle(log) };
  } finally {
    game.destroy();
  }
}
function row(result, side, turn) {
  return result.report.sides[side].turns.find(action => action.turn === turn);
}
function withoutPositiveRating(action) {
  assert.ok(action.stars === null || action.stars <= 2, JSON.stringify(action));
}

test('higher listed power and the lower-power alternative can take the same last hit point', options, () => {
  function finish(lastMove) {
    const bergmite = { ...set('Bergmite', 'Own Tempo', ['Endure', 'Tackle']), level: 1 };
    return battle(team(set('Corviknight', 'Pressure', ['Peck', 'Drill Peck'], 'Air Balloon')),
      team(bergmite), [['move 1', 'move 1'], [lastMove, 'move 2']]);
  }
  const peck = finish('move 1');
  const drill = finish('move 2');
  assert.equal(peck.log.split('|turn|2')[0], drill.log.split('|turn|2')[0]);
  for (const result of [peck, drill]) {
    assert.match(result.targetHpLosses[0], /\|1\/\d+$/);
    assert.match(result.targetHpLosses[1], /\|0 fnt$/);
  }
  const review = row(drill, 'p1', 2);
  assert.equal(review.label, 'Higher base power');
  assert.match(review.before, /knockout can make them equal/);
});

test('all projected Gen 9 chart, species, ability and ordinary attack facts agree with the pinned Dex', options, () => {
  const { Dex } = require(sim);
  const facts = require('../app/battle-review-data.json');
  const types = Object.keys(facts.typeChart);
  assert.equal(types.length, 18);
  for (const attack of types) {
    const [weak, resistant, immune] = facts.typeChart[attack].map(names => new Set(names.split(' ')));
    for (const defense of types) {
      const projected = immune.has(defense) ? 0 : weak.has(defense) ? 2 : resistant.has(defense) ? 0.5 : 1;
      const actual = Dex.getImmunity(attack, defense) ? 2 ** Dex.getEffectiveness(attack, defense) : 0;
      assert.equal(projected, actual, attack + ' into ' + defense);
    }
  }
  function lookup(groups) {
    const byName = new Map();
    for (const [key, names] of Object.entries(groups)) {
      for (const name of names.split(' ')) {
        assert.ok(name && !byName.has(name), 'missing or duplicate ID ' + name);
        byName.set(name, key);
      }
    }
    return byName;
  }
  const species = lookup(facts.species);
  const abilities = lookup(facts.abilities);
  assert.deepEqual(new Set(species.keys()), new Set(abilities.keys()));
  for (const [name, typing] of species) {
    const available = Dex.species.get(name);
    assert.ok(available.exists, name);
    assert.deepEqual(typing.split('/'), available.types, name);
    const expectedAbilities = Object.values(available.abilities).map(ability => Dex.toID(ability));
    assert.deepEqual(new Set(abilities.get(name).split('/')), new Set(expectedAbilities), name);
  }
  const moveTypes = lookup(facts.moves);
  for (const [name, type] of moveTypes) {
    const move = Dex.moves.get(name);
    assert.ok(move.exists, name);
    assert.equal(type, move.type, name);
  }
  for (const [name, projected] of lookup(facts.attacks)) {
    const [category, power, accuracy, pp, flags, effect] = projected.split(' ');
    const move = Dex.moves.get(name);
    assert.equal(moveTypes.get(name), move.type, name);
    assert.equal(move.priority, 0, name);
    assert.equal(move.critRatio, 1, name);
    assert.equal(category, move.category, name);
    assert.equal(Number(power), move.basePower, name);
    assert.equal(accuracy, String(move.accuracy), name);
    assert.equal(Number(pp), move.pp, name);
    assert.deepEqual(flags.split(','), Object.keys(move.flags).sort(), name);
    assert.equal(effect, move.secondary ? 'secondary' : 'plain', name);
    assert.ok(!move.multihit && !move.damage && !move.ohko && !move.self && !move.recoil, name);
    assert.ok(!move.basePowerCallback && !move.damageCallback && !move.onEffectiveness && !move.onModifyType, name);
  }
});

test('Earthquake into Rotom-Heat cannot earn a favorable matchup grade on typing alone', options, () => {
  const result = battle(team(set('Garchomp', 'Rough Skin', ['Earthquake'])),
    team(set('Rotom-Heat', 'Levitate', ['Nasty Plot'])), [['move 1', 'move 1']]);
  assert.match(result.log, /\|-immune\|p2a: Rotom\|\[from\] ability: Levitate/);
  withoutPositiveRating(row(result, 'p1', 1));
});

test('a reflected hazard leaves room for the reflector’s independently chosen action', options, () => {
  const result = battle(team(set('Garchomp', 'Rough Skin', ['Stealth Rock'])),
    team(set('Hatterene', 'Magic Bounce', ['Calm Mind'])), [['move 1', 'move 1'], ['move 1', 'move 1']]);
  assert.match(result.log, /\|move\|p2a: Hatterene\|Stealth Rock\|p1a: Garchomp\|\[from\] ability: Magic Bounce/);
  assert.match(result.log, /\|-sidestart\|p1: Alpha\|move: Stealth Rock/);
  withoutPositiveRating(row(result, 'p1', 2));
  for (const turn of [1, 2]) {
    assert.match(row(result, 'p2', turn).action, /Calm Mind/);
    assert.equal(row(result, 'p2', turn).decision, true);
  }
});

test('public Psychic Terrain prevents favorable priority pressure against grounded Hatterene', options, () => {
  const result = battle(team(set('Scizor', 'Technician', ['Bullet Punch', 'X-Scissor'])),
    team(set('Indeedee', 'Psychic Surge', ['Psychic']), set('Hatterene', 'Magic Bounce', ['Calm Mind'])),
    [['move 2', 'switch 2'], ['move 1', 'move 1']]);
  assert.match(result.log, /\|move\|p1a: Scizor\|Bullet Punch\|p2a: Hatterene\n\|-activate\|p2a: Hatterene\|move: Psychic Terrain/);
  withoutPositiveRating(row(result, 'p1', 2));
});

test('identical public openings with and without hidden Scrappy have opposite switch outcomes', options, () => {
  function play(ability) {
    return battle(team(set('Corviknight', 'Pressure', ['Roost']), set('Gholdengo', 'Good as Gold', ['Recover'])),
      team(set('Flamigo', ability, ['Close Combat'])), [['move 1', 'move 1'], ['switch 2', 'move 1']]);
  }
  const scrappy = play('Scrappy');
  const costar = play('Costar');
  assert.equal(scrappy.log.split('|turn|2')[0], costar.log.split('|turn|2')[0]);
  assert.match(scrappy.log, /\|-supereffective\|p1a: Gholdengo\n\|-damage\|p1a: Gholdengo\|23\/100/);
  assert.match(costar.log, /\|-immune\|p1a: Gholdengo/);
  const seen = row(scrappy, 'p1', 2);
  const unseen = row(costar, 'p1', 2);
  assert.equal(seen.before, unseen.before);
  assert.equal(seen.stars, unseen.stars);
  assert.equal(seen.lesson, unseen.lesson);
  withoutPositiveRating(seen);
});

test('public Poison Heal precludes credit for stalling an opponent’s poison damage', options, () => {
  const result = battle(team(set('Gliscor', 'Poison Heal', ['Protect', 'Toxic'], 'Toxic Orb')),
    team(set('Gliscor', 'Poison Heal', ['Protect', 'Substitute'], 'Toxic Orb')),
    [['move 1', 'move 1'], ['move 2', 'move 2'], ['move 1', 'move 1']]);
  assert.match(result.log, /\|-heal\|p2a: Gliscor\|88\/100 tox\|\[from\] ability: Poison Heal/);
  assert.match(result.log, /\|-heal\|p2a: Gliscor\|99\/100 tox\|\[from\] ability: Poison Heal/);
  const protect = row(result, 'p1', 3);
  assert.doesNotMatch(protect.lesson, /buy a residual-damage turn/);
});

test('a known open and a known immune attack produce opposite conditional grades', options, () => {
  const result = battle(team(set('Staraptor', 'Reckless', ['Aerial Ace', 'Tackle'])),
    team(set('Sinistcha', 'Hospitality', ['Life Dew'], 'Leftovers')),
    [['move 1', 'move 1'], ['move 2', 'move 1'], ['move 1', 'move 1']]);
  assert.match(result.log, /\|move\|p1a: Staraptor\|Aerial Ace\|p2a: Sinistcha\n\|-supereffective\|p2a: Sinistcha\n\|-damage\|p2a: Sinistcha/);
  assert.match(result.log.split('|turn|2')[0], /\[from\] item: Leftovers/);
  assert.match(result.log, /\|move\|p1a: Staraptor\|Tackle\|p2a: Sinistcha\n\|-immune\|p2a: Sinistcha/);
  assert.deepEqual(result.report.sides.p1.turns.slice(0, 3).map(action => action.stars), [null, 2, 4]);
});

test('paired legal choices from the same turn opening validate the plain-power ordering', options, () => {
  function play(lastMove) {
    return battle(team(set('Corviknight', 'Pressure', ['Peck', 'Drill Peck'], 'Air Balloon')),
      team(set('Avalugg', 'Own Tempo', ['Recover'])),
      [['move 1', 'move 1'], ['move 2', 'move 1'], [lastMove, 'move 1'], ['move 1', 'move 1']]);
  }
  const peck = play('move 1');
  const drillPeck = play('move 2');
  const [opening, peckTurn] = peck.log.split('|turn|3');
  const [otherOpening, drillTurn] = drillPeck.log.split('|turn|3');
  assert.equal(opening, otherOpening);
  const hpAfterAttack = /\|-damage\|p2a: Avalugg\|(\d+)\/100/;
  assert.ok(Number(drillTurn.match(hpAfterAttack)[1]) < Number(peckTurn.match(hpAfterAttack)[1]));
  assert.equal(row(peck, 'p1', 1).stars, null);
  assert.equal(row(peck, 'p1', 3).stars, 2);
  assert.equal(row(drillPeck, 'p1', 3).stars, 4);
  assert.equal(drillPeck.report.sides.p1.rated, 3);
  assert.equal(drillPeck.report.sides.p1.stars, null);
});

test('a known stronger move disabled by the opposing Pokémon is not a selectable alternative', options, () => {
  const result = battle(team(set('Corviknight', 'Pressure', ['Peck', 'Drill Peck'], 'Air Balloon')),
    team(set('Slowbro', 'Own Tempo', ['Slack Off', 'Disable'])),
    [['move 1', 'move 1'], ['move 2', 'move 2'], ['move 1', 'move 1']]);
  assert.match(result.log, /\|-start\|p1a: Corviknight\|Disable\|Drill Peck/);
  assert.equal(row(result, 'p1', 3).stars, null);
});

test('a target that began Dig on an earlier turn cannot earn ordinary open-target comparisons', options, () => {
  const result = battle(team(set('Corviknight', 'Pressure', ['Peck', 'Drill Peck'], 'Air Balloon')),
    team(set('Slowbro', 'Own Tempo', ['Slack Off', 'Dig'])),
    [['move 1', 'move 1'], ['move 2', 'move 2'], ['move 2', 'move 1']]);
  assert.match(result.log.split('|turn|3')[0], /\|-prepare\|p2a: Slowbro\|Dig/);
  assert.match(result.log.split('|turn|3')[1], /\|-miss\|p1a: Corviknight\|p2a: Slowbro/);
  assert.equal(row(result, 'p1', 2).stars, 4);
  assert.equal(row(result, 'p1', 3).stars, null);
});

test('Pressure and Spite exhaust a revealed alternative before a weaker attack is selected', options, () => {
  const rookidee = { ...set('Rookidee', 'Keen Eye', ['Peck', 'Drill Peck'], 'Air Balloon'), level: 1 };
  const choices = [['move 1', 'move 3'], ...Array.from({ length: 6 }, () => ['move 2', 'move 2']),
    ['move 1', 'move 2']];
  const result = battle(team(rookidee), team(set('Dusknoir', 'Pressure', ['Night Shade', 'Spite', 'Protect'])), choices);
  const prefix = result.log.split('|turn|8')[0];
  assert.match(prefix, /\|-ability\|p2a: Dusknoir\|Pressure/);
  assert.equal(prefix.match(/\|move\|p1a: Rookidee\|Drill Peck/g).length, 6);
  assert.equal(prefix.match(/\|-activate\|p1a: Rookidee\|move: Spite\|Drill Peck\|4/g).length, 5);
  // Six attacks under Pressure cost 12 PP and five Spite activations cost the remaining 20.
  assert.equal(row(result, 'p1', 8).stars, null);
});

test('power and accuracy trade-offs and distinct secondary effects do not earn dominance grades', options, () => {
  const choices = [['move 1', 'move 1'], ['move 2', 'move 1'], ['move 1', 'move 1']];
  const accuracy = battle(team(set('Blastoise', 'Torrent', ['Water Gun', 'Hydro Pump'], 'Air Balloon')),
    team(set('Slowbro', 'Own Tempo', ['Slack Off'])), choices);
  const secondary = battle(team(set('Snorlax', 'Thick Fat', ['Tackle', 'Body Slam'], 'Air Balloon')),
    team(set('Avalugg', 'Own Tempo', ['Recover'])), choices);
  for (const result of [accuracy, secondary]) {
    for (const turn of [2, 3]) assert.equal(row(result, 'p1', turn).stars, null);
  }
});

test('the same-turn Tera power floor can make different listed powers identical', options, () => {
  function play(move) {
    const murkrow = { ...set('Murkrow', 'Insomnia', ['Peck', 'Wing Attack'], 'Air Balloon'), teraType: 'Flying' };
    return battle(team(murkrow), team(set('Avalugg', 'Own Tempo', ['Recover'])),
      [['move 1', 'move 1'], ['move 2', 'move 1'], [move + ' terastallize', 'move 1'], [move, 'move 1']]);
  }
  const peck = play('move 1');
  const wingAttack = play('move 2');
  assert.equal(peck.log.split('|turn|3')[0], wingAttack.log.split('|turn|3')[0]);
  for (const result of [peck, wingAttack]) {
    assert.match(result.log.split('|turn|3')[1], /\|-terastallize\|p1a: Murkrow\|Flying[\s\S]+?\|-damage\|p2a: Avalugg\|87\/100/);
    for (const turn of [3, 4]) assert.equal(row(result, 'p1', turn).stars, null);
  }
});

test('possible Technician reverses the listed power ordering of two otherwise matched attacks', options, () => {
  function play(ability, move) {
    return battle(team(set('Smeargle', ability, ['Wing Attack', 'Drill Peck'], 'Air Balloon')),
      team(set('Blissey', 'Natural Cure', ['Soft-Boiled']), set('Slowbro', 'Own Tempo', ['Slack Off'])),
      [['move 1', 'move 1'], ['move 2', 'move 1'], [move, 'move 1']]);
  }
  for (const [ability, wingHp, drillHp] of [['Technician', 93, 94], ['Own Tempo', 95, 94]]) {
    const wingAttack = play(ability, 'move 1');
    const drillPeck = play(ability, 'move 2');
    assert.equal(wingAttack.log.split('|turn|3')[0], drillPeck.log.split('|turn|3')[0]);
    for (const [result, hp] of [[wingAttack, wingHp], [drillPeck, drillHp]]) {
      assert.match(result.log.split('|turn|3')[1], new RegExp('\\|-damage\\|p2a: Blissey\\|' + hp + '/100'));
      assert.equal(row(result, 'p1', 3).stars, null);
    }
  }
});

test('an unrevealed Metronome can reverse even a two-to-one listed power advantage', options, () => {
  function play(lastMove) {
    const rookidee = { ...set('Rookidee', 'Keen Eye', ['Peck', 'Drill Peck'], 'Metronome'), level: 1 };
    const choices = [['move 2', 'move 1'], ...Array.from({ length: 5 }, () => ['move 1', 'move 1']),
      [lastMove, 'move 1']];
    return battle(team(rookidee), team(set('Avalugg', 'Own Tempo', ['Recover'])), choices);
  }
  const peck = play('move 1');
  const drillPeck = play('move 2');
  assert.equal(peck.log.split('|turn|7')[0], drillPeck.log.split('|turn|7')[0]);
  assert.doesNotMatch(peck.log, /item: Metronome/);
  assert.match(peck.targetHpLosses.at(-1), /330\/332$/);
  assert.match(drillPeck.targetHpLosses.at(-1), /331\/332$/);
  for (const result of [peck, drillPeck]) assert.equal(row(result, 'p1', 7).stars, null);
});
