'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { createApiServer, RateLimiter, clientKey } = require('../server');
const { InferenceClient } = require('../client');

const ROOM = 'battle-gen9randombattle-1';
const FRAME = `>${ROOM}\n|init|battle\n|title|Player vs. FoulPlay`;

// Stands in for the Python worker: records stdin frames and lets a test emit events.
function fakeWorkers() {
  const workers = [];
  const launch = ({ threads, level, format }) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.frames = [];
    Object.assign(child, { threads, level, format });
    child.killed = false;
    child.kill = () => { if (!child.killed) { child.killed = true; setImmediate(() => child.emit('exit', 0)); } };
    child.emitEvent = event => child.stdout.write(`${JSON.stringify(event)}\n`);
    child.ready = (fields = {}) => child.emitEvent({ type: 'ready', protocol: 1, bot: 'foulplay', level, format, threads, searchMs: 100, ...fields });
    let buffer = '';
    child.stdin.on('data', data => {
      buffer += data;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) { child.frames.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); }
      child.emit('frames');
    });
    workers.push(child);
    return child;
  };
  return { workers, launch };
}

const runtime = { python: 'python', worker: 'worker.py', source: '/foul-play' };

async function start(t, options = {}) {
  const fake = fakeWorkers();
  const api = createApiServer({ runtime, launch: fake.launch, ...options });
  const url = await api.listen(0, '127.0.0.1');
  t.after(() => api.close());
  return { api, url, ...fake, client: new InferenceClient({ url, key: options.apiKey }) };
}

function nextMessage(socket, type) {
  return once(socket, type).then(([value]) => value);
}

test('reports bots, presets capped to the server limit, and capacity', async t => {
  const { client } = await start(t, { maxThreads: 2, maxSessions: 3 });
  const info = await client.info();
  assert.equal(info.api, 1);
  assert.deepEqual(info.bots.map(bot => [bot.id, bot.level]), [['foulplay', 'hard'], ['foulplay-medium', 'medium'], ['foulplay-casual', 'casual']]);
  assert.deepEqual(info.bots[0].formats, ['gen9randombattle', 'gen9ou']);
  assert.deepEqual(info.bots[1].formats, ['gen9randombattle']);
  assert.deepEqual(info.bots[0].presets, { quiet: 1, balanced: 2, full: 2 });
  assert.deepEqual(info.capacity, { active: 0, max: 3 });
});

test('relays frames to the worker and choices back to the client', async t => {
  const { client, workers } = await start(t);
  const session = await client.createSession({ bot: 'foulplay', preset: 'balanced' });
  assert.equal(session.threads, 2);
  assert.equal(session.socket, `/v1/sessions/${session.id}/socket`);
  const socket = await client.connect(session.id);
  workers[0].ready();
  assert.deepEqual(await socket.ready, { type: 'ready', bot: 'foulplay', level: 'hard', format: 'gen9randombattle', threads: 2, searchMs: 100 });
  assert.equal(workers[0].level, 'hard');
  assert.equal(workers[0].format, 'gen9randombattle');

  assert.equal(socket.send(FRAME), true);
  await once(workers[0], 'frames');
  assert.deepEqual(workers[0].frames, [{ type: 'frame', data: FRAME }]);

  const choice = nextMessage(socket, 'choice');
  workers[0].emitEvent({ type: 'choice', room: ROOM, turn: 3, choice: '/choose move earthquake terastallize', rqid: '7', elapsedMs: 250 });
  assert.deepEqual(await choice, { type: 'choice', room: ROOM, turn: 3, choice: '/choose move earthquake terastallize', rqid: '7', elapsedMs: 250 });

  const closed = once(socket, 'close');
  await client.deleteSession(session.id);
  await closed;
  assert.equal(workers[0].killed, true);
});

test('sends ready on connect when the worker loaded first', async t => {
  const { client, workers } = await start(t);
  const session = await client.createSession({ preset: 'quiet' });
  workers[0].ready();
  await new Promise(resolve => setTimeout(resolve, 20));
  const socket = await client.connect(session.id);
  assert.equal((await socket.ready).threads, 1);
});

