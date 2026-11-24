'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { existsSync, readFileSync } = require('node:fs');
const vm = require('node:vm');
const { battleReviewCapture } = require('../app/battle-review-capture');
const { visibleProtocol, MAX_LINES, MAX_LINE_LENGTH, MAX_LOG_BYTES } = require('../app/battle-review-input');
const tools = battleReviewCapture();
const start = ['|gametype|singles', '|player|p1|Player', '|player|p2|Bot', '|gen|9',
  '|tier|[Gen 9] Random Battle', '|start', '|switch|p1a: Pikachu|Pikachu|251/251',
  '|switch|p2a: Blissey|Blissey|100/100', '|turn|1'];
const moveLine = '|move|p1a: Pikachu|Thunderbolt|p2a: Blissey';
const sim = path.resolve(__dirname, '../vendor/practice/dist/server/dist/sim');

function menu(rqid) {
  const side = { id: 'p1', name: 'Player', pokemon: ['Pikachu', 'Raichu'].map((name, i) => ({
    ident: 'p1: ' + name, details: name + ', L90, F', condition: '251/251', active: !i,
    stats: { atk: 200, def: 130, spa: 160, spd: 150, spe: 181 }, moves: ['thunderbolt', 'surf'],
    item: 'lightball', ability: 'lightningrod', baseAbility: 'lightningrod', teraType: 'Water', terastallized: '',
    reviving: false, commanding: false, ignored: 'omitted',
  })) };
  return { side, rqid, active: [{ canTerastallize: 'Water', moves: [
    { move: 'Thunderbolt', id: 'thunderbolt', pp: 22, maxpp: 24, target: 'normal', disabled: false },
    { move: 'Surf', id: 'surf', pp: 21, maxpp: 24, target: 'allAdjacent', disabled: false },
  ] }] };
}

function finish(recorder, queue) {
  const raw = recorder.snapshot();
  const mapping = new Map(raw.decisions.map(row => [row.boundary, null]));
  const { log } = visibleProtocol(queue, MAX_LINES, MAX_LINE_LENGTH, MAX_LOG_BYTES, mapping);
  return { log, capture: tools.sanitize(raw, 'p1', log, mapping) };
}

test('own menu and exact request boundary survive projection while chat, private extras and later events stay out', () => {
  const recorder = tools.recorder('Player');
  const queue = [...start, '|request|secret', '|c|Player|unrelated'];
  const req = menu(2);
  req.extra = { seed: 'hidden-truth' };
  recorder.receive(req, null, queue.length);
  req.side.pokemon[0].item = 'changedafterrequest';
  req.active[0].moves[0].pp = 1;
  recorder.send('/choose move 1 terastallize|2');
  const next = ['|-terastallize|p1a: Pikachu|Water', moveLine, '|-miss|p1a: Pikachu|p2a: Blissey', '|win|Bot'];
  recorder.protocol(next.join('\n'));
  const { capture, log } = finish(recorder, [...queue, ...next]);
  const [row] = capture.decisions;
  assert.deepEqual([row.turn, row.boundary, row.choice], [1, 9, 'move 1 terastallize']);
  assert.equal(row.request.side.pokemon[0].item, 'lightball');
  assert.equal(row.request.active[0].moves[0].pp, 22);
  assert.equal(row.request.side.pokemon[0].condition, '251/251');
  assert.doesNotMatch(JSON.stringify(capture), /ignored|omitted|hidden-truth|changedafterrequest/);
  assert.doesNotMatch(log.split('\n').slice(0, row.boundary).join('\n'), /secret|unrelated|terastallize|miss|251\/251/);
  assert.deepEqual(tools.sanitize(capture, 'p1', log), capture);
});

test('undo and resubmit keeps a visibly resolved final selection, then records a distinct replacement within the turn', () => {
  const recorder = tools.recorder('Player');
  const queue = [...start];
  recorder.receive(menu(2), null, queue.length);
  recorder.send('/choose move 2|2');
  recorder.send('/undo');
  recorder.send('/choose move 1|2');
  const knockout = [moveLine, '|move|p2a: Blissey|Seismic Toss|p1a: Pikachu', '|faint|p1a: Pikachu'];
  recorder.protocol(knockout.join('\n'));
  queue.push(...knockout);
  const replacement = menu(4);
  delete replacement.active;
  replacement.forceSwitch = [true];
  replacement.side.pokemon[0].condition = '0 fnt';
  recorder.receive(replacement, null, queue.length);
  recorder.send('/switch 2|4');
  const events = ['|switch|p1a: Raichu|Raichu|251/251', '|turn|2'];
  recorder.protocol(events.join('\n'));
  queue.push(...events);
  recorder.receive({ ...menu(6), wait: true }, null, queue.length);
  recorder.protocol('|win|Bot');
  const { capture } = finish(recorder, [...queue, '|win|Bot']);
  assert.deepEqual(capture.decisions.map(r => [r.rqid, r.turn, r.boundary, r.choice]),
    [[2, 1, 9, 'move 1'], [4, 1, 12, 'switch 2']]);
  assert.ok(capture.decisions[1].request.forceSwitch[0]);
  assert.equal(capture.skipped, 0);
});

