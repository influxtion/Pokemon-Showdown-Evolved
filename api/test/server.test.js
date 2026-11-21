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
  assert.deepEqual(info.bots.map(bot => [bot.id, bot.level]), [['foulplay', 'hard'], ['foulplay-medium', 'medium'], ['foulplay-casual', 'casual'], ['metamon', 'trained']]);
  assert.deepEqual(info.bots[0].formats, ['gen9randombattle', 'gen9ou', 'gen9anythinggoes']);
  assert.deepEqual(info.bots[1].formats, ['gen9randombattle', 'gen9ou', 'gen9anythinggoes']);
  assert.deepEqual(info.bots[0].presets, { quiet: 1, balanced: 2, full: 2 });
  assert.deepEqual(info.capacity, { active: 0, max: 3, waiting: 0, queueMax: 20, checkInMs: 15000 });
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
    [{ bot: 'foulplay-medium', preset: 'full', format: 'gen9doublesou', team: TEAM }, 'invalid-format'],
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

test('a worker that stops reading cannot grow the API pipe indefinitely', { timeout: 5000 }, async t => {
  const { client, workers } = await start(t, { maxFrameBytes: 2048 });
  const session = await client.createSession({ preset: 'quiet' });
  const socket = await client.connect(session.id);
  workers[0].ready();
  await socket.ready;
  workers[0].stdin.pause();
  const closed = once(socket, 'close');
  for (let i = 0; i < 100; i++) socket.send(FRAME + '\n' + 'x'.repeat(1800));
  const [{ error }] = await closed;
  assert.equal(error.code, 'rate-limited');
  assert.equal(workers[0].killed, true);
  assert.ok(workers[0].stdin.writableLength < 7 * 2048);
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
  assert.match(error.message, /The bot stopped/);
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
  assert.equal(clientKey(request('2001:0DB8:0001:0002::9'), false), '2001:db8:1:2::/64');
  assert.equal(clientKey(request('2001:db8::1'), false), '2001:db8:0:0::/64');
  assert.equal(clientKey(request('2001:db8:0:0:1::9'), false), '2001:db8:0:0::/64');
  assert.equal(clientKey(request('::ffff:cb00:7109'), false), '203.0.113.9');
  assert.equal(clientKey(request('10.0.0.2', 'not-an-ip'), true), '10.0.0.2');
  assert.equal(clientKey(request('10.0.0.2', '1.1.1.1, 198.51.100.4'), true), '198.51.100.4');
  assert.equal(clientKey(request('10.0.0.2', '1.1.1.1'), false), '10.0.0.2');
});

// ---- Queue -----------------------------------------------------------------------------------

// A client that the server sees at its own address (trustProxy reads X-Forwarded-For), so one
// test can stand in for several players.
function player(url, address) {
  const fetcher = (target, init) => fetch(target, { ...init, headers: { ...init.headers, 'X-Forwarded-For': address } });
  return new InferenceClient({ url, fetcher });
}

test('a full server queues players who ask, in order, and starts them as engines free up', async t => {
  let time = 1000;
  const { api, url } = await start(t, { maxSessions: 1, trustProxy: true, now: () => time });
  const [a, b, c] = ['10.0.0.1', '10.0.0.2', '10.0.0.3'].map(address => player(url, address));
  const first = await a.createSession({ preset: 'quiet', queue: true });
  assert.ok(first.id, 'a free engine starts at once');
  const second = await b.createSession({ preset: 'quiet', queue: true });
  const third = await c.createSession({ preset: 'quiet', queue: true });
  assert.deepEqual([second.queued, second.position, second.waiting], [true, 1, 1]);
  assert.deepEqual([third.position, third.waiting], [2, 2]);
  assert.equal((await a.info()).capacity.waiting, 2);

  // Still busy: checking in keeps the place.
  assert.deepEqual(await c.checkIn(third.ticket).then(value => [value.queued, value.position]), [true, 2]);
  await a.deleteSession(first.id);
  // The free engine is held for the first in line: the third player cannot take it.
  assert.deepEqual(await c.checkIn(third.ticket).then(value => [value.queued, value.position]), [true, 2]);
  const started = await b.checkIn(second.ticket);
  assert.ok(started.id && !started.queued, 'the first in line gets the engine on its next check-in');
  assert.equal(api.sessions.size, 1);
  assert.deepEqual(await c.checkIn(third.ticket).then(value => [value.position, value.waiting]), [1, 1]);
});

