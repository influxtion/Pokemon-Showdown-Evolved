'use strict';

// Practice inference API, run in the cloud and, for players who opt in, in the app on 127.0.0.1.
// Clients run the battle and stream the bot's view here; the server only computes its moves.
//
//   GET    /healthz                 liveness
//   GET    /v1/info                 bots, presets, limits and capacity
//   POST   /v1/sessions             {"bot", "preset", "format"?, "team"?, "queue"?} (README.md)
//   GET    /v1/sessions/:id         session status
//   DELETE /v1/sessions/:id         end a session
//   WS     /v1/sessions/:id/socket  frames in, choices out (protocol.js)
//   GET    /v1/queue/:ticket        check in; becomes the session on your turn
//   DELETE /v1/queue/:ticket        leave the queue
//
// Queue: when every engine is busy, "queue": true gets a place (202) instead of 503. A client
// keeps it by checking in every `queueCheckInMs`; the earliest eligible player takes capacity.
// A bot-specific limit never blocks players who can use remaining capacity.
// Past `maxQueue` waiting, the answer is 503 again.

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { API_VERSION, FORMAT, TEAM_FORMATS, PRESETS, BOTS, ROOM, CHOICE, RQID, SESSION_ID, roomFormat, isBattleFrame,
  isTeamText } = require('./protocol');

const MINUTE = 60000;
const HOUR = 60 * MINUTE;

// Token bucket per key: `capacity` tokens, refilled continuously at `perHour`.
class RateLimiter {
  constructor({ capacity, perHour, now }) {
    this.capacity = capacity;
    this.refillMs = HOUR / perHour;
    this.now = now;
    this.buckets = new Map();
  }

  take(key) {
    const time = this.now();
    const bucket = this.buckets.get(key) || { tokens: this.capacity, at: time };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (time - bucket.at) / this.refillMs);
    bucket.at = time;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) { bucket.tokens -= 1; return { ok: true }; }
    return { ok: false, retryAfterMs: Math.ceil((1 - bucket.tokens) * this.refillMs) };
  }

  prune() {
    const time = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (time - bucket.at) / this.refillMs >= this.capacity) this.buckets.delete(key);
    }
  }
}

// Per-socket frame budget: a burst, then a steady rate.
class FrameBudget {
  constructor({ burst, perSecond, now }) {
    this.burst = burst;
    this.perSecond = perSecond;
    this.now = now;
    this.tokens = burst;
    this.at = now();
  }

  take() {
    const time = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((time - this.at) / 1000) * this.perSecond);
    this.at = time;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// Rate limits apply per client network: an IPv4 address, or an IPv6 /64.
function clientKey(request, trustProxy) {
  let address = request.socket.remoteAddress || 'unknown';
  if (trustProxy) {
    // The proxy appends the address it saw; anything to the left came from the client.
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').map(part => part.trim()).filter(Boolean);
    if (forwarded.length && isIP(forwarded.at(-1))) address = forwarded.at(-1);
  }
  if (isIP(address) === 6) {
    // URL canonicalizes zero compression, casing, and embedded IPv4 consistently.
    address = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    if (/^::ffff:[a-f0-9]+:[a-f0-9]+$/.test(address)) {
      const words = address.split(':').slice(-2).map(word => parseInt(word, 16));
      return [words[0] >> 8, words[0] & 255, words[1] >> 8, words[1] & 255].join('.');
    }
    const [left, right] = address.split('::');
    const start = left ? left.split(':') : [];
    const end = right ? right.split(':') : [];
    const groups = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end];
    address = `${groups.slice(0, 4).join(':')}::/64`;
  }
  return address;
}

function workerEnvironment() {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATH', 'HOME', 'LANG']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, { PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' });
  return env;
}