test('hidden restrictions discard the rejected submission and keep the revised menu', () => {
  const recorder = tools.recorder('Player');
  const original = menu(2);
  original.active[0].maybeTrapped = true;
  recorder.receive(original, null, start.length);
  recorder.send('/switch 2|2');
  recorder.protocol('|error|[Unavailable choice] Cannot switch: trapped');
  const update = menu(3);
  update.update = true;
  update.active[0].trapped = true;
  update.active[0].moves[1].disabled = true;
  recorder.receive(update, null, start.length);
  recorder.send('/move 1|3');
  recorder.protocol(moveLine + '\n|win|Player');
  const { capture } = finish(recorder, [...start, moveLine, '|win|Player']);
  assert.equal(capture.skipped, 1);
  assert.deepEqual(capture.decisions.map(row => row.rqid), [3]);
  assert.equal(capture.decisions[0].request.active[0].moves[1].disabled, true);
  assert.equal(capture.decisions[0].request.active[0].trapped, true);
});

test('duplicates, wrong seats, old requests, sent choices on rejoin and ambiguous actions never become decisions', () => {
  const act = '/move 1|2';
  const variants = [
    (r, q) => { q.side.name = 'Bot'; r.receive(q, null, 9); r.send(act); },
    (r, q) => { q.side.pokemon[1].ident = 'p2: Raichu'; r.receive(q, null, 9); r.send(act); },
    (r, q) => { r.receive(q, 'move 1', 9); r.send(act); },
    (r, q) => { r.receive(q, null, 9); r.send(act); r.receive(q, null, 9); r.send(act); },
    (r, q) => { r.receive(q, null, 9); r.send('/move 1|1'); r.send(act); },
    (r, q) => { r.receive(q, null, 9); r.send(act); r.send('/move 2|2'); },
    (r, q) => { r.receive(q, null, 9); r.send(act); r.send('/undo'); r.send('/move 2|2'); },
    (r, q) => { r.receive(q, null, 9); r.send(act); r.protocol('|callback|trapped|0'); r.send(act); },
    (r, q) => { r.receive(q, null, 9); r.send(act); r.protocol('|init|battle'); r.send(act); },
    (r, q) => { q.active[0].moves[0].pp = 0; r.receive(q, null, 9); r.send(act); },
    (r, q) => { q.active[0].trapped = true; r.receive(q, null, 9); r.send('/switch 2|2'); },
    (r, q) => { delete q.active[0].canTerastallize; r.receive(q, null, 9); r.send('/move 1 terastallize|2'); },
    (r, q) => { r.receive(q, null, 9); r.send(act); r.protocol('|win|Bot'); },
  ];
  for (const variant of variants) {
    const r = tools.recorder('Player');
    variant(r, menu(2));
    r.protocol(moveLine + '\n|win|Player');
    assert.deepEqual(r.snapshot().decisions, [], variant.toString());
  }
});

test('capture caps retained history and rejects malformed main-process offsets, side and format', () => {
  const r = tools.recorder('Player');
  const lines = [...start];
  for (let i = 0; i < tools.limit + 2; i++) {
    r.receive(menu(i + 1), null, lines.length);
    r.send('/move 1|' + (i + 1));
    r.protocol(moveLine);
    lines.push(moveLine);
  }
  r.protocol('|win|Player');
  const { log, capture } = finish(r, [...lines, '|win|Player']);
  assert.equal(capture.decisions.length, tools.limit);
  assert.equal(capture.truncated, true);
  assert.equal(tools.sanitize(capture, 'p2', log), null);
  assert.equal(tools.sanitize(capture, 'p1', log.replace('Random Battle', 'OU')), null);
  const bad = structuredClone(capture);
  bad.decisions[0].boundary = 1e7;
  assert.equal(tools.sanitize(bad, 'p1', log), null);
});

