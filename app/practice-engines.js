'use strict';

// Where Foul Play's moves are computed. Both engines expose the same practice inference API
// (api/server.js): the cloud one is the hosted server and the default; the local one is opt-in,
// runs inside this process on 127.0.0.1, and exists only once the player has downloaded Foul Play
// onto this computer (api/install.js, into the app's user data folder).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const installer = require('../api/install');
const { createApiServer } = require('../api/server');
const { InferenceClient } = require('../api/client');
const { apiOrigin } = require('../api/protocol');

// The hosted practice API. Override with SHOWDOWN_PRACTICE_API_URL.
const CLOUD_API_URL = 'https://34-174-209-142.sslip.io';

// A packaged app keeps the worker script outside app.asar so Python can read it.
function unpacked(file) {
  return file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

class CloudEngine {
  constructor({ url = process.env.SHOWDOWN_PRACTICE_API_URL || CLOUD_API_URL, key = process.env.SHOWDOWN_PRACTICE_API_KEY || null,
    Client = InferenceClient, refreshMs = 30000, now = Date.now } = {}) {
    this.key = key;
    this.Client = Client;
    this.refreshMs = refreshMs;
    this.now = now;
    try { this.url = url ? apiOrigin(url) : null; } catch { this.url = null; this.invalid = true; }
    this.value = { configured: Boolean(this.url), checked: false, online: false, available: false, error: '' };
    this.checkedAt = 0;
  }

  status() {
    if (this.url && !this.checking && this.now() - this.checkedAt > this.refreshMs) this.refresh();
    return { ...this.value };
  }

  async refresh() {
    this.checking = true;
    try {
      const info = await new this.Client({ url: this.url, key: this.key, timeoutMs: 5000 }).info();
      const bot = info.bots?.find(value => value.id === 'foulplay');
      this.value = { configured: true, checked: true, online: true, available: Boolean(bot?.available),
        busy: Boolean(info.capacity && (info.capacity.active >= info.capacity.max || info.capacity.waiting > 0)),
        waiting: Number.isInteger(info.capacity?.waiting) ? info.capacity.waiting : 0,
        queue: Number.isInteger(info.capacity?.queueMax) && info.capacity.queueMax > 0, presets: bot?.presets || null,
        error: bot?.available ? '' : 'Foul Play is not available on the cloud server right now.' };
    } catch (error) {
      this.value = { configured: true, checked: true, online: false, available: false, error: error.message };
    } finally {
      this.checking = false;
      this.checkedAt = this.now();
    }
  }

  async target() {
    if (!this.url) {
      throw new Error(this.invalid ? 'The cloud practice server address is invalid.'
        : 'No cloud practice server is set up in this build.');
    }
    return { url: this.url, key: this.key };
  }
}

// Foul Play on this computer. Nothing is downloaded until the player asks (install()); remove()
// deletes it again. While installed, target() starts a private API server on 127.0.0.1 on first
// use, with a key only this process knows and the search at below-normal priority.
class LocalEngine extends EventEmitter {
  constructor({ dir, install = installer.install, remove = installer.remove, inspect = installer.inspect,
    worker = unpacked(installer.WORKER), createServer = createApiServer,
    threads = Math.max(1, Math.min(8, os.availableParallelism?.() || os.cpus().length || 1)) } = {}) {
    super();
    this.dir = dir;
    this.installFn = install;
    this.removeFn = remove;
    this.inspectFn = inspect;
    this.worker = worker;
    this.createServer = createServer;
    this.threads = threads;
    this.installing = null;
    this.controller = null;
    this.progress = null;
    this.error = '';
    this.log = [];
    this.server = null;
    try { installer.platformKey(); this.supported = true; } catch { this.supported = false; }
  }

  inspect() { return this.inspectFn(this.dir, this.worker); }

  status() {
    const runtime = this.inspect();
    return { supported: this.supported, installed: runtime.installed, current: runtime.current,
      installing: Boolean(this.installing), progress: this.progress, error: this.error,
      log: this.log.slice(-4), revision: runtime.revision ? runtime.revision.slice(0, 7) : null, threads: this.threads };
  }

  changed() { this.emit('change', this.status()); }

  // Downloads and builds Foul Play, or updates an outdated copy. Resolves when done; progress
  // arrives as 'change' events and through status().
  install() {
    if (this.installing) return this.installing;
    if (!this.supported) return Promise.resolve({ ok: false, error: "Foul Play can't run on this computer's system yet." });
    const controller = new AbortController();
    this.controller = controller;
    this.error = '';
    this.log = [];
    this.progress = { fraction: 0, label: 'Starting', detail: '', index: 0, steps: installer.STEPS.length };
    let lastEmit = 0;
    const emit = force => {
      // The engine build prints thousands of lines; the page polls about once a second anyway.
      if (force || Date.now() - lastEmit > 200) { lastEmit = Date.now(); this.changed(); }
    };
    this.installing = (async () => {
      try {
        await this.closeServer();
        await this.installFn({ dir: this.dir, worker: this.worker, signal: controller.signal,
          onProgress: progress => { this.progress = progress; emit(); },
          onLog: line => { this.log.push(String(line).slice(0, 300)); if (this.log.length > 50) this.log.shift(); } });
        this.progress = null;
        return { ok: true };
      } catch (error) {
        this.progress = null;
        if (controller.signal.aborted) return { ok: false, cancelled: true };
        this.error = error.message || 'Foul Play could not be downloaded.';
        return { ok: false, error: this.error };
      } finally {
        this.installing = null;
        this.controller = null;
        emit(true);
      }
    })();
    this.changed();
    return this.installing;
  }

  cancel() {
    this.controller?.abort(new Error('Download cancelled.'));
    return { ok: true };
  }

  // A battle using the local server is the caller's to stop first (see main.js).
  async remove() {
    if (this.installing) return { ok: false, error: 'Wait for the download to finish, or cancel it first.' };
    await this.closeServer();
    await this.removeFn(this.dir);
    this.error = '';
    this.changed();
    return { ok: true };
  }

  async target() {
    if (this.installing) throw new Error('Foul Play is still downloading onto this computer.');
    const runtime = this.inspect();
    if (!runtime.installed) throw new Error('Foul Play is not on this computer. Download it on the Bots page, or play on the cloud server.');
    if (!this.server) {
      const key = crypto.randomBytes(32).toString('hex');
      const api = this.createServer({ runtime: () => { const value = this.inspect(); return value.installed ? value : null; },
        apiKey: key, maxSessions: 2, maxSessionsPerClient: 2, sessionBurst: 100, sessionsPerHour: 3600,
        maxThreads: this.threads, lowPriority: true });
      this.server = { api, key, url: api.listen(0, '127.0.0.1') };
    }
    return { url: await this.server.url, key: this.server.key };
  }

  async closeServer() {
    const server = this.server;
    this.server = null;
    if (server) await server.api.close();
  }

  dispose() {
    this.cancel();
    return this.closeServer();
  }
}

module.exports = { CloudEngine, LocalEngine, CLOUD_API_URL, unpacked };