test('rejects unknown bots, presets and extra keys', async t => {
  const { url } = await start(t);
  for (const body of [{ bot: 'laplace', preset: 'full' }, { bot: 'foulplay', preset: 'max' }, { bot: 'foulplay', preset: 'full', threads: 64 }]) {
    const response = await fetch(`${url}/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid-options');
  }
});

test('starts weaker levels with their own level', async t => {
  const { client, workers } = await start(t);
  const session = await client.createSession({ bot: 'foulplay-casual', preset: 'full' });
  assert.equal(session.level, 'casual');
  assert.equal(workers[0].level, 'casual');
  const socket = await client.connect(session.id);
  workers[0].ready({ searchMs: 20 });
  assert.equal((await socket.ready).level, 'casual');
});

test('ends a session whose worker reports another level or format', async t => {
  const { client, workers } = await start(t);
  const session = await client.createSession({ bot: 'foulplay-medium', preset: 'full' });
  const socket = await client.connect(session.id);
  workers[0].ready({ level: 'hard' });
  const [{ error }] = await once(socket, 'close');
  assert.equal(error.code, 'engine-failed');
});

const TEAM = 'Great Tusk @ Booster Energy\nAbility: Protosynthesis\nTera Type: Steel\nEVs: 252 Atk / 4 SpD / 252 Spe\nJolly Nature\n- Headlong Rush\n- Ice Spinner\n- Rapid Spin\n- Knock Off';
const OU_ROOM = 'battle-gen9ou-4';

test('starts an OU session with the bot team on the worker stdin only', async t => {
  const logs = [];
  const { client, workers, url } = await start(t, { log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })) });
  const session = await client.createSession({ bot: 'foulplay', preset: 'full', format: 'gen9ou', team: TEAM });
  assert.equal(session.format, 'gen9ou');
  assert.equal(workers[0].format, 'gen9ou');
  // Written as the worker starts, before this test could listen for it.
  if (!workers[0].frames.length) await once(workers[0], 'frames');
  assert.deepEqual(workers[0].frames, [{ type: 'team', data: TEAM }]);
  const status = await (await fetch(`${url}/v1/sessions/${session.id}`)).text();
  assert.doesNotMatch(status, /Tusk/);
  assert.doesNotMatch(logs.join('\n'), /Tusk/);

  const socket = await client.connect(session.id);
  workers[0].ready();
  assert.equal((await socket.ready).format, 'gen9ou');
  const frame = `>${OU_ROOM}\n|init|battle`;
  assert.equal(socket.send(frame), true);
  await once(workers[0], 'frames');
  assert.deepEqual(workers[0].frames.at(-1), { type: 'frame', data: frame });
  const choice = nextMessage(socket, 'choice');
  workers[0].emitEvent({ type: 'choice', room: OU_ROOM, turn: 1, choice: '/team 312456', rqid: '2', elapsedMs: 90 });
  assert.equal((await choice).choice, '/team 312456');
});

test('refuses OU without a team, a team outside OU, and levels that do not play OU', async t => {
  const { url } = await start(t, { maxSessionsPerClient: 10 });
  const cases = [
    [{ bot: 'foulplay', preset: 'full', format: 'gen9ou' }, 'invalid-team'],
    [{ bot: 'foulplay', preset: 'full', format: 'gen9ou', team: 'x\u0000y' }, 'invalid-team'],
    [{ bot: 'foulplay', preset: 'full', format: 'gen9ou', team: 'x'.repeat(9000) }, 'invalid-team'],
    [{ bot: 'foulplay', preset: 'full', team: TEAM }, 'invalid-team'],
    [{ bot: 'foulplay-medium', preset: 'full', format: 'gen9ou', team: TEAM }, 'invalid-format'],
    [{ bot: 'foulplay', preset: 'full', format: 'gen9uu', team: TEAM }, 'invalid-format'],
  ];
  for (const [body, code] of cases) {
    const response = await fetch(`${url}/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error.code, code);
  }
});

test('closes an OU session on Random Battle frames and reports an unreadable team', async t => {
  const { client, workers } = await start(t, { maxSessionsPerClient: 2 });
  const session = await client.createSession({ bot: 'foulplay', preset: 'full', format: 'gen9ou', team: TEAM });
  const socket = await client.connect(session.id);
  workers[0].ready();
  await socket.ready;
  socket.socket.send(JSON.stringify({ type: 'frame', data: FRAME }));
  const [{ error }] = await once(socket, 'close');
  assert.equal(error.code, 'invalid-message');

  const second = await client.createSession({ bot: 'foulplay', preset: 'full', format: 'gen9ou', team: TEAM });
  const socket2 = await client.connect(second.id);
  workers[1].emitEvent({ type: 'error', code: 'invalid-team' });
  const [{ error: teamError }] = await once(socket2, 'close');
  assert.equal(teamError.code, 'invalid-team');
});

test('requires the API key when one is configured', async t => {
  const apiKey = 'k'.repeat(40);
  const { url, client, workers } = await start(t, { apiKey });
  assert.equal((await fetch(`${url}/v1/info`)).status, 401);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  const session = await client.createSession({ preset: 'quiet' });
  await assert.rejects(new InferenceClient({ url }).connect(session.id), { status: 401 });
  workers[0].ready();
  const socket = await client.connect(session.id);
  assert.equal((await socket.ready).bot, 'foulplay');
});

test('limits concurrent sessions per client and across the server', async t => {
  const { client } = await start(t, { maxSessionsPerClient: 1, maxSessions: 4 });
  await client.createSession({ preset: 'quiet' });
  await assert.rejects(client.createSession({ preset: 'quiet' }), { status: 429, code: 'too-many-sessions' });

  const { client: second } = await start(t, { maxSessionsPerClient: 5, maxSessions: 1 });
  await second.createSession({ preset: 'quiet' });
  await assert.rejects(second.createSession({ preset: 'quiet' }), { status: 503, code: 'at-capacity', retryAfter: 30 });
});

