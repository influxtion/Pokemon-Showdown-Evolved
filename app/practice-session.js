'use strict';

// One practice session: the Showdown simulator runs on this computer, and the bot's seat in it is
// played through the practice inference API. Cloud and local play differ only in which API origin
// computes the moves (see api/). The bridge logs in to the simulator as the bot, accepts the
// player's challenge, forwards the bot's battle-room frames to the API and sends back its choices.

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
const { inspectRuntime } = require('./practice-manifest');
const { verifyInWorker } = require('./practice-verification');
const { childEnvironment, PRESETS } = require('./practice-runtime');
const { InferenceClient } = require('../api/client');
const { BOTS, FORMAT, ROOM } = require('../api/protocol');

const HUMAN = 'Player';
const ENGINES = new Set(['cloud', 'local']);
const ERRORS = Object.freeze({
  missing: 'The practice battle server is not installed.',
  start: 'Practice could not start. Stop and try again.',
  exited: 'The practice battle server stopped unexpectedly. Start a new session to try again.',
  timeout: 'Practice took too long to start. Stop and try again.',
  client: 'The battle client failed. Start a new session to try again.',
  integrity: 'The practice battle server failed its integrity check. Rebuild or reinstall it.',
  engine: 'Lost the connection to Foul Play. Start a new session to try again.',
});

const toId = name => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

class PracticeSession extends EventEmitter {
  // engines(engine) resolves to { url, key } for the API that should compute moves.
  constructor({ root, scripts, engines, node = process.execPath, spawnChild = spawn, verify = verifyInWorker,
    installed = null, timeoutMs = 120000, WebSocketImpl = WebSocket, Client = InferenceClient }) {
    super();
    this.root = root;
    this.scripts = scripts;
    this.engines = engines;
    this.node = node;
    this.spawnChild = spawnChild;
    this.verify = verify;
    this.inspectInstalled = installed;
    this.timeoutMs = timeoutMs;
    this.WebSocketImpl = WebSocketImpl;
    this.Client = Client;
    this.bot = BOTS.foulplay;
    this.generation = 0;
    this.state = 'idle';
    this.error = '';
    this.preset = 'full';
    this.engine = 'cloud';
    this.connection = null;
    this.battle = null;
    this.children = new Set();
    this.reset();
  }

  reset() {
    this.simulator = null;
    this.inference = null;
    this.api = null;
    this.apiSession = null;
    this.room = null;
    this.forwarding = false;
    this.accepted = false;
    this.thinkingSince = null;
    this.threads = null;
  }

  installed() {
    if (this.inspectInstalled) return this.inspectInstalled();
    return inspectRuntime(this.root).ok;
  }

  status() {
    return { installed: this.installed(), state: this.state, opponent: this.bot.id, engine: this.engine, threads: this.threads,
      opponents: [{ id: this.bot.id, name: this.bot.name, available: true, description: this.bot.description }],
      error: this.error, preset: this.preset, battle: this.battle };
  }

  changed() { this.emit('change', this.status()); }