test('without asking to queue, or with the queue full, a busy server still answers 503', async t => {
  const { url } = await start(t, { maxSessions: 1, maxQueue: 1, trustProxy: true });
  const [a, b, c, d] = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'].map(address => player(url, address));
  await a.createSession({ preset: 'quiet' });
  await assert.rejects(b.createSession({ preset: 'quiet' }), { status: 503, code: 'at-capacity' });
  assert.equal((await c.createSession({ preset: 'quiet', queue: true })).queued, true);
  await assert.rejects(d.createSession({ preset: 'quiet', queue: true }), { status: 503, code: 'at-capacity', message: /queue is full/ });
});

test('a new player cannot jump the queue when an engine frees up', async t => {
  const { url } = await start(t, { maxSessions: 1, trustProxy: true });
  const [a, b, c] = ['10.0.0.1', '10.0.0.2', '10.0.0.3'].map(address => player(url, address));
  const first = await a.createSession({ preset: 'quiet' });
  const waiting = await b.createSession({ preset: 'quiet', queue: true });
  await a.deleteSession(first.id);
  const late = await c.createSession({ preset: 'quiet', queue: true });
  assert.deepEqual([late.queued, late.position], [true, 2], 'the newcomer lines up behind');
  assert.ok((await b.checkIn(waiting.ticket)).id);
});

test('one place per player, leaving frees it, and a place expires without check-ins', async t => {
  let time = 1000;
  const { api, url } = await start(t, { maxSessions: 1, trustProxy: true, queueCheckInMs: 5000, now: () => time });
  const [a, b, c] = ['10.0.0.1', '10.0.0.2', '10.0.0.3'].map(address => player(url, address));
  await a.createSession({ preset: 'quiet' });
  const place = await b.createSession({ preset: 'quiet', queue: true });
  await assert.rejects(b.createSession({ preset: 'quiet', queue: true }), { status: 429, code: 'already-queued' });
  await b.leaveQueue(place.ticket);
  assert.equal(api.queue.length, 0);
  await assert.rejects(b.checkIn(place.ticket), { status: 404, code: 'ticket-not-found' });

  const other = await c.createSession({ preset: 'quiet', queue: true });
  time += 4000;
  api.sweep();
  assert.equal(api.queue.length, 1, 'still inside the check-in window');
  time += 2000;
  api.sweep();
  assert.equal(api.queue.length, 0, 'gone after missing check-ins');
  await assert.rejects(c.checkIn(other.ticket), { status: 404, code: 'ticket-not-found' });
});

test('an OU team waits in the queue and reaches only the worker that starts', async t => {
  const { url, workers } = await start(t, { maxSessions: 1, trustProxy: true });
  const fs = require('node:fs');
  const path = require('node:path');
  const team = fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures', 'ou-team.txt'), 'utf8');
  const [a, b] = ['10.0.0.1', '10.0.0.2'].map(address => player(url, address));
  const first = await a.createSession({ preset: 'quiet' });
  const place = await b.createSession({ preset: 'quiet', format: 'gen9ou', team, queue: true });
  assert.equal(workers.length, 1);
  await a.deleteSession(first.id);
  const session = await b.checkIn(place.ticket);
  assert.equal(session.format, 'gen9ou');
  const worker = workers[1];
  if (!worker.frames.length) await once(worker, 'frames');
  assert.equal(worker.frames[0].type, 'team');
  assert.equal(worker.frames[0].data, team);
});

