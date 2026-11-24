'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeBattle } = require('../app/battle-review-model');

function battle(turns, { left = 'Garchomp', right = 'Hatterene', preview = [], opening = [] } = {}) {
  return ['|gametype|singles', '|player|p1|Ada', '|player|p2|Mira', '|gen|9', '|tier|[Gen 9] Anything Goes',
    ...preview.map(name => '|poke|p1|' + name + '|'), '|teamsize|p1|3', '|teamsize|p2|2', '|start',
    '|switch|p1a: Left|' + left + '|100/100', '|switch|p2a: Right|' + right + '|100/100', ...opening,
    ...turns.flatMap((lines, index) => ['|turn|' + (index + 1), ...lines]), '|win|Ada'].join('\n');
}

test('a reflected hazard or a Dancer activation leaves the following chosen move visible', () => {
  // These event orders and source tags were reproduced with the pinned simulator.
  for (const [right, copied, chosen, ability] of [
    ['Hatterene', 'Stealth Rock', 'Dazzling Gleam', 'Magic Bounce'],
    ['Oricorio', 'Swords Dance', 'Hurricane', 'Dancer'],
  ]) {
    const report = analyzeBattle(battle([[
      '|move|p1a: Left|' + copied + '|p2a: Right',
      '|move|p2a: Right|' + copied + '|p1a: Left|[from] ability: ' + ability,
      '|move|p2a: Right|' + chosen + '|p1a: Left',
      '|-damage|p1a: Left|41/100',
    ]], { right }));
    const [row] = report.sides.p2.turns;
    assert.equal(row.action, right + ' used ' + chosen);
    assert.equal(row.decision, true);
    assert.ok(row.outcome.includes(ability));
    assert.match(row.outcome, /41%/);
  }
});

test('the priority-blocking ability holder can still take its own turn', () => {
  const report = analyzeBattle(battle([[
    '|move|p1a: Left|Bullet Punch||[still]',
    '|cant|p2a: Right|ability: Armor Tail|Bullet Punch|[of] p1a: Left',
    '|move|p2a: Right|Psychic|p1a: Left',
  ]], { left: 'Scizor', right: 'Farigiraf' }));
  assert.match(report.sides.p1.turns[0].outcome, /Farigiraf blocked Bullet Punch with Armor Tail/);
  assert.equal(report.sides.p2.turns[0].action, 'Farigiraf used Psychic');
  assert.equal(report.sides.p2.turns[0].decision, true);
});

test('Eject Pack triggered by a switch-in Intimidate precedes both moves and gives no voluntary switch credit', () => {
  const report = analyzeBattle(battle([[
    '|switch|p2a: Gyarados|Gyarados|100/100', '|-ability|p2a: Gyarados|Intimidate|boost',
    '|-unboost|p1a: Left|atk|1', '|-enditem|p1a: Left|Eject Pack',
    '|switch|p1a: Volcarona|Volcarona|100/100',
  ]]));
  assert.equal(report.sides.p1.turns[0].decision, false);
  assert.match(report.sides.p1.turns[0].action, /Volcarona entered/);
  assert.equal(report.sides.p2.turns[0].decision, true);
});

test('the simulator identifies a locked continuation and a later voluntary repeat separately', () => {
  const dig = '|move|p1a: Left|Dig';
  const report = analyzeBattle(battle([
    [dig + '||[still]', '|-prepare|p1a: Left|Dig'],
    [dig + '|p2a: Right|[from] lockedmove'],
    [dig + '||[still]', '|-prepare|p1a: Left|Dig'],
  ]));
  assert.deepEqual(report.sides.p1.turns.map(row => row.decision), [true, false, true]);
  const outrage = '|move|p1a: Left|Outrage|p2a: Right';
  const rampage = analyzeBattle(battle([
    [outrage], [outrage + '|[from] lockedmove', '|-start|p1a: Left|confusion|[fatigue]'], [outrage],
  ]));
  assert.deepEqual(rampage.sides.p1.turns.map(row => row.decision), [true, false, true]);
});

test('held-item memory requires unambiguous public identity and choice locks reset on switch', () => {
  const move = '|move|p1a: Left|Crunch|p2a: Right';
  const turns = [[move], ['|switch|p1a: Other|Volcarona|100/100'],
    ['|switch|p1a: Left|Garchomp|100/100'], [move], [move]];
  for (const [preview, finalDecision] of [
    [['Garchomp', 'Volcarona', 'Corviknight'], false],
    [['Garchomp', 'Volcarona', 'Garchomp'], true],
    [['Garchomp', 'Volcarona', 'Zoroark-*'], true],
    [[], true],
  ]) {
    const report = analyzeBattle(battle(turns, { preview, opening: ['|-item|p1a: Left|Choice Scarf'] }));
    assert.equal(report.sides.p1.turns[3].decision, true, String(preview));
    assert.equal(report.sides.p1.turns[4].decision, finalDecision, String(preview));
  }
});

