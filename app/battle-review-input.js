'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validReplayViewParams } = require('./replays');

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 30000;
const MAX_LINE_LENGTH = 16384;
const FILE_TYPES = ['html', 'htm', 'json', 'log', 'txt'];
const ROOM_ID = /^battle-[a-z0-9]{1,60}-[0-9]+(?:-[a-z0-9]+pw)?$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MESSAGES = Object.freeze({
  'invalid-replay': 'Choose a Pokémon Showdown replay with a battle protocol log.',
  'incomplete-replay': 'This battle is unfinished or its ending is missing.',
  'review-limit': 'This replay exceeds the Battle Review size or turn limit.',
  'review-file': 'The selected replay file could not be read. Choose it again.',
  'review-url': 'Enter a replay link from replay.pokemonshowdown.com.',
  'review-fetch': 'Showdown could not provide this replay. Check the link and your connection.',
  'review-room': 'This finished player battle is no longer available in the current room.',
  'review-note': 'This saved replay note is unavailable.',
  'review-timeout': 'The review timed out. Try again.',
  'review-failed': 'The replay could not be reviewed.',
});

function problem(code) { return Object.assign(new Error(MESSAGES[code]), { code }); }

function replayLogUrl(value) {
  if (typeof value !== 'string' || value.length > 300 || /[#\\\x00-\x1f]/.test(value)) return null;
  const match = /^https?:\/\/replay\.pokemonshowdown\.com\/((?:[a-z0-9]+-)+[0-9]+(?:-[a-z0-9]+pw)?)(?:\/|\.log|\.json)?(?:\?([^#]*))?$/i.exec(value.trim());
  if (!match || !validReplayViewParams(new URLSearchParams(match[2]))) return null;
  return 'https://replay.pokemonshowdown.com/' + match[1] + '.log';
}

// This function also runs inside the battle client, before data crosses into the launcher.
// The upstream client can include chat, server HTML and private request messages in its queue.
function visibleProtocol(lines, maxLines, maxLength, maxChars) {
  if (!Array.isArray(lines) || lines.length > maxLines) return { code: 'review-limit' };
  const permitted = /^(?:\|$|\|(?:gametype|gen|tier|player|teamsize|start|turn|move|switch|replace|detailschange|drag|faint|cant|upkeep|win|tie|poke|teampreview|-[-a-z0-9]+)(?:\||$))/;
  const textOnly = /^\|-(?:message|hint|anim|animcustom)\|/;
  const hpEvent = /^\|(?:switch|drag|replace|detailschange|-damage|-heal|-sethp)\|/;
  const normalizeHP = field => {
    const match = /^(\d{1,6})\/(\d{1,6})( [a-z]{3})?$/.exec(field);
    if (!match) return field;
    const hp = Number(match[1]), max = Number(match[2]);
    if (!max || hp > max || max === 48 || max === 100) return field;
    // Gen 7+ displays percentages, rounded up except for an injured Pokémon near full HP.
    const percent = hp === max ? 100 : Math.min(99, Math.ceil(100 * hp / max));
    return percent + '/100' + (match[3] || '');
  };
  const kept = [];
  let length = 0;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (typeof line !== 'string') return { code: 'invalid-replay' };
    if (line.startsWith('|split|')) {
      // Simulator split records contain a private line followed by its spectator equivalent.
      if (!/^\|split\|p[1-4]$/.test(line) || i + 2 >= lines.length) return { code: 'invalid-replay' };
      i += 2;
      line = lines[i];
      if (typeof line !== 'string' || line.startsWith('|split|')) return { code: 'invalid-replay' };
    }
    if (!permitted.test(line) || textOnly.test(line)) continue;
    if (line.length > maxLength) return { code: 'review-limit' };
    if (/[\r\n\0]/.test(line)) return { code: 'invalid-replay' };
    if (line.startsWith('|player|')) line = line.split('|', 4).join('|');
    if (hpEvent.test(line)) line = line.split('|').map(normalizeHP).join('|');
    length += line.length + 1;
    if (length > maxChars) return { code: 'review-limit' };
    kept.push(line);
    if (line === '|tie' || /^\|win\|[^|]+$/.test(line)) return { log: kept.join('\n') };
  }
  return { code: kept.length ? 'incomplete-replay' : 'invalid-replay' };
}

function extractProtocol(text, type) {
  let raw = text;
  if (type === 'html' || type === 'htm') {
    // The official Download replay export contains one inert plain-text script. Never load the HTML.
    const marker = '<script type="text/plain" class="battle-log-data">';
    const start = text.indexOf(marker);
    const end = start < 0 ? -1 : text.indexOf('</script>', start + marker.length);
    if (end < 0) throw problem('invalid-replay');
    raw = text.slice(start + marker.length, end).replace(/\\\//g, '/');
  } else if (type === 'json') {
    try { raw = JSON.parse(text)?.log; } catch { throw problem('invalid-replay'); }
  }
  if (typeof raw === 'string') {
    // Bound the array allocation even for files made entirely of newline characters.
    let count = 1;
    for (let i = raw.indexOf('\n'); i !== -1; i = raw.indexOf('\n', i + 1)) {
      if (++count > MAX_LINES) throw problem('review-limit');
    }
    raw = raw.split(/\r?\n/);
  }
  if (!Array.isArray(raw)) throw problem('invalid-replay');
  const result = visibleProtocol(raw, MAX_LINES, MAX_LINE_LENGTH, MAX_LOG_BYTES);
  if (result.code) throw problem(result.code);
  if (Buffer.byteLength(result.log) > MAX_LOG_BYTES) throw problem('review-limit');
  return result.log;
}

function decode(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw problem('invalid-replay'); }
}

async function readReplayFile(file, signal) {
  let handle;
  try {
    // NONBLOCK also allows rejecting a FIFO without waiting for a writer on Unix.
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw problem('review-file');
    if (stat.size > MAX_FILE_BYTES) throw problem('review-limit');
    const chunks = [];
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      const buffer = Buffer.allocUnsafe(Math.min(65536, MAX_FILE_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_FILE_BYTES) throw problem('review-limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return decode(Buffer.concat(chunks, total));
  } catch (error) {
    if (Object.hasOwn(MESSAGES, error.code)) throw error;
    throw problem('review-file');
  } finally { await handle?.close().catch(() => {}); }
}

async function fetchReplay(rawUrl, signal, fetchImpl = globalThis.fetch) {
  const url = replayLogUrl(rawUrl);
  if (!url) throw problem('review-url');
  let reader, response;
  try {
    response = await fetchImpl(url, { method: 'GET', credentials: 'omit', redirect: 'error',
      cache: 'no-store', referrerPolicy: 'no-referrer', signal, headers: { Accept: 'text/plain' } });
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) throw problem('review-fetch');
    if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) throw problem('review-limit');
    reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FILE_BYTES) throw problem('review-limit');
      chunks.push(Buffer.from(value));
    }
    return decode(Buffer.concat(chunks, total));
  } catch (error) {
    if (Object.hasOwn(MESSAGES, error.code)) throw error;
    throw problem('review-fetch');
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    } else if (response?.body) await response.body.cancel().catch(() => {});
  }
}

function runReviewWorker(text, type, signal) {
  const { Worker } = require('node:worker_threads');
  signal.throwIfAborted();
  const worker = new Worker(path.join(__dirname, 'battle-review-worker.js'), {
    workerData: { text, type }, resourceLimits: { maxOldGenerationSizeMb: 96 },
  });
  return new Promise((resolve, reject) => {
    const abort = () => { worker.terminate().catch(() => {}); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', value => value.report ? resolve(value.report) : reject(problem(value.code)));
    worker.once('error', () => reject(problem('review-failed')));
    worker.once('exit', () => {
      signal.removeEventListener('abort', abort);
      reject(problem('review-failed'));
    });
  });
}

// Electron cannot interrupt an executeJavaScript read in a closing or unresponsive client.
function waitForCapture(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

class BattleReviewInput {
  constructor({ getNoteUrl, capture, analyze = runReviewWorker, fetchImpl, timeoutMs = 20000 }) {
    this.getNoteUrl = getNoteUrl;
    this.capture = capture;
    this.analyze = analyze;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.epoch = 0;
    this.clear();
  }

  status() {
    const noteId = this.noteId && this.getNoteUrl(this.noteId) ? this.noteId : null;
    return { ok: true, report: this.report, side: this.side, noteId };
  }
  cancel() { this.epoch++; this.job?.abort(); this.job = null; }
  leave() { this.cancel(); this.selected = null; }
  clear() { this.leave(); this.report = null; this.side = 'p1'; this.noteId = null; }

  async choose(picker) {
    if (this.picking) return { ok: false, error: 'A replay file picker is already open.' };
    this.cancel();
    const epoch = this.epoch;
    this.picking = true;
    try {
      const file = await picker();
      if (!file || epoch !== this.epoch) return { ok: true, cancelled: true };
      const type = path.extname(file).slice(1).toLowerCase();
      if (!FILE_TYPES.includes(type)) throw problem('review-file');
      this.selected = { file, type, token: randomUUID() };
      return { ok: true, token: this.selected.token, name: path.basename(file) };
    } catch { return { ok: false, error: MESSAGES['review-file'] }; }
    finally { this.picking = false; }
  }

  async review(source) {
    this.cancel();
    const job = new AbortController();
    this.job = job;
    const signal = AbortSignal.any([job.signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      let text, type = 'log', side = 'p1';
      if (source.kind === 'online' || source.kind === 'practice') {
        if (typeof source.roomId !== 'string' || source.roomId.length > 120 || !ROOM_ID.test(source.roomId)) throw problem('review-room');
        const captured = await waitForCapture(Promise.resolve(this.capture(source.kind, source.roomId)), signal);
        if (captured?.code === 'review-limit') throw problem('review-limit');
        if (!captured || !['p1', 'p2'].includes(captured.side) || typeof captured.log !== 'string' ||
            captured.log.length > MAX_LOG_BYTES || Buffer.byteLength(captured.log) > MAX_LOG_BYTES) throw problem('review-room');
        text = captured.log;
        side = captured.side;
      } else if (source.kind === 'file') {
        if (!this.selected || source.token !== this.selected.token) throw problem('review-file');
        type = this.selected.type;
        text = await readReplayFile(this.selected.file, signal);
      } else if (source.kind === 'url' || source.kind === 'note') {
        let url = source.url;
        if (source.kind === 'note') {
          if (typeof source.id !== 'string' || !UUID.test(source.id)) throw problem('review-note');
          url = this.getNoteUrl(source.id);
          if (!url) throw problem('review-note');
        }
        text = await fetchReplay(url, signal, this.fetchImpl);
      } else throw problem('invalid-replay');
      signal.throwIfAborted();
      const report = await this.analyze(text, type, signal);
      signal.throwIfAborted();
      this.report = report;
      this.side = side;
      this.noteId = source.kind === 'note' ? source.id : null;
      return { ok: true };
    } catch (error) {
      if (job.signal.aborted) return { ok: true, cancelled: true };
      const code = signal.aborted ? 'review-timeout' : error?.code;
      return { ok: false, error: Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : MESSAGES['review-failed'] };
    } finally { if (this.job === job) this.job = null; }
  }
}

module.exports = { BattleReviewInput, FILE_TYPES, MAX_FILE_BYTES, MAX_LOG_BYTES, MAX_LINES, MAX_LINE_LENGTH,
  ROOM_ID, visibleProtocol, extractProtocol, fetchReplay, replayLogUrl, MESSAGES };
