'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { visibleProtocol } = require('../app/battle-review-input');
const { analyzeBattle } = require('../app/battle-review-model');
const { attachPracticeReview } = require('../app/battle-review-practice');
const { createTacticalReviewer } = require('../app/battle-review-tactics');
const { openingWorlds, seed } = require('../app/battle-review-tactics-worlds');

const root = path.resolve(__dirname, '../vendor/practice/dist/server');
const sim = path.join(root, 'dist/sim');
const needsSim = { skip: existsSync(path.join(sim, 'battle.js')) ? false : 'run npm run build:practice' };
function engine() {
  return { ...require(sim), extractChannelMessages: require(path.join(sim, 'battle')).extractChannelMessages };
}
function createGame(index, otherTeam) {
  const { Battle } = engine();
  return new Battle({ formatid: 'gen9randombattle', seed: [1, 2, 3, 4],
    p1: { name: 'Player', seed: [index + 1, 2, 3, 4] },
    p2: { name: 'Opponent', seed: [index, 7, 6, 5], team: otherTeam } });
}
function snapshot(game, choice, side = 'p1') {
  const channel = Number(side[1]);
  const visible = engine().extractChannelMessages(game.log.join('\n'), [channel])[channel];
  const prefix = visibleProtocol([...visible, '|tie'], 30000, 16384, 2097152).log.split('\n').slice(0, -1);
  const decision = { turn: game.turn, request: structuredClone(game[side].activeRequest), choice };
  return { prefix, decision };
}
const evaluate = ({ prefix, decision }) => createTacticalReviewer(root)(prefix, decision);

test('swapping hidden bench truth and all future actions behind the same own snapshot preserves the comparison', needsSim, () => {
  const original = createGame(0);
  const replacement = structuredClone(original.p2.team);
  [replacement[1], replacement[2]] = [replacement[2], replacement[1]];
  const other = createGame(0, replacement);
  try {
    const first = snapshot(original, 'move 1'), second = snapshot(other, 'move 1');
    assert.deepEqual(first, second);
    original.makeChoices('move 1', 'move 1');
    other.makeChoices('switch 2', 'switch 2');
    assert.notDeepEqual(original.log, other.log);
    const actual = evaluate(first);
    assert.equal(actual.status, 'compared');
    assert.deepEqual(actual, evaluate(second));
    const changed = evaluate({ prefix: first.prefix, decision: { ...first.decision, choice: 'move 1 terastallize' } });
    assert.equal(changed.status, 'compared');
    assert.deepEqual(changed.candidates.map(({ played, ...row }) => row), actual.candidates.map(({ played, ...row }) => row));
    assert.deepEqual(actual.candidates.map(row => row.choice), [
      'move 1', 'move 1 terastallize', 'move 2', 'move 2 terastallize', 'move 3', 'move 3 terastallize',
      'move 4', 'move 4 terastallize', 'switch 2', 'switch 3', 'switch 4', 'switch 5', 'switch 6',
    ]);
    assert.ok(actual.replies.some(row => row.reply.startsWith('Switch to ')));
    assert.ok(actual.replies.some(row => row.reply.includes('Tera ')));
    assert.equal(actual.replies.length, 8);
    assert.equal(actual.worlds, 2);
  } finally {
    original.destroy();
    other.destroy();
  }
});