test('confusion self-hits are interruptions, while a flinch alone does not establish chance', () => {
  const report = analyzeBattle(battle([
    ['|-activate|p1a: Left|confusion', '|-damage|p1a: Left|80/100|[from] confusion'],
    ['|move|p2a: Right|Fake Out|p1a: Left', '|cant|p1a: Left|flinch'],
  ]));
  assert.equal(report.sides.p1.turns[0].decision, false);
  assert.match(report.sides.p1.turns[0].outcome, /confusion self-hit/);
  assert.match(report.sides.p1.turns[0].luck, /confusion self-hit/);
  assert.equal(report.sides.p1.turns[1].luck, undefined);
  assert.match(report.sides.p1.turns[1].outcome, /flinch/);
});

test('a guaranteed critical hit and a miss during Dig appear in outcomes without a chance claim', () => {
  const report = analyzeBattle(battle([
    ['|move|p1a: Left|Wicked Blow|p2a: Right', '|-crit|p2a: Right', '|-damage|p2a: Right|50/100'],
    ['|move|p1a: Left|Dig||[still]', '|-prepare|p1a: Left|Dig', '|move|p2a: Right|Body Press|p1a: Left|[miss]',
      '|-miss|p2a: Right|p1a: Left'],
  ]));
  assert.match(report.sides.p1.turns[0].outcome, /critical hit/);
  assert.match(report.sides.p2.turns[0].outcome, /critical hit/);
  assert.equal(report.sides.p2.turns[0].luck, undefined);
  assert.equal(report.sides.p2.turns[1].luck, undefined);
  assert.equal(report.sides.p2.turns[1].outcome.match(/missed/g).length, 1);
});

test('the knocked-out player can see what prevented a move before a replacement', () => {
  const report = analyzeBattle(battle([[
    '|move|p2a: Right|Dazzling Gleam|p1a: Left', '|-damage|p1a: Left|0 fnt', '|faint|p1a: Left',
    '|upkeep', '|switch|p1a: Other|Volcarona|100/100',
  ]]));
  assert.equal(report.sides.p1.turns[0].decision, false);
  assert.match(report.sides.p1.turns[0].outcome, /Dazzling Gleam brought Garchomp to 0%.*Garchomp fainted/);
});

test('PP drains and earlier uses can remove an otherwise comparable alternative', () => {
  const normal = '|move|p1a: Left|Tackle|p2a: Right';
  const crunch = '|move|p1a: Left|Crunch|p2a: Right';
  const options = { left: 'Snorlax', right: 'Gengar', preview: ['Snorlax', 'Volcarona', 'Clodsire'],
    opening: ['|-item|p2a: Right|Leftovers'] };
  const last = turns => analyzeBattle(battle(turns, options)).sides.p1.turns.at(-1);
  assert.equal(last([[normal], [crunch]]).comparison.alternative, 'Tackle');
  for (const drain of ['Spite', 'Eerie Spell', 'Grudge']) {
    assert.equal(last([[normal, '|-activate|p1a: Left|move: ' + drain + '|Tackle|4'], [crunch]]).stars, null);
  }
  const repeated = Array.from({ length: 18 }, () => [normal]);
  assert.equal(last([...repeated, ['|switch|p1a: Other|Volcarona|100/100'],
    ['|switch|p1a: Left|Snorlax|100/100'], [crunch]]).stars, null);
});

test('an omitted resolution target and opposing current-turn effects cannot change a pre-choice comparison', () => {
  const options = { left: 'Snorlax', right: 'Gengar', opening: ['|-item|p2a: Right|Leftovers'] };
  const setup = ['|move|p1a: Left|Tackle|p2a: Right', '|-immune|p2a: Right'];
  const variants = [
    ['|move|p1a: Left|Crunch|p2a: Right'],
    ['|-terastallize|p2a: Right|Fairy', '|move|p1a: Left|Crunch|p2a: Right', '|-resisted|p2a: Right'],
    ['|move|p1a: Left|Crunch||[still]'],
  ].map(turn => analyzeBattle(battle([setup, turn], options)).sides.p1.turns[1]);
  assert.ok(variants[0].comparison);
  for (const row of variants) assert.deepEqual(row.comparison, variants[0].comparison);
});

test('a replacement terrain expires without leaving its predecessor active', () => {
  const options = { left: 'Snorlax', right: 'Gengar', opening: ['|-item|p2a: Right|Leftovers'] };
  const report = analyzeBattle(battle([
    ['|move|p1a: Left|Tackle|p2a: Right', '|-fieldstart|move: Psychic Terrain'],
    ['|-fieldstart|move: Misty Terrain'],
    ['|-fieldend|Misty Terrain'],
    ['|move|p1a: Left|Crunch|p2a: Right'],
  ], options));
  assert.equal(report.sides.p1.turns[3].comparison.alternative, 'Tackle');
});