test('page hooks preserve direct and room sends, gate by seat and discard a replaced client queue', () => {
  const roomId = 'battle-gen9randombattle-8';
  let user = 'player';
  const sent = [];
  class Room {
    receiveRequest(request) { this.request = request; }
    add(data) { this.battle.stepQueue.push(...data.split('\n')); }
  }
  const room = Object.assign(new Room(), { id: roomId, battle: { stepQueue: [...start] } });
  const app = { rooms: { [roomId]: room }, user: { get: () => user }, socket: { readyState: 1 },
    send(...args) { sent.push(args); return 'sent'; } };
  const page = { app, BattleRoom: Room };
  assert.equal(tools.install(page, 'Player'), true);
  assert.equal(tools.install(page, 'Player'), true);
  assert.equal(page.__sdPracticeDecisionHistory(room), null);
  const req = menu(1);
  req.side.id = 'p2';
  for (const mon of req.side.pokemon) mon.ident = mon.ident.replace('p1:', 'p2:');
  room.receiveRequest(req);
  assert.equal(app.send(roomId + '|/choose move 1|1', true), 'sent');
  assert.equal(app.send('/timer off', roomId), 'sent');
  assert.deepEqual(sent, [[roomId + '|/choose move 1|1', true], ['/timer off', roomId]]);
  room.add('|move|p2a: Pikachu|Thunderbolt|p1a: Blissey\n|win|Player');
  room.battleEnded = true;
  const history = page.__sdPracticeDecisionHistory(room);
  const lines = [...room.battle.stepQueue];
  lines[1] = '|player|p1|Bot';
  lines[2] = '|player|p2|Player';
  assert.equal(tools.sanitize(history, 'p2', lines.join('\n')).decisions[0].request.side.id, 'p2');
  user = 'spectator';
  assert.equal(page.__sdPracticeDecisionHistory(room), null);
  user = 'player';
  room.battle.stepQueue = lines;
  assert.deepEqual(page.__sdPracticeDecisionHistory(room), { decisions: [], skipped: 1, truncated: false });
});

