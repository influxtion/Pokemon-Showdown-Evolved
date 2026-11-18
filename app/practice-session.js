'use strict';

// One practice session. The simulator runs locally; the bridge logs in as the bot, accepts the
// player's challenge and passes the bot's frames to whoever plays its seat: the inference API for
// Foul Play (api/, cloud or local) or a simple bot (app/simple-bots.js). Choices come back the same way.

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
const { BOTS, FORMAT, MAX_TEAM, ROOM, roomFormat, isTeamText } = require('../api/protocol');
const { LOCAL_BOTS, LocalBot, loadData } = require('./simple-bots');

// What the Bots page shows, hardest first. `difficulty` is the bot's group; only Foul Play levels
// search, so only they use the cloud and presets. `formats` lists where each is offered; formats
// with teams need both teams from the player.
const SIMPLE = { local: true, search: false, difficulty: 'easy', kind: 'Rule-based bot', formats: [FORMAT] };
const SEARCH = { local: false, search: true, kind: 'Search bot' };
const OPPONENTS = Object.freeze({
  foulplay: Object.freeze({ ...BOTS.foulplay, ...SEARCH, difficulty: 'hard', formats: [FORMAT, 'gen9ou'],
    description: 'Searches possible futures every turn, guessing what your team could be holding.' }),
  'foulplay-medium': Object.freeze({ ...BOTS['foulplay-medium'], ...SEARCH, difficulty: 'medium', formats: [FORMAT],
    description: 'Foul Play with less time to think. Plays well, but does not always find the best move.' }),
  'foulplay-casual': Object.freeze({ ...BOTS['foulplay-casual'], ...SEARCH, difficulty: 'medium', formats: [FORMAT],
    description: 'Foul Play on a quick read. Settles on one guess about your team and sometimes plays its second choice.' }),
  heuristic: Object.freeze({ ...LOCAL_BOTS.heuristic, ...SIMPLE }),
  greedy: Object.freeze({ ...LOCAL_BOTS.greedy, ...SIMPLE }),
  random: Object.freeze({ ...LOCAL_BOTS.random, ...SIMPLE }),
});
// The page has no computation setting; Foul Play uses the most the server allows.
const DEFAULT_PRESET = 'full';

const HUMAN = 'Player';
const ERRORS = Object.freeze({
  missing: 'The practice battle server is not installed.',
  start: 'Practice could not start. Stop and try again.',
  exited: 'The practice battle server stopped unexpectedly. Start a new session to try again.',
  timeout: 'Practice took too long to start. Stop and try again.',
  client: 'The battle client failed. Start a new session to try again.',
  integrity: 'The practice battle server failed its integrity check. Rebuild or reinstall it.',
  engine: 'Lost the connection to Foul Play. Start a new session to try again.',
  bot: 'The bot stopped unexpectedly. Start a new session to try again.',
});

// Where Foul Play's moves are computed: the cloud server, or the opt-in copy on this computer.
const ENGINES = Object.freeze(['cloud', 'local']);

const toId = name => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

class PracticeSession extends EventEmitter {
  // target(engine) resolves to { url, key } for Foul Play's API; engine is 'cloud' or 'local'.
  constructor({ root, scripts, target, node = process.execPath, spawnChild = spawn, verify = verifyInWorker,
    installed = null, timeoutMs = 120000, WebSocketImpl = WebSocket, Client = InferenceClient, checkInEveryMs = 3000,
    createBot = kind => new LocalBot({ kind, data: loadData(path.join(this.root, 'server')) }) }) {
    super();
    this.root = root;
    this.scripts = scripts;
    this.target = target;
    this.node = node;
    this.spawnChild = spawnChild;
    this.verify = verify;
    this.inspectInstalled = installed;
    this.timeoutMs = timeoutMs;
    this.WebSocketImpl = WebSocketImpl;
    this.Client = Client;
    this.checkInEveryMs = checkInEveryMs;
    this.createBot = createBot;
    this.bot = OPPONENTS.foulplay;
    this.generation = 0;
    this.state = 'idle';
    this.error = '';
    this.preset = 'full';
    this.engine = 'cloud';
    this.connection = null;
    this.battle = null;
    this.format = FORMAT;
    // In team formats: packed { player, bot } teams and the bot's export, in memory for this session
    // only (rematches reuse them). Never logged or saved.
    this.teams = null;
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
    // While queued for the cloud: { ticket, position, waiting }. The battle starts on its own.
    this.queue = null;
  }

  installed() {
    if (this.inspectInstalled) return this.inspectInstalled();
    return inspectRuntime(this.root).ok;
  }

  status() {
    return { installed: this.installed(), state: this.state, opponent: this.bot.id, format: this.format, engine: this.engine,
      threads: this.threads, queue: this.queue ? { position: this.queue.position, waiting: this.queue.waiting } : null,
      opponents: Object.values(OPPONENTS).map(bot => ({ id: bot.id, name: bot.name, local: bot.local, search: bot.search,
        difficulty: bot.difficulty, kind: bot.kind, formats: bot.formats, description: bot.description })),
      error: this.error, preset: this.preset, battle: this.battle };
  }

  changed() { this.emit('change', this.status()); }

