'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { analyzeBattle } = require('../app/battle-review-model');
const { attachPracticeReview } = require('../app/battle-review-practice');
const { defensiveMatchups } = require('../app/battle-review-defenses');
const { BattleReviewInput } = require('../app/battle-review-input');
const { practiceGame, simulatorRoot } = require('./fixtures/practice-review.cjs');
const built = { skip: existsSync(path.join(simulatorRoot, 'dist/sim/battle.js')) ? false : 'run npm run build:practice' };
const roomId = 'battle-gen9randombattle-42';

test('only own Random Battle practice supplies the worker with a main-owned simulator path and capture', async () => {
  const received = [];
  const capture = { version: 1 };
  const service = new BattleReviewInput({ simulatorRoot, capture: () => ({ side: 'p2', log: '|tie', capture }),
    analyze: async (_text, _type, _signal, practice) => { received.push(practice); return {}; } });
  for (const [kind, room] of [['online', roomId], ['practice', 'battle-gen9ou-21'], ['practice', roomId]]) {
    assert.deepEqual(await service.review({ kind, roomId: room, simulatorRoot: 'untrusted', capture: {} }), { ok: true });
  }
  assert.deepEqual(received, [undefined, undefined, { simulatorRoot, side: 'p2', capture }]);
});

test('each evaluation receives only its request and the public prefix ending at its boundary', built, () => {
  const game = practiceGame(1, 4, 'p2');
  const { log, capture } = game;
  const report = analyzeBattle(log);
  let count = 0;
  attachPracticeReview(report, log, { ...game, simulatorRoot }, () => (prefix, decision) => {
    assert.deepEqual(prefix, log.split('\n').slice(0, decision.boundary));
    assert.doesNotMatch(prefix.join('\n'), /\|win\||\|request\||\|split\|/);
    assert.equal(decision.request.side.id, 'p2');
    count++;
    return { status: 'skipped', reason: 'Controlled fixture.' };
  });
  assert.ok(count > 1);
  assert.equal(count, capture.decisions.length);
  assert.equal(report.sides.p2.practice.captured, count);
  assert.equal(report.sides.p1.practice, undefined);
  const menu = report.sides.p2.turns[0].requests[0];
  assert.ok(menu.moves.some(move => move.endsWith(' PP')));
  assert.ok(menu.switches.every(label => label.includes('/')));
  assert.equal(menu.reason, 'Controlled fixture.');
  assert.doesNotMatch(JSON.stringify(report), /"stats":|"baseAbility":|"rqid":/);
});

test('invalid boundaries, side mismatches and impossible menu selections add no simulated choice', built, () => {
  const game = practiceGame(3, 1);
  const original = game.capture.decisions[0];
  for (const changes of [
    { boundary: 1 }, { turn: 2 }, { boundary: 100000 }, { rqid: -10 },
    { request: { ...original.request, side: { ...original.request.side, id: 'p2' } } },
    { choice: 'switch 1' }, { choice: 'move 5' }, { choice: 'move 1; garbage' },
  ]) {
    const report = analyzeBattle(game.log);
    const capture = { ...game.capture, decisions: [{ ...original, ...changes }] };
    let evaluated = false;
    attachPracticeReview(report, game.log, { ...game, capture, simulatorRoot }, () => () => { evaluated = true; });
    assert.equal(evaluated, false);
    assert.equal(report.sides.p1.practice.captured, 0);
    assert.equal(report.sides.p1.practice.unconfirmed, 1);
  }
});

test('an unavailable practice simulator preserves the recorded menu and factual result', built, async () => {
  const game = practiceGame(1, 2);
  const service = new BattleReviewInput({ capture: () => game });
  assert.deepEqual(await service.review({ kind: 'practice', roomId }), { ok: true });
  const { report } = service.status();
  assert.ok(report.winner);
  assert.ok(report.sides.p1.practice.captured);
  assert.equal(report.sides.p1.practice.compared, 0);
  assert.match(report.sides.p1.turns[0].requests[0].reason, /simulator/);
});

