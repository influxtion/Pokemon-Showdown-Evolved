'use strict';

// The simple practice bots (app/simple-bots.js), with the move and species data of the simulator the
// app ships. Skipped until that simulator is built (`npm run build:practice`).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalBot, Picker, Tracker, loadData, legalOptions, battleView, command } = require('../app/simple-bots');

const SERVER = path.resolve(__dirname, '../vendor/practice/dist/server');
const built = fs.existsSync(path.join(SERVER, 'dist/data/moves.js'));
const skip = built ? false : 'the practice simulator is not built';
const data = built ? loadData(SERVER) : null;

const STATS = { atk: 200, def: 200, spa: 200, spd: 200, spe: 200 };

// One Pokemon as the picker sees it.
function mon(species, types, { moves = [], hp = 300, maxhp = 300, slot, status = null, stats = {}, ability = null } = {}) {
  return { name: species, species, slot, level: 100, types, baseTypes: types, stats: { hp: maxhp, ...STATS, ...stats },
    hp, maxhp, status, boosts: {}, moves, ability, teraType: null, terastallized: false };
}

function view(me, foe, { party = [], turn = 1, foeConditions = {} } = {}) {
  return { turn, me, foe, party: Object.fromEntries(party.map(value => [value.slot, value])), foeConditions };
}

function request(moves, { party = 6, fainted = [], force = false, trapped = false, tera = false, disabled = [], noPp = [] } = {}) {
  const pokemon = Array.from({ length: party }, (_, index) => ({ ident: `p2: Mon${index + 1}`,
    condition: fainted.includes(index + 1) ? '0 fnt' : '100/100', active: index === 0 }));
  const value = { rqid: 3, side: { id: 'p2', pokemon } };
  if (force) value.forceSwitch = [true];
  else {
    value.active = [{ moves: moves.map(id => ({ id, move: id, pp: noPp.includes(id) ? 0 : 10, maxpp: 16, disabled: disabled.includes(id) })),
      trapped, canTerastallize: tera ? 'Water' : undefined }];
  }
  return value;
}

const choose = (kind, state, req, rng) => new Picker(kind, data, rng).choose(state, req);

// A small seeded generator, so the Random bot's test is repeatable.
function seeded(seed) {
  return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
}

test('legal options skip disabled and empty moves and fainted Pokemon', () => {
  const options = legalOptions(request(['surf', 'tackle', 'toxic'], { fainted: [3], disabled: ['tackle'], noPp: ['toxic'] }));
  assert.deepEqual(options.moves.map(move => move.id), ['surf']);
  assert.deepEqual(options.switches, [2, 4, 5, 6]);
  assert.equal(options.canTera, false);
});

test('a forced switch has no moves, and a trapped Pokemon has no switches', () => {
  const forced = legalOptions(request([], { force: true }));
  assert.deepEqual([forced.moves, forced.switches], [[], [2, 3, 4, 5, 6]]);
  const trapped = legalOptions(request(['surf'], { trapped: true }));
  assert.deepEqual([trapped.moves.map(move => move.id), trapped.switches], [['surf'], []]);
});

test('commands use the move position in the request', () => {
  const req = request(['tackle', 'surf']);
  assert.equal(command({ move: 'surf' }, req), '/choose move 2');
  assert.equal(command({ move: 'surf', tera: true }, req), '/choose move 2 terastallize');
  assert.equal(command({ slot: 4 }, req), '/choose switch 4');
  assert.equal(command({ move: 'thunderbolt' }, req), '/choose default');
  assert.equal(command(null, req), '/choose default');
});

test('Random is always legal and mostly attacks', { skip }, () => {
  const picker = new Picker('random', data, seeded(1));
  const state = view(mon('Blastoise', ['Water']), mon('Charizard', ['Fire', 'Flying']));
  const req = request(['surf', 'tackle', 'icebeam'], { fainted: [2], disabled: ['tackle'] });
  const picks = Array.from({ length: 400 }, () => picker.choose(state, req));
  assert.ok(picks.every(pick => ['surf', 'icebeam'].includes(pick.move) || [3, 4, 5, 6].includes(pick.slot)));
  const switches = picks.filter(pick => pick.slot !== undefined).length;
  assert.ok(switches > 20 && switches < 110, String(switches));
});

test('Greedy picks the biggest hit', { skip }, () => {
  const state = view(mon('Blastoise', ['Water']), mon('Charizard', ['Fire', 'Flying']));
  assert.equal(choose('greedy', state, request(['tackle', 'surf', 'icebeam', 'protect'])).move, 'surf');
});