  async start(options) {
    const { opponent = 'foulplay', preset, engine = 'cloud' } = options && typeof options === 'object' ? options : {};
    if (opponent !== this.bot.id) return { ok: false, error: 'Only Foul Play is available for practice right now.' };
    if (!Object.hasOwn(PRESETS, preset)) return { ok: false, error: 'Choose a supported computation setting.' };
    if (!ENGINES.has(engine)) return { ok: false, error: 'Choose where Foul Play should run.' };
    if (this.state === 'starting' || this.state === 'ready') return { ok: false, error: 'Stop the current practice session before starting another.' };
    if (!this.installed()) return { ok: false, error: ERRORS.missing };
    const generation = ++this.generation;
    Object.assign(this, { preset, engine, state: 'starting', error: '', battle: null });
    this.reset();
    this.connection = { token: crypto.randomBytes(32).toString('hex'), human: HUMAN, bot: this.bot.account, port: null };
    this.changed();
    this.timer = setTimeout(() => this.fail('timeout', generation), this.timeoutMs);
    this.timer.unref?.();
    const current = () => generation === this.generation;
    try {
      this.verification = this.verify(this.root);
      const verified = await this.verification.promise.catch(() => ({ ok: false }));
      this.verification = null;
      if (!current()) return { ok: false, cancelled: true };
      if (!verified.ok) return this.fail('integrity', generation);
      // Start the simulator and the engine together; both take a moment.
      const engine = this.startEngine(generation).catch(error => { throw Object.assign(error, { engine: true }); });
      const [port] = await Promise.all([this.startSimulator(generation), engine]);
      if (!current()) return { ok: false, cancelled: true };
      this.connection.port = port;
      await this.connectBot(generation);
      if (!current()) return { ok: false, cancelled: true };
      clearTimeout(this.timer);
      this.state = 'ready';
      this.changed();
      this.emit('ready', { ...this.connection });
      return { ok: true };
    } catch (error) {
      if (!current()) return { ok: false, cancelled: true };
      return this.fail(error.engine ? 'engine' : 'start', generation, error.message);
    }
  }

  startSimulator(generation) {
    return new Promise((resolve, reject) => {
      const child = this.launch(this.node, [path.join(this.scripts, 'server.cjs'), '--server-root',
        path.join(this.root, 'server'), '--port', '0', '--token', this.connection.token], generation);
      let buffer = '';
      child.once('error', reject);
      child.once('exit', () => reject(new Error(ERRORS.exited)));
      child.stdout.on('data', data => {
        buffer += data.toString('utf8');
        if (buffer.length > 65536) return reject(new Error(ERRORS.start));
        const line = buffer.split('\n').slice(0, -1).map(text => { try { return JSON.parse(text); } catch { return null; } })
          .find(event => event?.type === 'ready');
        if (!line) return;
        if (!Number.isInteger(line.port) || line.port < 1024 || line.port > 65535) return reject(new Error(ERRORS.start));
        resolve(line.port);
      });
    });
  }