test('independent pinned battle openings reproduce the reported switch and Tera costs on every shared joint reply', needsSim, () => {
  const game = createGame(0);
  const runtime = engine();
  try {
    const view = snapshot(game, 'move 1 terastallize');
    const report = evaluate(view);
    assert.equal(report.status, 'compared');
    const hypotheses = openingWorlds(runtime, view.prefix, view.decision);
    for (const candidate of report.candidates.filter(row => row.choice === 'switch 2' || row.played)) {
      const hp = { own: 0, foe: 0 }, kos = { own: 0, foe: 0 };
      for (const row of report.replies) {
        const world = JSON.parse(hypotheses[row.world - 1]);
        for (let i = 0; i < report.seedsPerReply; i++) {
          // Use native new battles from the complete hypothetical teams, independent
          // of the reviewer's fromJSON forks, score aggregation, and action parser.
          const [p1, p2] = world.sides.map(side => ({ name: side.name,
            team: side.team.split('').map(index => structuredClone(side.pokemon[Number(index) - 1].set)) }));
          const b = new runtime.Battle({ formatid: 'gen9randombattle', seed: world.prngSeed, p1, p2 });
          try {
            const digest = createHash('sha256').update('practice-review-v1/check-1/' + i).digest();
            b.prng = new runtime.PRNG([0, 2, 4, 6].map(n => digest.readUInt16BE(n)));
            const request = b.p2.activeRequest;
            let reply;
            if (row.reply.startsWith('Switch to ')) {
              const slot = request.side.pokemon.findIndex(mon => mon.details.split(',')[0] === row.reply.slice(10));
              reply = 'switch ' + (slot + 1);
            } else {
              const [name, tera] = row.reply.split(' · Tera ');
              const slot = request.active[0].moves.findIndex(move => move.move === name);
              reply = 'move ' + (slot + 1) + (tera ? ' terastallize' : '');
            }
            b.makeChoices(candidate.choice, reply);
            if (b.turn === 1 && !b.ended && !b.log.includes('|upkeep')) {
              assert.equal(b.requestState, 'switch');
              // This fixture contains a single pivot. Continue with the stated
              // first-healthy-slot policy using the native Side API.
              for (const side of b.sides.filter(side => side.requestState === 'switch')) {
                const slot = side.pokemon.findIndex(mon => !mon.isActive && mon.hp > 0);
                assert.ok(b.choose(side.id, 'switch ' + (slot + 1)));
              }
            }
            assert.ok(b.turn > 1 || b.ended || b.log.includes('|upkeep'));
            for (const [seat, key] of [['p1', 'own'], ['p2', 'foe']]) {
              for (const mon of b[seat].pokemon) {
                hp[key] += 100 * (1 - mon.hp / mon.maxhp);
                kos[key] += Number(mon.fainted);
              }
            }
          } finally { b.destroy(); }
        }
      }
      const count = report.replies.length * report.seedsPerReply;
      assert.equal(candidate.foeHP, Number((hp.foe / count).toFixed(1)));
      assert.equal(candidate.ownHP, Number((hp.own / count).toFixed(1)));
      assert.equal(candidate.foeKO, Number((kos.foe / count).toFixed(2)));
      assert.equal(candidate.ownKO, Number((kos.own / count).toFixed(2)));
      assert.equal(candidate.score, Number(((hp.foe - hp.own) / count).toFixed(1)));
    }
  } finally { game.destroy(); }
});

test('advancing a real early game requires matching observed events, stats, PP, and HP, with a separate turn limit', needsSim, () => {
  const game = createGame(11);
  try {
    const play = snapshot(game, 'move 1');
    const run = createTacticalReviewer(root);
    assert.equal(run(play.prefix, play.decision).status, 'compared');
    game.makeChoices('move 1', 'move 1');
    const next = snapshot(game, 'move 1');
    assert.equal(run(next.prefix, next.decision).status, 'compared');
    assert.match(run(next.prefix, { ...next.decision, turn: 5 }).reason, /first 4 turns/);
    for (const mutate of [
      row => row.prefix.splice(-1, 0, '|-boost|p1a: Magearna|atk|3'),
      row => row.decision.request.side.pokemon[1].stats.spe++,
      row => row.decision.request.active[0].moves[0].pp--,
      row => { row.decision.request.side.pokemon[1].condition = '1/200'; },
    ]) {
      const changed = structuredClone(next);
      mutate(changed);
      const runner = createTacticalReviewer(root);
      assert.equal(runner(play.prefix, play.decision).status, 'compared');
      assert.match(runner(changed.prefix, changed.decision).reason, /could not reproduce/);
    }
  } finally { game.destroy(); }
});