test('Greedy avoids immunities', { skip }, () => {
  const ghost = view(mon('Garchomp', ['Dragon', 'Ground']), mon('Gengar', ['Ghost', 'Poison']));
  assert.equal(choose('greedy', ghost, request(['bodyslam', 'earthquake'])).move, 'earthquake');
  const flying = view(mon('Garchomp', ['Dragon', 'Ground']), mon('Corviknight', ['Flying', 'Steel']));
  assert.equal(choose('greedy', flying, request(['earthquake', 'dragonclaw'])).move, 'dragonclaw');
  const levitate = view(mon('Garchomp', ['Dragon', 'Ground']), mon('Rotom', ['Electric', 'Ghost'], { ability: 'levitate' }));
  assert.equal(choose('greedy', levitate, request(['earthquake', 'dragonclaw'])).move, 'dragonclaw');
});

test('Greedy never switches by choice but picks a good switch when forced', { skip }, () => {
  const party = [mon('Venusaur', ['Grass', 'Poison'], { moves: ['gigadrain'], slot: 2 }),
    mon('Gyarados', ['Water', 'Flying'], { moves: ['waterfall'], slot: 3 })];
  const state = view(mon('Scizor', ['Bug', 'Steel']), mon('Charizard', ['Fire', 'Flying']), { party });
  assert.equal(choose('greedy', state, request(['bulletpunch'], { party: 3 })).move, 'bulletpunch');
  assert.equal(choose('greedy', state, request([], { party: 3, force: true })).slot, 3);
});

test('Heuristic takes a KO', { skip }, () => {
  const state = view(mon('Blastoise', ['Water']), mon('Charizard', ['Fire', 'Flying'], { hp: 30 }));
  assert.equal(choose('heuristic', state, request(['stealthrock', 'surf', 'toxic'])).move, 'surf');
});

test('Heuristic sets Stealth Rock once', { skip }, () => {
  const picker = new Picker('heuristic', data);
  const state = view(mon('Garchomp', ['Dragon', 'Ground']), mon('Blissey', ['Normal'], { stats: { def: 400 }, maxhp: 700, hp: 700 }));
  assert.equal(picker.choose(state, request(['stealthrock', 'earthquake'])).move, 'stealthrock');
  assert.equal(picker.choose(state, request(['stealthrock', 'earthquake'])).move, 'earthquake');
  const rocksUp = { ...state, foeConditions: { stealthrock: 1 } };
  assert.equal(choose('heuristic', rocksUp, request(['stealthrock', 'earthquake'])).move, 'earthquake');
});

test('Heuristic skips status on immune targets', { skip }, () => {
  const sturdy = { def: 500, spd: 500 };
  const steel = view(mon('Toxapex', ['Poison', 'Water']), mon('Skarmory', ['Steel', 'Flying'], { stats: sturdy }));
  assert.notEqual(choose('heuristic', steel, request(['toxic', 'scald'])).move, 'toxic');
  const normal = view(mon('Toxapex', ['Poison', 'Water']), mon('Blissey', ['Normal'], { stats: sturdy, maxhp: 700, hp: 700 }));
  assert.equal(choose('heuristic', normal, request(['toxic', 'scald'])).move, 'toxic');
});

test('Heuristic heals when low', { skip }, () => {
  const state = view(mon('Toxapex', ['Poison', 'Water'], { hp: 100 }), mon('Blissey', ['Normal'], { stats: { atk: 50, spa: 50 } }));
  assert.equal(choose('heuristic', state, request(['scald', 'recover'])).move, 'recover');
});

test('Heuristic switches out of a bad matchup, but not twice in a row', { skip }, () => {
  const me = mon('Charizard', ['Fire', 'Flying'], { moves: ['flamethrower'] });
  const foe = mon('Tyranitar', ['Rock', 'Dark'], { moves: ['stoneedge'], stats: { atk: 350, def: 350, spd: 350 } });
  const party = [mon('Swampert', ['Water', 'Ground'], { moves: ['surf'], slot: 2 })];
  const picker = new Picker('heuristic', data);
  assert.equal(picker.choose(view(me, foe, { party, turn: 4 }), request(['flamethrower'], { party: 2 })).slot, 2);
  assert.equal(picker.choose(view(me, foe, { party, turn: 5 }), request(['flamethrower'], { party: 2 })).move, 'flamethrower');
});

