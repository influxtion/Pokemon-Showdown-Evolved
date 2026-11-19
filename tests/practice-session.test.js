'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { WebSocketServer } = require('ws');
const { PracticeSession, childEnvironment } = require('../app/practice-session');
const { createApiServer } = require('../api/server');
const { InferenceClient } = require('../api/client');

const ROOM = 'battle-gen9randombattle-7';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 200; i++) { const value = check(); if (value) return value; await pause(10); }
  throw new Error(`Timed out: ${label}`);
}

// A simulator stand-in: logs the bot in and records everything it sends.
async function fakeSimulator(t) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const sim = { received: [], socket: null, server };
  server.on('connection', socket => {
    sim.socket = socket;
    socket.send('|challstr|4|abc');
    socket.on('message', data => {
      const text = data.toString();
      sim.received.push(text);
      const name = /^\|\/trn (\w+),0,$/.exec(text)?.[1];
      if (name) socket.send(`|updateuser| ${name}|1|1|{}`);
    });
  });
  t.after(() => server.close());
  return sim;
}

function fakeWorkers() {
  const workers = [];
  const launch = ({ threads, level, format }) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), frames: [],
      level, format, lines: [] });
    child.kill = () => setImmediate(() => child.emit('exit', 0));
    child.send = event => child.stdout.write(`${JSON.stringify(event)}\n`);
    child.stdin.on('data', data => {
      for (const line of String(data).trim().split('\n')) {
        const value = JSON.parse(line);
        child.lines.push(value);
        if (value.type === 'frame') child.frames.push(value.data);
      }
    });
    setImmediate(() => child.send({ type: 'ready', protocol: 1, bot: 'foulplay', level, format, threads, searchMs: 100 }));
    workers.push(child);
    return child;
  };
  return { workers, launch };
}

// Stands in for a simple bot: records the frames it gets and lets a test send a choice.
function fakeBots() {
  const bots = [];
  const createBot = kind => {
    const bot = Object.assign(new EventEmitter(), { kind, frames: [], ready: Promise.resolve({ type: 'ready' }), closed: false });
    bot.send = text => bot.frames.push(text);
    bot.close = () => { bot.closed = true; };
    bots.push(bot);
    return bot;
  };
  return { bots, createBot };
}

async function setup(t, { target, server = {}, localUrl } = {}) {
  const sim = await fakeSimulator(t);
  const fake = fakeWorkers();
  const api = createApiServer({ runtime: { python: 'python', worker: 'w.py', source: '/fp' }, launch: fake.launch, ...server });
  const url = await api.listen();
  t.after(() => api.close());
  const spawned = [];
  const spawnChild = () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 0 });
    child.kill = () => { child.killed = true; };
    setImmediate(() => { const address = sim.server.address(); if (address) child.stdout.write(`${JSON.stringify({ type: 'ready', port: address.port })}\n`); });
    spawned.push(child);
    return child;
  };
  const engines = [];
  const local = fakeBots();
  const session = new PracticeSession({ root: '/runtime', scripts: '/scripts', spawnChild, installed: () => true, createBot: local.createBot,
    verify: () => ({ promise: Promise.resolve({ ok: true }), cancel() {} }),
    checkInEveryMs: 20,
    target: target || (async engine => { engines.push(engine); return { url: engine === 'local' && localUrl ? localUrl() : url }; }) });
  t.after(() => session.stop());
  return { sim, session, workers: fake.workers, spawned, requested: () => engines.length, engines, api, url, bots: local.bots };
}

test('starts the simulator and an engine session, then logs the bot in', async t => {
  const { session, requested, spawned, workers } = await setup(t);
  const ready = once(session, 'ready');
  const result = await session.start({ opponent: 'foulplay', preset: 'balanced' });
  assert.deepEqual(result, { ok: true });
  const [connection] = await ready;
  assert.equal(requested(), 1);
  assert.equal(spawned.length, 1);
  assert.equal(workers.length, 1);
  assert.equal(connection.bot, 'FoulPlay');
  assert.equal(connection.human, 'Player');
  assert.match(connection.token, /^[a-f0-9]{64}$/);
  assert.equal(session.status().state, 'ready');
  assert.equal(session.status().threads, 2);
});