  // `teams` ({ player, bot, botExport }) is required in team formats; the caller validated them.
  async start(options) {
    const { opponent = 'foulplay', preset = DEFAULT_PRESET, format = FORMAT, teams = null, engine = 'cloud' } =
      options && typeof options === 'object' ? options : {};
    if (typeof opponent !== 'string' || !Object.hasOwn(OPPONENTS, opponent)) return { ok: false, error: 'Choose a bot to play against.' };
    const bot = OPPONENTS[opponent];
    if (typeof format !== 'string' || !bot.formats.includes(format)) return { ok: false, error: `${bot.name} does not play that format.` };
    const withTeams = format !== FORMAT;
    // Packed teams go into simulator commands, so they must be a single line.
    const packed = team => typeof team === 'string' && team.length > 0 && team.length <= MAX_TEAM && !/[\r\n]/.test(team);
    if (withTeams && !(teams && packed(teams.player) && packed(teams.bot) && isTeamText(teams.botExport))) {
      return { ok: false, error: 'Choose both teams first.' };
    }
    // Only Foul Play uses the computation setting.
    if (bot.search && !Object.hasOwn(PRESETS, preset)) return { ok: false, error: 'Choose a supported computation setting.' };
    if (!ENGINES.includes(engine)) return { ok: false, error: 'Choose where Foul Play should run.' };
    if (this.state === 'starting' || this.state === 'ready') return { ok: false, error: 'Stop the current practice session before starting another.' };
    if (!this.installed()) return { ok: false, error: ERRORS.missing };
    const generation = ++this.generation;
    Object.assign(this, { bot, format, preset: bot.search ? preset : null, engine: bot.search ? engine : 'cloud',
      state: 'starting', error: '', battle: null,
      teams: withTeams ? { player: teams.player, bot: teams.bot, botExport: teams.botExport } : null });
    this.reset();
    this.connection = { token: crypto.randomBytes(32).toString('hex'), human: HUMAN, bot: this.bot.account, port: null, format,
      ...(withTeams ? { team: teams.player } : {}) };
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
      return this.fail(error.engine ? (this.bot.local ? 'bot' : 'engine') : 'start', generation, this.bot.local ? undefined : error.message);
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
    if (this.bot.local) return this.startLocalBot(generation);
    const engine = this.engine;
    const target = await this.target(engine);
    if (generation !== this.generation) return;
    const api = new this.Client({ url: target.url, key: target.key || null });
    this.api = api;
    // Only the cloud queues; the copy on this computer always has room for its one player.
    let session = await api.createSession({ bot: this.bot.id, preset: this.preset, format: this.format,
      ...(this.teams ? { team: this.teams.botExport } : {}), queue: engine === 'cloud' });
    if (session.queued) {
      session = await this.waitInQueue(api, session, generation, engine);
      if (!session) return;
      // The player chose to stop waiting and play on this computer instead.
      if (session.switched) return this.startEngine(generation);
    }
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

  // Waits for a cloud engine, checking in every few seconds; the startup timeout is paused meanwhile.
  // Resolves with the session, { switched: true } if the player moved to local, or null if stale.
  async waitInQueue(api, place, generation, engine) {
    clearTimeout(this.timer);
    const every = Math.max(250, Math.min(this.checkInEveryMs, Math.floor(place.checkInMs / 3)));
    let current = place;
    try {
      while (current.queued) {
        this.queue = { ticket: current.ticket, position: current.position, waiting: current.waiting };
        this.changed();
        await new Promise(resolve => setTimeout(resolve, every));
        if (generation !== this.generation) { api.leaveQueue(current.ticket); return null; }
        if (this.engine !== engine) { await api.leaveQueue(current.ticket); return { switched: true }; }
        current = await api.checkIn(current.ticket);
        if (generation !== this.generation) {
          if (current.queued) api.leaveQueue(current.ticket); else api.deleteSession(current.id);
          return null;
        }
      }
      return current;
    } finally {
      if (generation === this.generation) {
        this.queue = null;
        this.changed();
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.fail('timeout', generation), this.timeoutMs);
        this.timer.unref?.();
      }
    }
  }

  // While waiting for a cloud engine, the player can move to Foul Play on this computer.
  useEngine(engine) {
    if (!this.queue || !ENGINES.includes(engine) || engine === this.engine) return { ok: false };
    this.engine = engine;
    this.changed();
    return { ok: true };
  }

  // The simple bots play in this process; there is no API session and no thread count.
  async startLocalBot(generation) {
    const bot = this.createBot(this.bot.id);
    if (generation !== this.generation) { bot.close(); return; }
    this.inference = bot;
    bot.on('choice', choice => this.choice(choice, generation));
    bot.on('close', () => {
      if (generation === this.generation && this.inference === bot) this.fail('bot', generation);
    });
    await bot.ready;
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
            parts[4] === `/challenge ${this.format}` && parts[5] === this.format && (!this.battle || this.battle.finished)) {
          this.simulator.send(`|/utm ${this.teams ? this.teams.bot : 'null'}`);
          this.simulator.send(`|/accept ${HUMAN}`);
          this.accepted = true;
        }
      }
      return;
    }
    const room = lines[0].slice(1);
    if (!ROOM.test(room) || roomFormat(room) !== this.format) return;
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
    if (this.api && this.queue) this.api.leaveQueue(this.queue.ticket);
    for (const child of this.children) {
      child.stdin?.end?.();
      child.kill();
    }
    this.children.clear();
    this.reset();
    this.connection = null;
    this.battle = null;
    this.teams = null;
    this.state = 'idle';
    this.error = '';
    this.changed();
    return { ok: true };
  }
}

module.exports = { PracticeSession, ERRORS, OPPONENTS };