test('the client falls back to a plain request on a server without the queue', async t => {
  const bodies = [];
  const fetcher = async (target, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.queue) return new Response(JSON.stringify({ error: { code: 'invalid-options', message: 'Choose a supported bot.' } }), { status: 400 });
    return new Response(JSON.stringify({ id: 'a'.repeat(64), threads: 1 }), { status: 201 });
  };
  const client = new InferenceClient({ url: 'http://127.0.0.1:9', fetcher });
  const session = await client.createSession({ preset: 'quiet', queue: true });
  assert.equal(session.id, 'a'.repeat(64));
  assert.deepEqual(bodies, [{ bot: 'foulplay', preset: 'quiet', queue: true }, { bot: 'foulplay', preset: 'quiet' }]);
});

test('Metamon is separately installed, OU-only, and uses the shared API with a model concurrency cap', async t => {
  const { client, workers } = await start(t, { metamonRuntime: { python: 'private-python', worker: 'metamon.py', root: '/metamon', formats: ['gen9ou'] }, maxSessionsPerClient: 2, maxThreads: 8 });
  assert.equal((await client.info()).bots.find(bot => bot.id === 'metamon').available, true);
  const options = { bot: 'metamon', preset: 'quiet', format: 'gen9ou', team: 'Kingambit\n- Sucker Punch' };
  const session = await client.createSession(options);
  assert.equal(session.threads, 4);
  assert.equal(workers[0].level, 'trained');
  assert.deepEqual(workers[0].frames, [], 'unused team export is not forwarded to Metamon');
  workers[0].ready({ bot: 'metamon' });
  const socket = await client.connect(session.id);
  assert.equal((await socket.ready).bot, 'metamon');
  const queued = await client.createSession({ ...options, queue: true });
  assert.equal(queued.queued, true, 'one model worker by default even when global slots are free');
  await client.deleteSession(session.id);
  const next = await client.checkIn(queued.ticket);
  assert.equal(next.bot, 'metamon');
});
test('Metamon cannot silently fall back to the Foul Play runtime', async t => {
  const { client } = await start(t);
  assert.equal((await client.info()).bots.find(bot => bot.id === 'metamon').available, false);
  await assert.rejects(client.createSession({ bot: 'metamon', preset: 'quiet', format: 'gen9ou', team: 'Kingambit\n- Sucker Punch' }), /not installed/);
});


const metamonRuntime = { python: 'python', worker: 'metamon.py', root: '/metamon', formats: ['gen9ou'] };
const modelOptions = { bot: 'metamon', preset: 'quiet', format: 'gen9ou', team: 'Kingambit\n- Sucker Punch', queue: true };
const foulOptions = { preset: 'quiet', queue: true };
const resourceOptions = extra => ({ threads: 4, memoryMb: 4096, reserveMb: 1024, foulplayMb: 512, metamonMb: 2048, availableMb: () => 16384, ...extra });

test('earliest eligible queue skips a capped Metamon, retains its place, and preserves both limits', async t => {
  const { url, api } = await start(t, { metamonRuntime, maxSessions: 2, maxMetamonSessions: 1, trustProxy: true });
  const [a,b,c,d,e] = [1,2,3,4,5].map(i => player(url, `10.1.0.${i}`));
  const model = await a.createSession(modelOptions);
  const firstFoul = await b.createSession(foulOptions);
  const waitingModel = await c.createSession(modelOptions);
  const waitingFoul = await d.createSession(foulOptions);
  const laterFoul = await e.createSession(foulOptions);
  await b.deleteSession(firstFoul.id);
  assert.equal((await c.checkIn(waitingModel.ticket)).queued, true);
  assert.equal((await e.checkIn(laterFoul.ticket)).queued, true, 'later poll cannot overtake eligible Foul Play');
  const startedFoul = await d.checkIn(waitingFoul.ticket);
  assert.equal(startedFoul.bot, 'foulplay');
  assert.equal(api.sessions.size, 2);
  assert.equal((await e.checkIn(laterFoul.ticket)).queued, true, 'total cap remains enforced');
  await a.deleteSession(model.id);
  assert.equal((await e.checkIn(laterFoul.ticket)).queued, true, 'Metamon regains priority when eligible');
  assert.equal((await c.checkIn(waitingModel.ticket)).bot, 'metamon');
  assert.equal(api.sessions.size, 2);
});