test('the tracker follows switches, damage, status, boosts, Tera and hazards from the log', { skip }, () => {
  const tracker = new Tracker();
  for (const line of ['|switch|p1a: Garchomp|Garchomp, L77, F|100/100', '|turn|3', '|move|p1a: Garchomp|Earthquake|p2a: Rotom',
    '|-ability|p1a: Garchomp|Rough Skin', '|-boost|p1a: Garchomp|atk|2', '|-damage|p1a: Garchomp|46/100 brn',
    '|-terastallize|p1a: Garchomp|Steel', '|-sidestart|p1: Player|move: Stealth Rock']) tracker.line(line);
  const garchomp = tracker.sides.p1.mons.Garchomp;
  assert.equal(tracker.turn, 3);
  assert.equal(tracker.sides.p1.active, 'Garchomp');
  assert.deepEqual({ level: garchomp.level, hp: garchomp.hp, status: garchomp.status, boosts: garchomp.boosts, tera: garchomp.tera,
    ability: garchomp.ability, moves: [...garchomp.moves] },
  { level: 77, hp: 46, status: 'brn', boosts: { atk: 2 }, tera: 'Steel', ability: 'roughskin', moves: ['earthquake'] });
  assert.deepEqual(tracker.sides.p1.conditions, { stealthrock: 1 });

  // The picker's view of it: estimated stats from the species, Tera typing, HP from the share.
  const req = { rqid: 1, side: { id: 'p2', pokemon: [{ ident: 'p2: Rotom', details: 'Rotom-Wash, L86', condition: '250/250', active: true,
    stats: { atk: 150, def: 230, spa: 230, spd: 230, spe: 200 }, moves: ['hydropump'], ability: 'levitate', teraType: 'Water' }] },
  active: [{ moves: [{ id: 'hydropump', pp: 8, maxpp: 8 }] }] };
  const state = battleView(data, tracker, req);
  assert.deepEqual(state.me.types, ['Electric', 'Water']);
  assert.equal(state.me.ability, 'levitate');
  assert.deepEqual(state.foe.types, ['Steel']);
  assert.equal(state.foe.stats.hp, 293); // Base 108 HP at level 77 with Random Battle EVs and IVs.
  assert.ok(Math.abs(state.foe.hp - 293 * 0.46) < 1e-9);
});

test('the bot seat answers each request once the turn log is in, and starts fresh on a rematch', { skip }, async () => {
  const bot = new LocalBot({ kind: 'greedy', data, delayMs: 0 });
  const choices = [];
  bot.on('choice', choice => choices.push(choice));
  const room = 'battle-gen9randombattle-7';
  const req = { rqid: 4, side: { id: 'p2', pokemon: [{ ident: 'p2: Blastoise', details: 'Blastoise, L86', condition: '280/280', active: true,
    stats: STATS, moves: ['tackle', 'surf'] }] }, active: [{ moves: [{ id: 'tackle', pp: 35, maxpp: 56 }, { id: 'surf', pp: 15, maxpp: 24 }] }] };
  bot.send(`>battle-gen9randombattle-6\n|init|battle`);
  bot.send(`>${room}\n|init|battle\n|title|Player vs. GreedyBot`);
  bot.send(`>${room}\n|request|${JSON.stringify(req)}`);
  bot.send(`>${room}\n|switch|p1a: Charizard|Charizard, L84|100/100\n|switch|p2a: Blastoise|Blastoise, L86|280/280\n|turn|1`);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(choices.length, 1);
  assert.deepEqual({ room: choices[0].room, choice: choices[0].choice, rqid: choices[0].rqid }, { room, choice: '/choose move 2', rqid: 4 });

  // Waiting requests and other rooms are ignored.
  bot.send(`>${room}\n|request|{"wait":true,"side":{"id":"p2","pokemon":[]}}`);
  bot.send(`>battle-gen9randombattle-6\n|request|${JSON.stringify(req)}`);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(choices.length, 1);

  // A rejected choice falls back to the simulator's default instead of stalling.
  bot.send(`>${room}\n|error|[Invalid choice] Can't move: Blastoise doesn't have a move matching surf`);
  assert.equal(choices[1].choice, '/choose default');

  // Team preview has nothing to decide.
  bot.send(`>${room}\n|request|${JSON.stringify({ rqid: 5, teamPreview: true, side: req.side })}`);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(choices[2].choice, '/choose default');

  let closed = 0;
  bot.on('close', () => { closed += 1; });
  bot.close();
  bot.close();
  bot.send(`>${room}\n|request|${JSON.stringify(req)}`);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, 1);
  assert.equal(choices.length, 3);
});
