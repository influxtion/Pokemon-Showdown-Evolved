'use strict';

// Client for the practice inference API. The launcher uses it for the cloud server and, when the
// player opts in to local play, for the copy it runs on this computer: only the origin and key differ.

const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
const { BOTS, FORMAT, TEAM_FORMATS, PRESETS, CHOICE, RQID, ROOM, SESSION_ID, SERVER_MESSAGES, apiOrigin, isBattleFrame,
  isTeamText } = require('./protocol');

class ApiError extends Error {
  constructor(message, { status = 0, code = 'unreachable', retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

async function readJson(response, limit = 65536) {
  const text = await response.text();
  if (text.length > limit) throw new ApiError('The practice server sent an unexpectedly large reply.', { status: response.status, code: 'invalid-reply' });
  try { return JSON.parse(text); } catch { throw new ApiError('The practice server sent an invalid reply.', { status: response.status, code: 'invalid-reply' }); }
}

// One battle session's socket. Emits the server messages listed in protocol.js (the `error`
// message is emitted as `failure`, so an unhandled one never throws), plus `close`.
// `ready` is also a promise, because the server can send it before anyone subscribes.
class InferenceSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    this.error = null;
    this.ready = new Promise((resolve, reject) => {
      this.once('ready', resolve);
      this.once('close', ({ error }) => reject(Object.assign(new Error(error?.message || 'The practice engine closed before it was ready.'),
        { code: error?.code || 'closed' })));
    });
    this.ready.catch(() => {});
    socket.on('message', (data, binary) => {
      if (binary) return this.fail('invalid-reply', 'The practice server sent an invalid message.');
      let value;
      try { value = JSON.parse(data.toString('utf8')); } catch { return this.fail('invalid-reply', 'The practice server sent an invalid message.'); }
      if (!value || !SERVER_MESSAGES.includes(value.type)) return;
      if (value.type === 'choice' && (!ROOM.test(value.room || '') || !CHOICE.test(value.choice || '') ||
          (value.rqid !== null && !RQID.test(String(value.rqid))))) {
        return this.fail('invalid-reply', 'The practice server sent an invalid move.');
      }
      if (value.type === 'error') {
        this.error = { code: String(value.code || 'engine-failed').slice(0, 40), message: String(value.message || '').slice(0, 300) };
      }
      this.emit(value.type === 'error' ? 'failure' : value.type, value);
    });
    socket.on('error', () => {});
    socket.on('close', code => {
      this.closed = true;
      this.emit('close', { code, error: this.error });
    });
  }

  fail(code, message) {
    this.error = { code, message };
    this.socket.terminate();
  }

  send(frame) {
    if (this.closed || !isBattleFrame(frame)) return false;
    if (this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: 'frame', data: frame }));
    return true;
  }

  close() {
    if (!this.closed) this.socket.close(1000);
  }
}

class InferenceClient {
  constructor({ url, key = null, fetcher = fetch, timeoutMs = 10000 }) {
    this.origin = apiOrigin(url);
    this.key = key;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }

  headers(extra = {}) {
    return { ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}), ...extra };
  }

  async request(route, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await this.fetcher(`${this.origin}${route}`, { method, redirect: 'error',
        headers: this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new ApiError("Couldn't reach the practice server. Check your internet connection.");
    }
    const value = await readJson(response);
    if (!response.ok) {
      const retry = Number(response.headers.get('retry-after'));
      throw new ApiError(typeof value?.error?.message === 'string' ? value.error.message.slice(0, 300) : 'The practice server refused the request.',
        { status: response.status, code: String(value?.error?.code || 'refused').slice(0, 40), retryAfter: Number.isFinite(retry) ? retry : null });
    }
    return value;
  }

  info() { return this.request('/v1/info'); }

  // `team` is the bot's own team as a Showdown export, for formats where the player brings it (OU).
  // With `queue`, a busy server may answer with a place in line instead of a session:
  // { queued: true, ticket, position, waiting, checkInMs }. Then call checkIn(ticket) until it
  // returns the session, or leaveQueue(ticket).
  async createSession({ bot = 'foulplay', preset, format = FORMAT, team, queue = false }) {
    if (!Object.hasOwn(BOTS, bot) || !Object.hasOwn(PRESETS, preset) || !BOTS[bot].formats.includes(format)) {
      throw new ApiError('Choose a supported bot, format and preset.', { code: 'invalid-options' });
    }
    const needsTeam = TEAM_FORMATS.includes(format);
    if (needsTeam && !isTeamText(team)) throw new ApiError('This format needs a team for the bot.', { code: 'invalid-team' });
    // Older servers know only Random Battle and refuse unknown fields, so send the format only when it matters.
    const body = format === FORMAT ? { bot, preset } : { bot, preset, format, team };
    let value;
    try {
      value = await this.request('/v1/sessions', { method: 'POST', body: queue ? { ...body, queue: true } : body });
    } catch (error) {
      // A server from before the queue refuses the unknown field; ask again the old way.
      if (!queue || error.status !== 400 || error.code !== 'invalid-options') throw error;
      value = await this.request('/v1/sessions', { method: 'POST', body });
    }
    return this.sessionOrPlace(value);
  }

  sessionOrPlace(value) {
    if (value?.queued === true) {
      const whole = number => Number.isInteger(number) && number >= 0 && number <= 100000;
      if (!SESSION_ID.test(value.ticket || '') || !whole(value.position) || !whole(value.waiting)) {
        throw new ApiError('The practice server sent an invalid queue place.', { code: 'invalid-reply' });
      }
      return { queued: true, ticket: value.ticket, position: value.position, waiting: value.waiting,
        checkInMs: whole(value.checkInMs) && value.checkInMs >= 1000 ? value.checkInMs : 15000 };
    }
    if (!SESSION_ID.test(value?.id || '')) throw new ApiError('The practice server sent an invalid session.', { code: 'invalid-reply' });
    return value;
  }

  // Keeps a place in the queue. Returns the place again, or the session once it is this client's turn.
  async checkIn(ticket) {
    if (!SESSION_ID.test(ticket || '')) throw new ApiError('Invalid queue place.', { code: 'invalid-options' });
    return this.sessionOrPlace(await this.request(`/v1/queue/${ticket}`));
  }

  leaveQueue(ticket) {
    if (!SESSION_ID.test(ticket || '')) return Promise.resolve(null);
    return this.request(`/v1/queue/${ticket}`, { method: 'DELETE' }).catch(() => null);
  }

  session(id) { return this.request(`/v1/sessions/${id}`); }

  deleteSession(id) { return this.request(`/v1/sessions/${id}`, { method: 'DELETE' }).catch(() => null); }

  // Resolves once the socket is open. Await `socket.ready` before sending frames.
  connect(id, { WebSocketImpl = WebSocket } = {}) {
    if (!SESSION_ID.test(id)) return Promise.reject(new ApiError('Invalid session.', { code: 'invalid-options' }));
    return new Promise((resolve, reject) => {
      const socket = new WebSocketImpl(`${this.origin.replace(/^http/, 'ws')}/v1/sessions/${id}/socket`,
        { headers: this.headers(), maxPayload: 65536, handshakeTimeout: this.timeoutMs, followRedirects: false });
      socket.once('open', () => resolve(new InferenceSocket(socket)));
      socket.once('error', () => reject(new ApiError("Couldn't connect to the practice engine.")));
      socket.once('unexpected-response', (_request, response) => {
        reject(new ApiError('The practice server refused the connection.', { status: response.statusCode, code: 'refused' }));
        socket.terminate();
      });
    });
  }
}

module.exports = { InferenceClient, InferenceSocket, ApiError };