test('rate limits how often a client can start sessions', async t => {
  const { client } = await start(t, { maxSessionsPerClient: 10, sessionBurst: 2, sessionsPerHour: 6 });
  const first = await client.createSession({ preset: 'quiet' });
  await client.createSession({ preset: 'quiet' });
  await client.deleteSession(first.id);
  const error = await client.createSession({ preset: 'quiet' }).catch(value => value);
  assert.equal(error.status, 429);
  assert.equal(error.code, 'rate-limited');
  assert.ok(error.retryAfter > 0 && error.retryAfter <= 600);
});

test('token bucket refills over time', () => {
  let time = 0;
  const limiter = new RateLimiter({ capacity: 2, perHour: 60, now: () => time });
  assert.equal(limiter.take('a').ok, true);
  assert.equal(limiter.take('a').ok, true);
  assert.equal(limiter.take('a').ok, false);
  assert.equal(limiter.take('b').ok, true);
  time += 60000;
  assert.equal(limiter.take('a').ok, true);
  time += 10 * 60000;
  limiter.prune();
  assert.equal(limiter.buckets.size, 0);
});

test('closes the session on frames outside the bot battle room', async t => {
  const { client, workers } = await start(t);
  const session = await client.createSession({ preset: 'quiet' });
  const socket = await client.connect(session.id);
  workers[0].ready();
  await socket.ready;
  socket.socket.send(JSON.stringify({ type: 'frame', data: '|/msg someone,hello' }));
  const [{ error }] = await once(socket, 'close');
  assert.equal(error.code, 'invalid-message');
  assert.equal(workers[0].frames.length, 0);
});

test('closes the session when a client floods frames', async t => {
  const { client, workers } = await start(t, { frameBurst: 3, framesPerSecond: 1 });
  const session = await client.createSession({ preset: 'quiet' });
  const socket = await client.connect(session.id);
  workers[0].ready();
  await socket.ready;
  for (let i = 0; i < 6; i++) socket.send(FRAME);
  const [{ error }] = await once(socket, 'close');
  assert.equal(error.code, 'rate-limited');
});

test('ends the session if the worker proposes a command that is not a move', async t => {
  const { client, workers } = await start(t);
  const session = await client.createSession({ preset: 'quiet' });
  const socket = await client.connect(session.id);
  workers[0].ready();
  await socket.ready;
  let choices = 0;
  socket.on('choice', () => choices++);
  workers[0].emitEvent({ type: 'choice', room: ROOM, turn: 1, choice: '/forfeit', rqid: '1' });
  const [{ error }] = await once(socket, 'close');
  assert.equal(error.code, 'engine-failed');
  assert.equal(choices, 0);
});

test('reports a worker crash to the client', async t => {
  const { client, workers } = await start(t);
  const session = await client.createSession({ preset: 'quiet' });
  const socket = await client.connect(session.id);
  workers[0].ready();
  await socket.ready;
  workers[0].emitEvent({ type: 'error', code: 'engine-failed' });
  const [{ error }] = await once(socket, 'close');
  assert.equal(error.code, 'engine-failed');
  assert.match(error.message, /Foul Play stopped/);
});

test('refuses browser WebSocket upgrades and second sockets', async t => {
  const { client, url } = await start(t);
  const session = await client.createSession({ preset: 'quiet' });
  const { WebSocket } = require('ws');
  const browser = new WebSocket(`${url.replace('http', 'ws')}/v1/sessions/${session.id}/socket`, { headers: { Origin: 'https://evil.example' } });
  const [request, response] = await once(browser, 'unexpected-response');
  assert.equal(response.statusCode, 403);
  request.destroy();
  await client.connect(session.id);
  await assert.rejects(client.connect(session.id), { status: 404 });
});

test('expires sessions that never connect, sit idle or run too long', async t => {
  let time = 1000;
  const { api, client, workers } = await start(t, { now: () => time, connectMs: 100, idleMs: 1000, lifetimeMs: 5000, maxSessionsPerClient: 5 });
  await client.createSession({ preset: 'quiet' });
  time += 200;
  api.sweep();
  assert.equal(api.sessions.size, 0);
  assert.equal(workers[0].killed, true);

  const session = await client.createSession({ preset: 'quiet' });
  const socket = await client.connect(session.id);
  workers[1].ready();
  await socket.ready;
  time += 1500;
  api.sweep();
  const [{ error }] = await once(socket, 'close');
  assert.equal(error.code, 'idle');
});

test('keys rate limits by IPv4 address, IPv6 /64 and trusted proxy hop', () => {
  const request = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });
  assert.equal(clientKey(request('::ffff:203.0.113.9'), false), '203.0.113.9');
  assert.equal(clientKey(request('2001:db8:1:2:3:4:5:6'), false), '2001:db8:1:2::/64');
  assert.equal(clientKey(request('2001:db8:1:2::9'), false), '2001:db8:1:2::/64');
  assert.equal(clientKey(request('10.0.0.2', '1.1.1.1, 198.51.100.4'), true), '198.51.100.4');
  assert.equal(clientKey(request('10.0.0.2', '1.1.1.1'), false), '10.0.0.2');
});