test('accepts only the player challenge and relays the battle both ways', async t => {
  const { session, sim, workers } = await setup(t);
  await session.start({ opponent: 'foulplay', preset: 'quiet' });
  sim.socket.send('|pm| Stranger| FoulPlay|/challenge gen9randombattle|gen9randombattle|||');
  sim.socket.send('|pm| Player| FoulPlay|/challenge gen9ou|gen9ou|||');
  sim.socket.send('|pm| Player| FoulPlay|/challenge gen9randombattle|gen9randombattle|||');
  await until(() => sim.received.includes('|/accept Player'), 'accept');
  assert.equal(sim.received.filter(text => text.startsWith('|/accept')).length, 1);

  const init = `>${ROOM}\n|init|battle\n|title|Player vs. FoulPlay`;
  sim.socket.send(init);
  sim.socket.send('>battle-gen9randombattle-99\n|init|battle');
  sim.socket.send(`>${ROOM}\n|request|{"active":[{}],"rqid":3}`);
  await until(() => workers[0].frames.length === 2, 'frames forwarded');
  assert.equal(workers[0].frames[0], init);
  await until(() => session.status().battle?.thinking, 'thinking');

  workers[0].send({ type: 'choice', room: ROOM, turn: 1, choice: '/choose move earthquake', rqid: '3', elapsedMs: 300 });
  await until(() => sim.received.includes(`${ROOM}|/choose move earthquake|3`), 'choice sent');
  assert.equal(session.status().battle.thinking, false);
  assert.equal(session.status().battle.elapsedMs, 300);

  sim.socket.send(`>${ROOM}\n|turn|4`);
  sim.socket.send(`>${ROOM}\n|win|Player`);
  await until(() => session.status().battle?.finished, 'finished');
  assert.equal(session.status().battle.result, 'win');
  assert.equal(session.status().battle.turn, 4);
  sim.socket.send(`>${ROOM}\n|deinit`);
  await pause(30);
  assert.equal(workers[0].frames.length, 4);
});

test('fails with the server message when the engine refuses the session', async t => {
  const { session } = await setup(t, { target: async () => { throw new Error('No cloud practice server is set up in this build.'); } });
  const result = await session.start({ opponent: 'foulplay', preset: 'quiet' });
  assert.equal(result.ok, false);
  assert.equal(session.status().state, 'failed');
  assert.match(session.status().error, /No cloud practice server/);
});

test('fails when the engine connection drops mid-battle', async t => {
  const { session, workers } = await setup(t);
  await session.start({ opponent: 'foulplay', preset: 'quiet' });
  const failure = once(session, 'failure');
  workers[0].send({ type: 'error', code: 'engine-failed' });
  assert.deepEqual(await failure, ['engine']);
  assert.equal(session.status().state, 'failed');
  assert.match(session.status().error, /Foul Play stopped/);
});

test('rejects other opponents, presets and engines', async t => {
  const { session } = await setup(t);
  assert.match((await session.start({ opponent: 'laplace', preset: 'full' })).error, /Choose a bot/);
  assert.equal((await session.start({ opponent: 'foulplay', preset: 'max' })).ok, false);
  assert.match((await session.start({ opponent: 'foulplay', preset: 'quiet', engine: 'laptop' })).error, /where Foul Play should run/);
  assert.equal(session.status().state, 'idle');
});

test('Foul Play uses the cloud by default and this computer only when asked', async t => {
  const { session, engines } = await setup(t);
  await session.start({ opponent: 'foulplay', preset: 'quiet' });
  assert.deepEqual(engines, ['cloud']);
  assert.equal(session.status().engine, 'cloud');
  session.stop();
  await session.start({ opponent: 'foulplay-medium', preset: 'quiet', engine: 'local' });
  assert.deepEqual(engines, ['cloud', 'local']);
  assert.equal(session.status().engine, 'local');
});

test('stop ends the API session and kills the simulator', async t => {
  const { session, spawned, api } = await setup(t);
  await session.start({ opponent: 'foulplay', preset: 'quiet' });
  assert.equal(api.sessions.size, 1);
  session.stop();
  await until(() => api.sessions.size === 0, 'api session closed');
  assert.equal(spawned[0].killed, true);
  assert.equal(session.status().state, 'idle');
});

test('Foul Play uses the full preset when the page sends none', async t => {
  const { session } = await setup(t);
  assert.deepEqual(await session.start({ opponent: 'foulplay' }), { ok: true });
  assert.equal(session.status().preset, 'full');
});