test('a second-seat request uses its own legal menu and a hidden restriction skips the complete row', needsSim, () => {
  const game = createGame(0);
  try {
    const view = snapshot(game, 'switch 2', 'p2');
    const report = evaluate(view);
    assert.equal(report.status, 'compared');
    assert.equal(report.played, 'Switch to ' + view.decision.request.side.pokemon[1].details.split(',')[0]);
    view.decision.request.active[0].maybeTrapped = true;
    assert.match(evaluate(view).reason, /complete selectable menu/);
    view.prefix.push('|-reviewcustomrules|');
    assert.match(evaluate(view).reason, /format/);
  } finally { game.destroy(); }
});

test('an observed own replacement can carry compatible worlds forward to the next joint move choice', needsSim, () => {
  const game = createGame(4);
  const run = createTacticalReviewer(root);
  const choice = command => {
    const { prefix, decision } = snapshot(game, command);
    return run(prefix, decision);
  };
  try {
    assert.equal(choice('move 1').status, 'compared');
    game.makeChoices('move 1', 'move 1');
    assert.deepEqual(game.p1.activeRequest.forceSwitch, [true]);
    assert.match(choice('switch 2').reason, /replacement/i);
    assert.ok(game.choose('p1', 'switch 2'));
    assert.equal(game.turn, 2);
    assert.equal(choice('move 1').status, 'compared');
  } finally { game.destroy(); }
});

test('a deadline discards an unfinished comparison while unexpected errors propagate', needsSim, t => {
  const game = createGame(0);
  try {
    const { prefix, decision } = snapshot(game, 'move 1');
    const run = createTacticalReviewer(root, { deadline: 500 });
    let reads = 0;
    const clock = t.mock.method(Date, 'now', () => ++reads < 120 ? 1 : 1000);
    const result = run(prefix, decision);
    clock.mock.restore();
    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /simulation budget/);
    assert.equal(result.candidates, undefined);
    assert.ok(reads >= 120);
    assert.throws(() => createTacticalReviewer(root)(prefix, { turn: 1, request: null }), TypeError);
  } finally { game.destroy(); }
});

test('a favored Hydro Pump can miss while a lower-scoring Ice Beam crits and freezes, without changing the predecision estimates', needsSim, () => {
  function finishedBranch(choice, chanceIndex) {
    const game = createGame(2);
    try {
      const { prefix, decision } = snapshot(game, choice);
      decision.boundary = prefix.length;
      decision.rqid = decision.request.rqid = 1;
      game.prng = new (engine().PRNG)(seed('actual-example', chanceIndex));
      game.makeChoices(choice, 'move 1'); // Double-Edge in each actual branch.
      game.win(game.p1);
      const visible = engine().extractChannelMessages(game.log.join('\n'), [1])[1];
      const log = visibleProtocol(visible, 30000, 16384, 2097152).log;
      const report = analyzeBattle(log);
      const capture = { version: 1, format: 'gen9randombattle', side: 'p1', decisions: [decision] };
      attachPracticeReview(report, log, { side: 'p1', capture, simulatorRoot: root });
      return { log, tactics: report.sides.p1.turns[0].requests[0].tactics };
    } finally { game.destroy(); }
  }
  const miss = finishedBranch('move 1', 243), fortunate = finishedBranch('move 2', 243);
  const hit = finishedBranch('move 1', 0);
  assert.match(miss.log, /\|-miss\|p1a: Lumineon\|p2a: Golem/);
  assert.match(miss.log, /\|faint\|p1a: Lumineon/);
  assert.match(fortunate.log, /\|move\|p1a: Lumineon\|Ice Beam\|p2a: Golem\n\|-crit\|p2a: Golem/);
  assert.match(fortunate.log, /\|-status\|p2a: Golem\|frz/);
  assert.match(fortunate.log, /\|cant\|p2a: Golem\|frz/);
  assert.doesNotMatch(hit.log, /\|-miss\|p1a: Lumineon/);
  assert.deepEqual(miss.tactics, hit.tactics);
  const estimates = result => result.tactics.candidates.map(({ played, ...metrics }) => metrics);
  assert.deepEqual(estimates(miss), estimates(fortunate));
  const rows = miss.tactics.candidates;
  assert.ok(rows.find(row => row.name === 'Hydro Pump').score > rows.find(row => row.name === 'Ice Beam').score);
});
