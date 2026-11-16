'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { WebSocketServer } = require('ws');
const { PracticeSession } = require('../app/practice-session');
const { createApiServer } = require('../api/server');

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
      if (text === '|/trn FoulPlay,0,') socket.send('|updateuser| FoulPlay|1|1|{}');
    });
  });
  t.after(() => server.close());
  return sim;
}

function fakeWorkers() {
  const workers = [];
  const launch = ({ threads }) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), frames: [] });
    child.kill = () => setImmediate(() => child.emit('exit', 0));
    child.send = event => child.stdout.write(`${JSON.stringify(event)}\n`);
    child.stdin.on('data', data => { for (const line of String(data).trim().split('\n')) child.frames.push(JSON.parse(line).data); });
    setImmediate(() => child.send({ type: 'ready', protocol: 1, bot: 'foulplay', threads, searchMs: 100 }));
    workers.push(child);
    return child;
  };
  return { workers, launch };
}

async function setup(t, { engines } = {}) {
  const sim = await fakeSimulator(t);
  const fake = fakeWorkers();
  const api = createApiServer({ runtime: { python: 'python', worker: 'w.py', source: '/fp' }, launch: fake.launch });
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
  const requested = [];
  const session = new PracticeSession({ root: '/runtime', scripts: '/scripts', spawnChild, installed: () => true,
    verify: () => ({ promise: Promise.resolve({ ok: true }), cancel() {} }),
    engines: engines || (async engine => { requested.push(engine); return { url }; }) });
  t.after(() => session.stop());
  return { sim, session, workers: fake.workers, spawned, requested, api };
}

test('starts the simulator and an engine session, then logs the bot in', async t => {
  const { session, requested, spawned, workers } = await setup(t);
  const ready = once(session, 'ready');
  const result = await session.start({ opponent: 'foulplay', preset: 'balanced', engine: 'local' });
  assert.deepEqual(result, { ok: true });
  const [connection] = await ready;
  assert.deepEqual(requested, ['local']);
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
  await session.start({ opponent: 'foulplay', preset: 'quiet', engine: 'cloud' });
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
  const { session } = await setup(t, { engines: async () => { throw new Error('No cloud practice server is set up in this build.'); } });
  const result = await session.start({ opponent: 'foulplay', preset: 'quiet', engine: 'cloud' });
  assert.equal(result.ok, false);
  assert.equal(session.status().state, 'failed');
  assert.match(session.status().error, /No cloud practice server/);
});

test('fails when the engine connection drops mid-battle', async t => {
  const { session, workers } = await setup(t);
  await session.start({ opponent: 'foulplay', preset: 'quiet', engine: 'cloud' });
  const failure = once(session, 'failure');
  workers[0].send({ type: 'error', code: 'engine-failed' });
  assert.deepEqual(await failure, ['engine']);
  assert.equal(session.status().state, 'failed');
  assert.match(session.status().error, /Foul Play stopped/);
});

test('rejects other opponents, presets and engines', async t => {
  const { session } = await setup(t);
  assert.match((await session.start({ opponent: 'laplace', preset: 'full', engine: 'cloud' })).error, /Only Foul Play/);
  assert.equal((await session.start({ opponent: 'foulplay', preset: 'max', engine: 'cloud' })).ok, false);
  assert.equal((await session.start({ opponent: 'foulplay', preset: 'full', engine: 'gpu' })).ok, false);
  assert.equal(session.status().state, 'idle');
});

test('stop ends the API session and kills the simulator', async t => {
  const { session, spawned, api } = await setup(t);
  await session.start({ opponent: 'foulplay', preset: 'quiet', engine: 'cloud' });
  assert.equal(api.sessions.size, 1);
  session.stop();
  await until(() => api.sessions.size === 0, 'api session closed');
  assert.equal(spawned[0].killed, true);
  assert.equal(session.status().state, 'idle');
});