test('new Foul Play can use spare capacity behind only blocked Metamon tickets', async t => {
  const { url } = await start(t, { metamonRuntime, maxSessions: 3, trustProxy: true });
  const [a,b,c] = [1,2,3].map(i => player(url, `10.2.0.${i}`));
  await a.createSession(modelOptions);
  const waiting = await b.createSession(modelOptions);
  assert.equal(waiting.queued, true);
  assert.equal((await c.createSession(foulOptions)).bot, 'foulplay');
  assert.equal((await b.checkIn(waiting.ticket)).position, 1);
});

test('CPU reservations select eligible work and concurrent polls cannot exceed the budget', async t => {
  const { url, api } = await start(t, { maxSessions: 8, trustProxy: true, resources: resourceOptions({ threads: 3 }) });
  const [a,b,c,d] = [1,2,3,4].map(i => player(url, `10.3.0.${i}`));
  const first = await a.createSession({ preset: 'balanced' });
  const large = await b.createSession({ preset: 'balanced', queue: true });
  assert.equal(large.queued, true);
  const small = await c.createSession(foulOptions);
  assert.equal(small.threads, 1);
  const later = await d.createSession(foulOptions);
  await a.deleteSession(first.id);
  const replies = await Promise.all([b.checkIn(large.ticket), b.checkIn(large.ticket), d.checkIn(later.ticket)].map(p => p.catch(error => error)));
  assert.equal(replies.filter(reply => reply.id).length, 1);
  assert.equal([...api.sessions.values()].reduce((n,s) => n + s.threads, 0), 3);
  assert.equal((await d.checkIn(later.ticket)).queued, true);
});

test('memory reservations, live headroom and pending startup memory block admission until safe', async t => {
  let available = 3000;
  const { url, workers } = await start(t, { metamonRuntime, maxSessions: 8, trustProxy: true,
    resources: resourceOptions({ memoryMb: 2560, availableMb: () => available }) });
  const [a,b,c,d] = [1,2,3,4].map(i => player(url, `10.4.0.${i}`));
  const model = await a.createSession(modelOptions);
  assert.equal(model.queued, true, 'free memory must cover model plus headroom');
  const foul = await b.createSession(foulOptions);
  assert.ok(foul.id);
  available = 1900;
  const pending = await c.createSession(foulOptions);
  assert.equal(pending.queued, true, 'startup reservations count before RSS grows');
  workers[0].ready();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok((await c.checkIn(pending.ticket)).id);
  available = 16384;
  assert.equal((await a.checkIn(model.ticket)).queued, true, 'fixed memory budget still applies despite free RAM');
  assert.ok((await d.createSession(foulOptions)).id, 'smaller eligible job fits');
});

test('retiring workers hold slots and resources until exit, including the Metamon cap', async t => {
  const { url, api, workers } = await start(t, { metamonRuntime, maxSessions: 1, trustProxy: true, resources: resourceOptions() });
  const [a,b] = [1,2].map(i => player(url, `10.5.0.${i}`));
  const first = await a.createSession(modelOptions);
  workers[0].kill = () => true; // A worker that has not acknowledged termination yet.
  await a.deleteSession(first.id);
  assert.equal(api.sessions.size, 0);
  assert.equal((await a.info()).capacity.active, 1);
  const waiting = await b.createSession(foulOptions);
  assert.equal(waiting.queued, true);
  workers[0].emit('exit', 0);
  assert.equal((await b.checkIn(waiting.ticket)).bot, 'foulplay');
});


test('a bot that cannot fit the configured memory budget is unavailable instead of queued forever', async t => {
  const { client } = await start(t, { metamonRuntime, resources: resourceOptions({ memoryMb: 1024 }) });
  const info = await client.info();
  assert.equal(info.bots.find(b => b.id === 'metamon').available, false);
  assert.equal(info.bots.find(b => b.id === 'foulplay').available, true);
  await assert.rejects(client.createSession(modelOptions), { code: 'unavailable', message: /memory budget/ });
});