test('lists the Foul Play levels first, then the simple bots, hardest first', async t => {
  const { session } = await setup(t);
  const opponents = session.status().opponents;
  assert.deepEqual(opponents.map(bot => bot.id), ['foulplay', 'foulplay-medium', 'foulplay-casual', 'heuristic', 'greedy', 'random']);
  assert.deepEqual(opponents.map(bot => bot.name).slice(0, 3), ['Foul Play', 'Foul Play Medium', 'Foul Play Casual']);
  assert.deepEqual(opponents.map(bot => bot.difficulty), ['hard', 'medium', 'medium', 'easy', 'easy', 'easy']);
  assert.deepEqual(opponents.map(bot => bot.kind), ['Search bot', 'Search bot', 'Search bot', 'Rule-based bot', 'Rule-based bot', 'Rule-based bot']);
  assert.deepEqual(opponents[0].formats, ['gen9randombattle', 'gen9ou']);
  assert.ok(opponents.slice(1).every(bot => bot.formats.length === 1 && bot.formats[0] === 'gen9randombattle'));
  assert.deepEqual(opponents.map(bot => bot.local), [false, false, false, true, true, true]);
  assert.deepEqual(opponents.map(bot => bot.search), [true, true, true, false, false, false]);
});

test('starts a weaker level on the cloud with its own level', async t => {
  const { session, workers } = await setup(t);
  assert.deepEqual(await session.start({ opponent: 'foulplay-casual' }), { ok: true });
  assert.equal(workers[0].level, 'casual');
  assert.equal(workers[0].format, 'gen9randombattle');
  assert.match((await (session.stop(), session.start({ opponent: 'foulplay-medium', format: 'gen9ou' }))).error, /does not play/);
});

const OU_ROOM = 'battle-gen9ou-3';
const TEAMS = { player: 'Great Tusk||BoosterEnergy|Protosynthesis|HeadlongRush|Jolly|,252,,,4,252|||||',
  bot: 'Kingambit||Leftovers|SupremeOverlord|SuckerPunch|Adamant|252,252,,,4,|||||',
  botExport: 'Kingambit @ Leftovers\nAbility: Supreme Overlord\n- Sucker Punch' };

test('OU: sends the bot team to the engine, gives it to the bot in the simulator and keeps both for a rematch', async t => {
  const { session, sim, workers } = await setup(t);
  assert.match((await session.start({ opponent: 'foulplay', format: 'gen9ou' })).error, /both teams/);
  assert.match((await session.start({ opponent: 'foulplay', format: 'gen9ou', teams: { ...TEAMS, bot: 'a\n/forfeit' } })).error, /both teams/);
  const ready = once(session, 'ready');
  assert.deepEqual(await session.start({ opponent: 'foulplay', format: 'gen9ou', teams: TEAMS }), { ok: true });
  const [connection] = await ready;
  assert.equal(connection.format, 'gen9ou');
  assert.equal(connection.team, TEAMS.player);
  assert.equal(workers[0].format, 'gen9ou');
  assert.deepEqual(workers[0].lines[0], { type: 'team', data: TEAMS.botExport });
  assert.equal(session.status().format, 'gen9ou');
  assert.doesNotMatch(JSON.stringify(session.status()), /Kingambit|Tusk/);

  sim.socket.send('|pm| Player| FoulPlay|/challenge gen9randombattle|gen9randombattle|||');
  sim.socket.send('|pm| Player| FoulPlay|/challenge gen9ou|gen9ou|||');
  await until(() => sim.received.includes('|/accept Player'), 'accept');
  assert.equal(sim.received.filter(text => text.startsWith('|/accept')).length, 1);
  assert.ok(sim.received.includes(`|/utm ${TEAMS.bot}`));
  sim.socket.send('>battle-gen9randombattle-5\n|init|battle');
  sim.socket.send(`>${OU_ROOM}\n|init|battle`);
  await until(() => workers[0].frames.length === 1, 'frame forwarded');
  assert.equal(workers[0].frames[0], `>${OU_ROOM}\n|init|battle`);
  workers[0].send({ type: 'choice', room: OU_ROOM, turn: 1, choice: '/team 213456', rqid: '1', elapsedMs: 50 });
  await until(() => sim.received.includes(`${OU_ROOM}|/team 213456|1`), 'team order sent');

  sim.socket.send(`>${OU_ROOM}\n|win|FoulPlay`);
  await until(() => session.status().battle?.finished, 'finished');
  sim.received.length = 0;
  sim.socket.send('|pm| Player| FoulPlay|/challenge gen9ou|gen9ou|||');
  await until(() => sim.received.includes('|/accept Player'), 'rematch accepted');
  assert.ok(sim.received.includes(`|/utm ${TEAMS.bot}`));
  session.stop();
  assert.equal(session.teams, null);
});