test('practice bootstrap observes the earliest possible socket delivery and skips a restored pending choice', async () => {
  const root = path.resolve(__dirname, '..');
  const shell = readFileSync(path.join(root, 'vendor/practice/practice-client.html'), 'utf8');
  const order = [...shell.matchAll(/<script defer src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(order.indexOf('battle-review-capture.js') >= 0 &&
    order.indexOf('battle-review-capture.js') < order.indexOf('client-bootstrap.js'));
  for (const restored of [false, true]) {
    let onReady, firstPacket;
    const roomId = 'battle-gen9randombattle-1';
    class Room {
      add(data) { this.battle.stepQueue.push(...data.split('\n')); }
      receiveRequest() {}
    }
    const room = Object.assign(new Room(), { id: roomId, battle: { stepQueue: [...start] } });
    const page = { URLSearchParams, BattleRoom: Room, Dex: {}, Storage: { prefs() {} }, setInterval() {},
      location: { protocol: 'file:', pathname: '/practice-client.html',
        search: '?port=12&human=Player&bot=Bot&token=' + 'a'.repeat(64) },
      document: { documentElement: { dataset: {} }, addEventListener(_event, callback) { onReady = callback; } },
      App: class {
        constructor() {
          page.app = this;
          this.rooms = { [roomId]: room };
          this.user = { get: () => 'player' };
          this.socket = { readyState: 1 };
          firstPacket = Promise.resolve().then(() => {
            room.receiveRequest(menu(1), restored ? 'move 1' : null);
            this.send('/choose move 1|1', roomId);
            room.add(moveLine + '\n|win|Player');
            room.battleEnded = true;
          });
        }
        send() {}
        on() {}
      } };
    page.window = page;
    const context = vm.createContext(page);
    for (const file of ['app/battle-review-capture.js', 'vendor/practice/client-bootstrap.js']) {
      vm.runInContext(readFileSync(path.join(root, file), 'utf8'), context);
    }
    onReady();
    await firstPacket;
    const history = page.__sdPracticeDecisionHistory(room);
    assert.equal(history.decisions.length, restored ? 0 : 1);
    assert.equal(history.skipped, restored ? 1 : 0);
    if (!restored) assert.equal(history.decisions[0].boundary, start.length);
  }
});

test('pinned simulator rejects a switch to reveal Shadow Tag, then accepts the corrected move after an undo', {
  skip: existsSync(path.join(sim, 'battle.js')) ? false : 'run npm run build:practice',
}, () => {
  const { Battle } = require(sim), { extractChannelMessages } = require(path.join(sim, 'battle'));
  const mon = (species, ability, moves) => ({ species, ability, moves, level: 80 });
  const r = tools.recorder('Player'), queue = [];
  let rqid = 0, menu;
  const battle = new Battle({ formatid: 'gen9randombattle', seed: [2, 3, 4, 5], supportCancel: true,
    p1: { name: 'Player', team: [mon('Pikachu', 'Static', ['Thunderbolt', 'Surf']), mon('Raichu', 'Static', ['Thunderbolt'])] },
    p2: { name: 'Bot', team: [mon('Gothitelle', 'Shadow Tag', ['Calm Mind']), mon('Blissey', 'Natural Cure', ['Protect'])] },
    send(type, data) {
      if (type === 'update') {
        const lines = extractChannelMessages(data.join('\n'), [1])[1];
        r.protocol(lines.join('\n'));
        queue.push(...lines);
      } else if (type === 'sideupdate' && data.startsWith('p1\n')) {
        if (data.startsWith('p1\n|request|')) {
          menu = JSON.parse(data.slice(12));
          menu.rqid = ++rqid;
          r.receive(menu, null, queue.length);
        } else r.protocol(data.slice(3));
      }
    } });
  try {
    battle.sendUpdates();
    assert.equal(menu.active[0].maybeTrapped, true);
    r.send('/switch 2|1');
    assert.equal(battle.choose('p1', 'switch 2'), false);
    assert.equal(menu.update, true);
    assert.equal(menu.active[0].trapped, true);
    r.send('/move 2|2');
    assert.equal(battle.choose('p1', 'move 2'), true);
    r.send('/undo');
    battle.undoChoice('p1');
    r.send('/move 1 terastallize|2');
    assert.equal(battle.choose('p1', 'move 1 terastallize'), true);
    assert.equal(battle.choose('p2', 'move 1'), true);
    battle.sendUpdates();
    battle.win('p1');
    battle.sendUpdates();
    const { capture, log } = finish(r, queue);
    assert.deepEqual(capture.decisions.map(row => [row.rqid, row.choice]), [[2, 'move 1 terastallize']]);
    assert.ok(capture.decisions[0].request.active[0].trapped);
    assert.doesNotMatch(log.split('\n').slice(0, capture.decisions[0].boundary).join('\n'), /Thunderbolt|Shadow Tag/);
  } finally { battle.destroy(); }
});

test('seeded pinned random battle supplies each private menu from only the player channel through a full game', {
  skip: existsSync(path.join(sim, 'battle.js')) ? false : 'run npm run build:practice',
}, () => {
  const { Battle } = require(sim);
  const { extractChannelMessages } = require(path.join(sim, 'battle'));
  const queue = [], recorder = tools.recorder('Player');
  let rqid = 0, latest = null;
  const battle = new Battle({ formatid: 'gen9randombattle', seed: [1, 2, 3, 4],
    p1: { name: 'Player' }, p2: { name: 'Bot' }, send(type, data) {
      if (type === 'update') {
        const visible = extractChannelMessages(data.join('\n'), [1])[1];
        recorder.protocol(visible.join('\n'));
        queue.push(...visible);
      } else if (type === 'sideupdate' && data.startsWith('p1\n|request|')) {
        latest = JSON.parse(data.slice(data.indexOf('|request|') + 9));
        latest.rqid = ++rqid;
        recorder.receive(latest, null, queue.length);
      }
    } });
  try {
    battle.sendUpdates();
    for (let i = 0; i < 500 && !battle.ended; i++) {
      let pick = '';
      if (!latest.wait) {
        if (latest.forceSwitch) {
          const slot = latest.side.pokemon.findIndex(mon => !mon.active && (mon.condition === '0 fnt') === latest.side.pokemon[0].reviving);
          pick = 'switch ' + (slot + 1);
        } else {
          const legal = latest.active[0].moves;
          let slot = legal.findIndex(move => !move.disabled && move.pp !== 0 && move.id === 'knockoff');
          if (slot < 0) slot = legal.findIndex(move => !move.disabled && move.pp !== 0);
          pick = 'move ' + (slot + 1);
        }
        recorder.send('/choose ' + pick + '|' + rqid);
      }
      battle.makeChoices(pick, battle.p2.activeRequest?.wait ? '' : 'default');
      battle.sendUpdates();
    }
    assert.ok(battle.ended);
    const { log, capture } = finish(recorder, queue);
    assert.ok(capture.decisions.length >= 12);
    assert.ok(capture.decisions.some(row => row.request.forceSwitch));
    assert.ok(capture.decisions.some(row => row.turn === 1 && row.request.active));
    assert.equal(capture.skipped, 0);
    for (const row of capture.decisions) {
      const prefix = log.split('\n').slice(0, row.boundary);
      assert.equal(prefix.filter(line => line.startsWith('|turn|')).at(-1), '|turn|' + row.turn);
      assert.ok(row.request.side.pokemon.every(mon => mon.ident.startsWith('p1: ')));
    }
  } finally { battle.destroy(); }
});