  launch(executable, args, generation) {
    const child = this.spawnChild(executable, args, { cwd: this.root, windowsHide: true,
      env: childEnvironment(true), stdio: ['pipe', 'pipe', 'pipe'] });
    this.children.add(child);
    if (child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Best effort. */ }
    }
    child.stderr?.on('data', () => {});
    child.stdin?.on('error', () => {});
    child.once('error', () => { this.children.delete(child); this.fail('start', generation); });
    child.once('exit', () => { this.children.delete(child); this.fail('exited', generation); });
    return child;
  }

  async startEngine(generation) {
    const target = await this.engines(this.engine);
    if (generation !== this.generation) return;
    const api = new this.Client({ url: target.url, key: target.key || null });
    this.api = api;
    const session = await api.createSession({ bot: this.bot.id, preset: this.preset });
    if (generation !== this.generation) { api.deleteSession(session.id); return; }
    this.apiSession = session.id;
    this.threads = session.threads;
    const socket = await api.connect(session.id);
    if (generation !== this.generation) { socket.close(); return; }
    this.inference = socket;
    socket.on('choice', choice => this.choice(choice, generation));
    socket.on('close', ({ error }) => {
      if (generation === this.generation && this.inference === socket) this.fail('engine', generation, error?.message);
    });
    await socket.ready;
  }

  connectBot(generation) {
    return new Promise((resolve, reject) => {
      const { port, token, bot } = this.connection;
      const socket = new this.WebSocketImpl(`ws://127.0.0.1:${port}/showdown/websocket?token=${token}`, { maxPayload: 2 ** 20 });
      this.simulator = socket;
      let named = false;
      const deadline = setTimeout(() => reject(new Error(ERRORS.timeout)), 15000);
      deadline.unref?.();
      socket.on('message', data => {
        if (generation !== this.generation) return;
        const text = data.toString('utf8');
        if (!named) {
          if (text.includes('|challstr|')) socket.send(`|/trn ${bot},0,`);
          if (text.split('\n').some(line => line.startsWith(`|updateuser| ${bot}|1|`))) {
            named = true;
            clearTimeout(deadline);
            resolve();
          }
          return;
        }
        this.simulatorFrame(text);
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        clearTimeout(deadline);
        if (!named) reject(new Error(ERRORS.start));
        else this.fail('exited', generation);
      });
    });
  }

  simulatorFrame(text) {
    const lines = text.split('\n');
    if (!lines[0].startsWith('>')) {
      for (const line of lines) {
        const parts = line.split('|');
        // |pm| Player| FoulPlay|/challenge gen9randombattle|gen9randombattle|...
        if (parts.length >= 6 && parts[1] === 'pm' && toId(parts[2]) === toId(HUMAN) && toId(parts[3]) === toId(this.bot.account) &&
            parts[4] === `/challenge ${FORMAT}` && parts[5] === FORMAT && (!this.battle || this.battle.finished)) {
          this.simulator.send('|/utm null');
          this.simulator.send(`|/accept ${HUMAN}`);
          this.accepted = true;
        }
      }
      return;
    }
    const room = lines[0].slice(1);
    if (!ROOM.test(room)) return;
    // Adopt a battle room only right after accepting the player's challenge.
    if (lines.includes('|init|battle') && this.accepted) {
      this.accepted = false;
      this.room = room;
      this.forwarding = true;
      this.battle = { room, turn: 0, thinking: false, finished: false };
    }
    if (room !== this.room || !this.forwarding) return;
    this.inference?.send(text);
    let changed = false;
    for (const line of lines) {
      if (line.startsWith('|turn|')) {
        const turn = Number(line.slice(6));
        if (Number.isInteger(turn) && turn >= 0 && turn <= 10000) { this.battle.turn = turn; changed = true; }
      } else if (line.startsWith('|request|') && line.length > 9) {
        try {
          const request = JSON.parse(line.slice(9));
          if (request && !request.wait) { this.battle.thinking = true; this.thinkingSince = Date.now(); changed = true; }
        } catch { /* Not a request this bridge needs to understand. */ }
      } else if (line.startsWith('|win|') || line === '|tie') {
        const winner = line === '|tie' ? null : toId(line.slice(5));
        this.battle = { ...this.battle, thinking: false, finished: true,
          result: winner === null ? 'tie' : winner === toId(HUMAN) ? 'win' : 'loss' };
        this.forwarding = false;
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  choice(value, generation) {
    if (generation !== this.generation || value.room !== this.room || !this.battle || this.battle.finished) return;
    this.simulator?.send(`${value.room}|${value.choice}${value.rqid ? `|${value.rqid}` : ''}`);
    this.battle = { ...this.battle, thinking: false,
      elapsedMs: Number.isFinite(value.elapsedMs) ? value.elapsedMs : Date.now() - (this.thinkingSince || Date.now()) };
    this.changed();
  }

  fail(code, generation, message) {
    if (generation !== this.generation) return { ok: false, cancelled: true };
    this.stop();
    this.state = 'failed';
    this.error = code === 'engine' && message ? message : ERRORS[code] || ERRORS.start;
    this.changed();
    this.emit('failure', code);
    return { ok: false, error: this.error };
  }

  clientFailed(token) {
    if (this.connection?.token === token) this.fail('client', this.generation);
  }

  stop() {
    ++this.generation;
    this.verification?.cancel();
    this.verification = null;
    clearTimeout(this.timer);
    this.inference?.close();
    this.simulator?.terminate?.();
    if (this.api && this.apiSession) this.api.deleteSession(this.apiSession);
    for (const child of this.children) {
      child.stdin?.end?.();
      child.kill();
    }
    this.children.clear();
    this.reset();
    this.connection = null;
    this.battle = null;
    this.state = 'idle';
    this.error = '';
    this.changed();
    return { ok: true };
  }
}

module.exports = { PracticeSession, ERRORS };