test('a conditional matchup uses the prior attack in this stint and the choices offered now', () => {
  const state = defensiveMatchups('p1');
  const request = { active: [{ canTerastallize: 'Flying' }], side: { pokemon: [
    { active: true, details: 'Pikachu, L80', condition: '50/180', ability: 'static' },
    { active: false, details: 'Rotom-Wash, L80', condition: '120/200', ability: 'levitate' },
    { active: false, details: 'Dragonite, L80', condition: '0 fnt', ability: 'multiscale' },
  ] } };
  state.observe('|switch|p2a: Tusk|Great Tusk, L80|100/100');
  state.observe('|turn|1');
  assert.equal(state.compare(request), null);
  state.observe('|move|p2a: Tusk|Earthquake|p1a: Pikachu');
  const result = state.compare(request);
  assert.equal(result.turn, 1);
  assert.equal(result.opponent, 'Great Tusk');
  assert.deepEqual(result.defenders.map(d => [d.action, d.factor, d.modifiers]),
    [['Stay with Pikachu', 2, ''], ['Tera Flying', 0, ''], ['Switch to Rotom-Wash', 2, 'Levitate']]);
  const uncertain = structuredClone(request);
  uncertain.active[0].maybeTrapped = true;
  assert.equal(state.compare(uncertain), null);
  state.observe('|-start|p1a: Pikachu|typechange|Water');
  assert.deepEqual(state.compare(request).defenders.map(d => d.action), ['Tera Flying', 'Switch to Rotom-Wash']);
  state.observe('|switch|p2a: Other|Mew, L80|100/100');
  assert.equal(state.compare(request), null);
  state.observe('|move|p2a: Other|Earthquake|p1a: Pikachu|[from] move: Metronome');
  assert.equal(state.compare(request), null);
  state.observe('|move|p2a: Other|Freeze-Dry|p1a: Pikachu');
  assert.equal(state.compare(request), null, 'special effectiveness does not use this chart');
  state.observe('|switch|p2a: Sylveon|Sylveon, L80|100/100');
  state.observe('|move|p2a: Sylveon|Hyper Voice|p1a: Pikachu');
  assert.equal(state.compare(request), null, 'Pixilate can change the nominal attack type');
  state.observe('|switch|p2a: Tusk|Great Tusk, L80|100/100');
  state.observe('|move|p2a: Tusk|Earthquake|p1a: Pikachu');
  state.observe('|-fieldstart|move: Gravity');
  assert.equal(state.compare(request), null);
  state.observe('|-fieldend|move: Gravity');
  assert.ok(state.compare(request));
  state.observe('|-activate|p1a: Pikachu|move: Skill Swap|[of] p2a: Tusk');
  assert.equal(state.compare(request), null);
});

test('a worker compares a real opening, keeps the later menu and can be cancelled before returning', built, async () => {
  const game = practiceGame(1, 5);
  const source = { kind: 'practice', roomId };
  const service = new BattleReviewInput({ capture: () => game, simulatorRoot });
  assert.deepEqual(await service.review(source), { ok: true });
  const previous = service.status().report;
  const seat = previous.sides.p1;
  assert.ok(seat.practice.captured >= 5 && seat.practice.compared >= 1);
  const result = seat.turns[0].requests[0].tactics;
  assert.equal(result.candidates.filter(c => c.played).length, 1);
  assert.ok(result.candidates.some(c => c.choice.startsWith('switch ')));
  assert.ok(result.candidates.some(c => c.choice.endsWith('terastallize')));
  assert.ok(result.replies.length >= result.worlds);
  const pending = service.review(source);
  await new Promise(resolve => setTimeout(resolve, 75));
  service.cancel();
  assert.deepEqual(await pending, { ok: true, cancelled: true });
  assert.equal(service.status().report, previous);
});