test('plays a simple bot on this computer, with no cloud session', async t => {
  const { session, sim, bots, requested, api } = await setup(t);
  assert.deepEqual(await session.start({ opponent: 'greedy', preset: 'max' }), { ok: true });
  assert.equal(requested(), 0);
  assert.equal(api.sessions.size, 0);
  assert.equal(bots.length, 1);
  assert.equal(bots[0].kind, 'greedy');
  assert.equal(session.connection.bot, 'GreedyBot');
  assert.ok(sim.received.includes('|/trn GreedyBot,0,'));
  const status = session.status();
  assert.deepEqual([status.opponent, status.preset, status.threads], ['greedy', null, null]);

  sim.socket.send('|pm| Player| GreedyBot|/challenge gen9randombattle|gen9randombattle|||');
  await until(() => sim.received.includes('|/accept Player'), 'accept');
  sim.socket.send(`>${ROOM}
|init|battle
|title|Player vs. GreedyBot`);
  sim.socket.send(`>${ROOM}
|request|{"active":[{}],"rqid":3}`);
  await until(() => bots[0].frames.length === 2, 'frames handed to the bot');
  bots[0].emit('choice', { room: ROOM, choice: '/choose move 2', rqid: 3, elapsedMs: 40 });
  await until(() => sim.received.includes(`${ROOM}|/choose move 2|3`), 'choice sent');

  session.stop();
  assert.equal(bots[0].closed, true);
});

test('fails if a simple bot stops mid-battle', async t => {
  const { session, bots } = await setup(t);
  await session.start({ opponent: 'heuristic' });
  const failure = once(session, 'failure');
  bots[0].emit('close', {});
  assert.deepEqual(await failure, ['bot']);
  assert.match(session.status().error, /bot stopped unexpectedly/);
});

// ---- Waiting for a cloud engine -----------------------------------------------------------

test('waits in line while every cloud engine is busy, then starts by itself', async t => {
  const { session, api, url, workers } = await setup(t, { server: { maxSessions: 1, maxSessionsPerClient: 2 } });
  const other = new InferenceClient({ url });
  const busy = await other.createSession({ preset: 'quiet' });
  const ready = once(session, 'ready');
  const starting = session.start({ opponent: 'foulplay', preset: 'quiet' });
  await until(() => session.status().queue, 'queued');
  assert.deepEqual(session.status().queue, { position: 1, waiting: 1 });
  assert.equal(session.status().state, 'starting');
  assert.equal(api.queue.length, 1);
  await other.deleteSession(busy.id);
  await until(() => workers.length === 2, 'engine started for the queued player');
  assert.deepEqual(await starting, { ok: true });
  await ready;
  assert.equal(session.status().queue, null);
  assert.equal(api.queue.length, 0);
});

test('stopping while queued leaves the queue', async t => {
  const { session, api, url } = await setup(t, { server: { maxSessions: 1, maxSessionsPerClient: 2 } });
  await new InferenceClient({ url }).createSession({ preset: 'quiet' });
  session.start({ opponent: 'foulplay', preset: 'quiet' });
  await until(() => api.queue.length === 1, 'queued');
  session.stop();
  await until(() => api.queue.length === 0, 'left the queue');
  assert.equal(session.status().queue, null);
  assert.equal(session.status().state, 'idle');
});

test('a queued player can move to Foul Play on this computer', async t => {
  let localUrl = null;
  const { session, api, url, engines } = await setup(t, { server: { maxSessions: 1, maxSessionsPerClient: 2 }, localUrl: () => localUrl });
  const fake = fakeWorkers();
  const local = createApiServer({ runtime: { python: 'python', worker: 'w.py', source: '/fp' }, launch: fake.launch });
  localUrl = await local.listen();
  t.after(() => local.close());
  await new InferenceClient({ url }).createSession({ preset: 'quiet' });
  const starting = session.start({ opponent: 'foulplay', preset: 'quiet' });
  await until(() => session.status().queue, 'queued');
  assert.deepEqual(session.useEngine('local'), { ok: true });
  await until(() => fake.workers.length === 1, 'local engine started');
  assert.deepEqual(await starting, { ok: true });
  assert.deepEqual(engines, ['cloud', 'local']);
  assert.equal(session.status().engine, 'local');
  assert.equal(api.queue.length, 0, 'the cloud place was given up');
  assert.deepEqual(session.useEngine('cloud'), { ok: false }, 'only while queued');
});

test('the simulator child environment excludes inherited account and Python settings', () => {
  const original = process.env.SHOWDOWN_PASSWORD;
  process.env.SHOWDOWN_PASSWORD = 'must-not-propagate';
  try {
    const env = childEnvironment();
    assert.equal(env.SHOWDOWN_PASSWORD, undefined);
    assert.equal(env.PYTHONPATH, undefined);
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  } finally {
    if (original === undefined) delete process.env.SHOWDOWN_PASSWORD;
    else process.env.SHOWDOWN_PASSWORD = original;
  }
});