// `lowPriority` is for the in-app copy, so a search never starves the player's computer.
function spawnWorker({ runtime, threads, level = 'hard', format = FORMAT, bot = 'foulplay', lowPriority = false }) {
  const args = bot === 'metamon' ? ['-I', '-B', runtime.worker, '--runtime', runtime.root, '--threads', String(threads)]
    : ['-I', '-B', runtime.worker, '--source', runtime.source, '--threads', String(threads), '--level', level, '--format', format];
  const child = spawn(runtime.python, args,
    { cwd: path.dirname(runtime.worker), env: workerEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  if (lowPriority && child.pid) {
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Best effort. */ }
  }
  return child;
}

const ERRORS = Object.freeze({
  'engine-failed': 'The bot stopped unexpectedly. Start a new battle to try again.',
  'engine-timeout': 'The bot took too long to start.',
  'invalid-team': "The bot couldn't read its team. Check the team and try again.",
  'expired': 'This practice session reached its time limit. Start a new one.',
  'idle': 'This practice session was idle for too long.',
  'decision-limit': 'This practice session reached its move limit. Start a new one.',
  'rate-limited': 'Too many messages. The session was closed.',
  'invalid-message': 'The engine received a message it does not understand.',
  'shutting-down': 'The practice server is restarting. Start a new battle in a moment.',
});

function createApiServer({
  runtime,
  metamonRuntime = null,
  maxMetamonSessions = 1,
  resources = null,
  apiKey = null,
  maxSessions = 4,
  maxSessionsPerClient = 1,
  sessionBurst = 6,
  sessionsPerHour = 30,
  maxThreads = 8,
  startupMs = MINUTE,
  connectMs = MINUTE,
  idleMs = 15 * MINUTE,
  lifetimeMs = 2 * HOUR,
  maxDecisions = 5000,
  framesPerSecond = 40,
  frameBurst = 200,
  maxFrameBytes = 256 * 1024,
  trustProxy = false,
  lowPriority = false,
  maxQueue = 20,
  queueCheckInMs = 15 * 1000,
  launch = spawnWorker,
  now = Date.now,
  log = () => {},
} = {}) {
  if (apiKey !== null && (typeof apiKey !== 'string' || apiKey.length < 32)) throw new Error('API_KEY must be at least 32 characters.');
  for (const [name, value] of Object.entries({ maxSessions, maxSessionsPerClient, maxThreads, maxMetamonSessions })) {
    if (!Number.isInteger(value) || value < 1 || value > 256) throw new Error(`Invalid ${name}`);
  }
  if (!Number.isInteger(maxQueue) || maxQueue < 0 || maxQueue > 1000) throw new Error('Invalid maxQueue');
  const resolveRuntime = bot => { const source = bot === 'metamon' ? metamonRuntime : runtime; return typeof source === 'function' ? source() : source; };
  if (resources) {
    for (const key of ['threads', 'memoryMb', 'reserveMb', 'foulplayMb', 'metamonMb']) {
      if (!Number.isSafeInteger(resources[key]) || resources[key] < (key === 'memoryMb' || key === 'reserveMb' ? 0 : 1)) throw new Error(`Invalid resources.${key}`);
    }
    if (typeof resources.availableMb !== 'function') throw new Error('Invalid resources.availableMb');
    maxThreads = Math.min(maxThreads, resources.threads);
  }
  const sessions = new Map();
  const retiring = new Set();
  const workersInUse = () => [...sessions.values(), ...retiring];
  // Waiting clients, oldest first: { id, client, options, joined, seen }. Options (maybe an OU team)
  // are kept only while waiting and never logged.
  const queue = [];
  const limiter = new RateLimiter({ capacity: sessionBurst, perHour: sessionsPerHour, now });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes + 1024, perMessageDeflate: false });
  let closing = false;

  const threadsFor = preset => Math.min(PRESETS[preset], maxThreads);

  function authorized(request) {
    if (apiKey === null) return true;
    const supplied = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${apiKey}`);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  function send(response, code, value, headers = {}) {
    response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
    response.end(JSON.stringify(value));
  }
  const failure = (response, code, error, message, headers) => send(response, code, { error: { code: error, message } }, headers);

  async function readBody(request) {
    if (!/^application\/json\b/.test(request.headers['content-type'] || '')) throw new Error('Expected JSON');
    let text = '';
    // Decode as a stream, so a character split across chunks survives (Flabébé in an OU team).
    request.setEncoding('utf8');
    for await (const chunk of request) {
      text += chunk;
      // Room for an OU team; every other body is tiny.
      if (text.length > 16384) throw new Error('Body too large');
    }
    return JSON.parse(text);
  }

  function describe(session) {
    return { id: session.id, bot: session.bot, level: BOTS[session.bot].level, format: session.format, preset: session.preset,
      threads: session.threads, state: session.state,
      connected: Boolean(session.socket), battles: session.battles, decisions: session.decisions,
      expiresAt: new Date(session.created + lifetimeMs).toISOString() };
  }

  function message(session, value) {
    if (session.socket?.readyState === 1) session.socket.send(JSON.stringify(value));
  }

  function end(session, code = null) {
    if (session.state === 'closed') return;
    const failed = Boolean(code);
    session.state = 'closed';
    sessions.delete(session.id);
    if (session.worker && !session.workerExited) {
      retiring.add(session);
      session.killTimer = setTimeout(() => session.worker.kill('SIGKILL'), 5000);
      session.killTimer.unref();
    }
    clearTimeout(session.startupTimer);
    if (session.worker) {
      session.worker.stdin?.end?.();
      session.worker.kill();
    }
    if (session.socket) {
      if (failed) message(session, { type: 'error', code, message: ERRORS[code] || ERRORS['engine-failed'] });
      session.socket.close(failed ? (code === 'rate-limited' ? 1008 : 1011) : 1000);
    }
    log('session-end', { reason: code || 'closed', decisions: session.decisions, battles: session.battles });
  }

  function workerEvent(session, event) {
    if (event.type === 'error') return end(session, event.code === 'invalid-team' ? 'invalid-team' : 'engine-failed');
    if (event.type === 'ready') {
      if (session.state !== 'starting' || event.protocol !== 1 || event.bot !== (session.bot === 'metamon' ? 'metamon' : 'foulplay') || event.threads !== session.threads ||
          event.level !== BOTS[session.bot].level || event.format !== session.format) {
        return end(session, 'engine-failed');
      }
      clearTimeout(session.startupTimer);
      session.state = 'ready';
      session.ready = { type: 'ready', bot: session.bot, level: event.level, format: session.format, threads: session.threads,
        searchMs: Number(event.searchMs) || 0 };
      message(session, session.ready);
      return;
    }
    if (session.state !== 'ready' || !ROOM.test(event.room || '') || roomFormat(event.room) !== session.format) return;
    const turn = Number.isInteger(event.turn) && event.turn >= 0 && event.turn <= 10000 ? event.turn : undefined;
    if (event.type === 'battle') {
      session.battles++;
      message(session, { type: 'battle', room: event.room });
    } else if (event.type === 'thinking') {
      message(session, { type: 'thinking', room: event.room, turn });
    } else if (event.type === 'choice') {
      if (!CHOICE.test(event.choice || '') || (event.rqid !== null && !RQID.test(String(event.rqid)))) return end(session, 'engine-failed');
      if (++session.decisions > maxDecisions) return end(session, 'decision-limit');
      const elapsedMs = Number.isFinite(event.elapsedMs) ? Math.max(0, Math.min(HOUR, Math.round(event.elapsedMs))) : 0;
      message(session, { type: 'choice', room: event.room, turn, choice: event.choice, rqid: event.rqid, elapsedMs });
    } else if (event.type === 'end' && ['win', 'loss', 'tie'].includes(event.result)) {
      message(session, { type: 'end', room: event.room, result: event.result });
    }
  }

  // The team goes to the worker's stdin and is not kept on the session or logged.
  function startWorker(session, paths, team) {
    let child;
    try {
      child = launch({ runtime: paths, bot: session.bot, threads: session.threads, level: BOTS[session.bot].level, format: session.format, lowPriority });
    } catch { return end(session, 'engine-failed'); }
    session.worker = child;
    if (team && session.bot !== 'metamon') child.stdin?.write(`${JSON.stringify({ type: 'team', data: team })}\n`);
    child.stderr?.on('data', () => {}); // Upstream diagnostics can include battle state; never log them.
    child.stdin?.on('error', () => {});
    const exited = () => {
      session.workerExited = true;
      retiring.delete(session);
      clearTimeout(session.killTimer);
    };
    child.once('error', () => { if (!child.pid) exited(); end(session, 'engine-failed'); });
    child.once('exit', () => { exited(); end(session, session.state === 'closed' ? null : 'engine-failed'); });
    let buffer = '';
    child.stdout.on('data', data => {
      buffer += data.toString('utf8');
      if (buffer.length > 65536) return end(session, 'engine-failed');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event && typeof event === 'object' && session.state !== 'closed') workerEvent(session, event);
      }
    });
    session.startupTimer = setTimeout(() => { if (session.state === 'starting') end(session, 'engine-timeout'); }, startupMs);
    session.startupTimer.unref?.();
  }

  const workerThreads = options => options.bot === 'metamon' ? Math.min(4, maxThreads) : threadsFor(options.preset);
  const memoryFor = bot => bot === 'metamon' ? resources.metamonMb : resources.foulplayMb;
  function eligible(options) {
    const used = workersInUse();
    if (used.length >= maxSessions || (options.bot === 'metamon' && used.filter(s => s.bot === 'metamon').length >= maxMetamonSessions)) return false;
    if (!resources) return true;
    const memory = memoryFor(options.bot);
    let available;
    try { available = resources.availableMb(); } catch { return false; }
    // Reserve loading workers before their full RSS is visible to the OS.
    const startingMemory = used.filter(s => s.state === 'starting').reduce((sum, s) => sum + memoryFor(s.bot), 0);
    return Number.isFinite(available) && available >= memory + resources.reserveMb + startingMemory &&
      used.reduce((sum, s) => sum + s.threads, 0) + workerThreads(options) <= resources.threads &&
      used.reduce((sum, s) => sum + memoryFor(s.bot), 0) + memory <= resources.memoryMb;
  }
  const firstEligible = () => queue.find(ticket => now() - ticket.seen <= queueCheckInMs && eligible(ticket.options));
  const place = ticket => ({ queued: true, ticket: ticket.id, position: queue.indexOf(ticket) + 1, waiting: queue.length,
    checkInMs: queueCheckInMs });
  function leaveQueue(ticket, reason) {
    const index = queue.indexOf(ticket);
    if (index === -1) return;
    queue.splice(index, 1);
    log('queue-leave', { reason, waiting: queue.length });
  }

  // Starts an engine for a client that has a slot. The OU team goes to the worker and nowhere else.
  function openSession(response, client, options, paths) {
    const format = options.format === undefined ? FORMAT : options.format;
    const session = { id: crypto.randomBytes(32).toString('hex'), client, bot: options.bot, format, preset: options.preset,
      threads: workerThreads(options), created: now(), touched: now(), state: 'starting', worker: null, socket: null,
      decisions: 0, battles: 0, frames: new FrameBudget({ burst: frameBurst, perSecond: framesPerSecond, now }) };
    sessions.set(session.id, session);
    startWorker(session, paths, TEAM_FORMATS.includes(format) ? options.team : null);
    log('session-start', { bot: session.bot, format, threads: session.threads, active: sessions.size, waiting: queue.length });
    return send(response, 201, { ...describe(session), socket: `/v1/sessions/${session.id}/socket` });
  }

  async function createSession(request, response) {
    let options;
    try { options = await readBody(request); } catch { return failure(response, 400, 'invalid-request', 'Expected a small JSON body.'); }
    if (!options || typeof options !== 'object' || !Object.hasOwn(BOTS, options.bot) || !Object.hasOwn(PRESETS, options.preset) ||
        Object.keys(options).some(key => !['bot', 'preset', 'format', 'team', 'queue'].includes(key)) ||
        (options.queue !== undefined && typeof options.queue !== 'boolean')) {
      return failure(response, 400, 'invalid-options', 'Choose a supported bot and computation preset.');
    }
    const format = options.format === undefined ? FORMAT : options.format;
    if (!BOTS[options.bot].formats.includes(format)) {
      return failure(response, 400, 'invalid-format', `${BOTS[options.bot].name} does not play that format.`);
    }
    const needsTeam = TEAM_FORMATS.includes(format);
    if (needsTeam ? !isTeamText(options.team) : options.team !== undefined) {
      return failure(response, 400, 'invalid-team', needsTeam ? 'This format needs a team for the bot.' : 'This format has no team to send.');
    }
    const paths = resolveRuntime(options.bot);
    if (!paths) return failure(response, 503, 'unavailable', 'This bot is not installed on this server.');
    if (resources && memoryFor(options.bot) > resources.memoryMb) return failure(response, 503, 'unavailable', 'The server memory budget is too small for this bot.');
    if (paths.formats && !paths.formats.includes(format)) return failure(response, 503, 'unavailable', 'Update the bot runtime for this format.');
    const client = clientKey(request, trustProxy);
    const mine = [...sessions.values()].filter(session => session.client === client).length;
    if (mine >= maxSessionsPerClient) {
      return failure(response, 429, 'too-many-sessions', 'You already have a practice battle running. Stop it before starting another.', { 'Retry-After': '10' });
    }
    if (queue.some(ticket => ticket.client === client)) {
      return failure(response, 429, 'already-queued', 'You are already waiting for a cloud engine. Leave the queue before starting another.', { 'Retry-After': '10' });
    }
    const allowed = limiter.take(client);
    if (!allowed.ok) {
      const seconds = Math.ceil(allowed.retryAfterMs / 1000);
      return failure(response, 429, 'rate-limited', `Too many practice battles started. Try again in ${Math.ceil(seconds / 60)} min.`, { 'Retry-After': String(seconds) });
    }
    const wanted = { bot: options.bot, preset: options.preset, format, ...(needsTeam ? { team: options.team } : {}) };
    // New arrivals can pass blocked tickets, but never an eligible waiting player.
    if (eligible(wanted) && !firstEligible()) return openSession(response, client, wanted, paths);
    if (options.queue === true && queue.length < maxQueue) {
      const ticket = { id: crypto.randomBytes(32).toString('hex'), client, options: wanted, joined: now(), seen: now() };
      queue.push(ticket);
      log('queue-join', { bot: wanted.bot, format, waiting: queue.length });
      return send(response, 202, place(ticket));
    }
    return failure(response, 503, 'at-capacity', queue.length >= maxQueue && options.queue === true
      ? 'The queue is full. Try again in a few minutes.' : 'No capacity is available for this bot right now. Try again shortly.',
    { 'Retry-After': '30' });
  }

  // Admission and reservation happen synchronously. Poll order cannot overbook or overtake an eligible ticket.
  function checkIn(response, ticket) {
    ticket.seen = now();
    if (firstEligible() !== ticket) return send(response, 200, place(ticket));
    const paths = resolveRuntime(ticket.options.bot);
    if (!paths) return failure(response, 503, 'unavailable', 'This bot is not installed on this server.');
    leaveQueue(ticket, 'started');
    log('queue-wait', { seconds: Math.round((now() - ticket.joined) / 1000) });
    return openSession(response, ticket.client, ticket.options, paths);
  }

  const server = http.createServer(async (request, response) => {
    try {
      if (closing) return failure(response, 503, 'shutting-down', ERRORS['shutting-down']);
      const url = new URL(request.url, 'http://api');
      if (url.search) return failure(response, 400, 'invalid-request', 'Unexpected query string.');
      if (request.method === 'GET' && url.pathname === '/healthz') return send(response, 200, { ok: true });
      if (!url.pathname.startsWith('/v1/')) return failure(response, 404, 'not-found', 'Not found.');
      if (!authorized(request)) return failure(response, 401, 'unauthorized', 'This practice server needs an API key.');
      if (request.method === 'GET' && url.pathname === '/v1/info') {
        return send(response, 200, { api: API_VERSION,
          bots: Object.values(BOTS).map(bot => { const runtimeInfo = resolveRuntime(bot.id); return ({ id: bot.id, name: bot.name, description: bot.description, level: bot.level,
            formats: bot.formats.filter(format => !runtimeInfo?.formats || runtimeInfo.formats.includes(format)), available: Boolean(runtimeInfo) && (!resources || memoryFor(bot.id) <= resources.memoryMb),
            presets: Object.fromEntries(Object.keys(PRESETS).map(preset => [preset, bot.id === 'metamon' ? Math.min(4, maxThreads) : threadsFor(preset)])) }); }),
          limits: { maxSessionsPerClient, sessionsPerHour, sessionBurst, lifetimeMs, idleMs, maxDecisions },
          ...(resources ? { resources: { threads: resources.threads, memoryMb: resources.memoryMb, reserveMb: resources.reserveMb,
            foulplayMb: resources.foulplayMb, metamonMb: resources.metamonMb, retiring: retiring.size } } : {}),
          capacity: { active: sessions.size + retiring.size, max: maxSessions, waiting: queue.length, queueMax: maxQueue, checkInMs: queueCheckInMs } });
      }
      if (url.pathname === '/v1/sessions') {
        if (request.method === 'POST') return await createSession(request, response);
        return failure(response, 405, 'method-not-allowed', 'Use POST.');
      }
      const waiting = /^\/v1\/queue\/([^/]+)$/.exec(url.pathname);
      if (waiting) {
        const ticket = SESSION_ID.test(waiting[1]) ? queue.find(value => value.id === waiting[1]) : null;
        if (!ticket) return failure(response, 404, 'ticket-not-found', 'Your place in the queue has expired. Start the battle again.');
        if (request.method === 'GET') return checkIn(response, ticket);
        if (request.method === 'DELETE') { leaveQueue(ticket, 'left'); return send(response, 200, { ok: true }); }
        return failure(response, 405, 'method-not-allowed', 'Use GET or DELETE.');
      }
      const match = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
      if (match && SESSION_ID.test(match[1])) {
        const session = sessions.get(match[1]);
        if (!session) return failure(response, 404, 'session-not-found', 'This practice session has ended.');
        if (request.method === 'GET') return send(response, 200, describe(session));
        if (request.method === 'DELETE') { end(session); return send(response, 200, { ok: true }); }
        return failure(response, 405, 'method-not-allowed', 'Use GET or DELETE.');
      }
      return failure(response, 404, 'not-found', 'Not found.');
    } catch {
      if (!response.headersSent) failure(response, 500, 'internal', 'Something went wrong.');
      else response.destroy();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;

  server.on('upgrade', (request, socket, head) => {
    const reject = status => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const match = /^\/v1\/sessions\/([a-f0-9]{64})\/socket$/.exec(request.url || '');
    // Browsers always send Origin; the API is for the launcher and other non-browser clients.
    if (closing || !match || request.headers.origin) return reject('403 Forbidden');
    if (!authorized(request)) return reject('401 Unauthorized');
    const session = sessions.get(match[1]);
    if (!session || session.socket || session.state === 'closed') return reject('404 Not Found');
    sockets.handleUpgrade(request, socket, head, ws => {
      if (session.state === 'closed') return ws.close(1011);
      session.socket = ws;
      session.touched = now();
      session.alive = true;
      if (session.ready) message(session, session.ready);
      ws.on('pong', () => { session.alive = true; });
      ws.on('message', (data, binary) => {
        if (session.state === 'closed') return;
        if (binary || !session.frames.take()) return end(session, 'rate-limited');
        let value;
        try { value = JSON.parse(data.toString('utf8')); } catch { return end(session, 'invalid-message'); }
        if (!value || value.type !== 'frame' || !isBattleFrame(value.data, session.format) || value.data.length > maxFrameBytes) {
          return end(session, 'invalid-message');
        }
        session.touched = now();
        const stdin = session.worker?.stdin;
        // A client that floods faster than the engine reads cannot grow server memory.
        if (!stdin || stdin.writableLength > 4 * maxFrameBytes) return end(session, 'rate-limited');
        stdin.write(`${JSON.stringify({ type: 'frame', data: value.data })}\n`);
      });
      ws.on('error', () => {});
      ws.on('close', () => { session.socket = null; end(session); });
    });
  });

  function sweep() {
    const time = now();
    for (const session of [...sessions.values()]) {
      if (time - session.created > lifetimeMs) end(session, 'expired');
      else if (!session.socket && time - session.created > connectMs) end(session);
      else if (time - session.touched > idleMs) end(session, 'idle');
    }
    // A client that stops checking in (closed the app, lost its connection) loses its place.
    for (const ticket of [...queue]) if (time - ticket.seen > queueCheckInMs) leaveQueue(ticket, 'expired');
    limiter.prune();
  }
  function heartbeat() {
    for (const session of sessions.values()) {
      if (!session.socket) continue;
      if (!session.alive) { session.socket.terminate(); continue; }
      session.alive = false;
      session.socket.ping();
    }
  }
  const sweepTimer = setInterval(sweep, 1000);
  const heartbeatTimer = setInterval(heartbeat, 30000);
  sweepTimer.unref();
  heartbeatTimer.unref();

  return {
    server, sessions, queue, sweep,
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      const address = server.address();
      return `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
    },
    async close() {
      closing = true;
      clearInterval(sweepTimer);
      clearInterval(heartbeatTimer);
      for (const session of [...sessions.values()]) end(session, 'shutting-down');
      queue.length = 0;
      sockets.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function integer(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a whole number.`);
  return Number(value);
}

async function main() {
  const { inspect } = require('./install');
  const runtimeDir = path.resolve(process.env.RUNTIME_DIR || path.join(__dirname, 'runtime'));
  const runtime = inspect(runtimeDir);
  if (!runtime.installed) throw new Error(`Foul Play is not installed in ${runtimeDir}. Run "npm run setup" first.`);
  if (!runtime.current) console.warn('The installed Foul Play runtime is older than lock.json. Run "npm run setup" to update it.');
  let metamonRuntime = null;
  if (process.env.METAMON_RUNTIME_DIR) {
    const { MetamonRuntime } = require('./metamon/install');
    const installed = new MetamonRuntime({ dir: process.env.METAMON_RUNTIME_DIR }).inspect();
    if (!installed.installed) throw new Error('Metamon is not installed in METAMON_RUNTIME_DIR.');
    metamonRuntime = installed;
  }
  const resources = require('./resources').hostResources();
  console.log(JSON.stringify({ event: 'resource-budget', threads: resources.threads, memoryMb: resources.memoryMb, reserveMb: resources.reserveMb, foulplayMb: resources.foulplayMb, metamonMb: resources.metamonMb }));
  const api = createApiServer({
    resources, runtime, metamonRuntime, maxMetamonSessions: integer('MAX_METAMON_SESSIONS', 1),
    apiKey: process.env.API_KEY || null,
    maxSessions: integer('MAX_SESSIONS', Math.max(1, Math.floor(os.availableParallelism() / 2))),
    maxSessionsPerClient: integer('MAX_SESSIONS_PER_CLIENT', 1),
    maxQueue: integer('MAX_QUEUE', 20),
    sessionsPerHour: integer('SESSIONS_PER_HOUR', 30),
    sessionBurst: integer('SESSION_BURST', 6),
    maxThreads: integer('MAX_THREADS', 2),
    trustProxy: process.env.TRUST_PROXY === '1',
    log: (event, fields) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields })),
  });
  const origin = await api.listen(integer('PORT', 8787), process.env.HOST || '127.0.0.1');
  console.log(`Practice API listening at ${origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => api.close().then(() => process.exit(0)));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { createApiServer, RateLimiter, FrameBudget, clientKey, spawnWorker };
