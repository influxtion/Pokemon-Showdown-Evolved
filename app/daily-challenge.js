'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const DAY = 86400000;
const dayAt = now => Math.floor(now / DAY);
const OPTIONS = Object.freeze({ opponent: 'foulplay-casual', format: 'gen9randombattle', preset: 'full' });
const empty = day => ({ version: 1, day, attempts: 0, cleared: false, streak: 0, best: 0, total: 0, lastWin: null, pending: null });
const integer = value => Number.isSafeInteger(value) && value >= 0;
function valid(data) {
  return data && data.version === 1 && integer(data.day) && data.day < 2932896 && integer(data.attempts) && data.attempts <= 3 &&
    typeof data.cleared === 'boolean' && ['streak', 'best', 'total'].every(key => integer(data[key])) &&
    data.best >= data.streak && data.total >= data.best &&
    (data.lastWin === null || (integer(data.lastWin) && data.lastWin <= data.day)) &&
    (!data.cleared || (data.lastWin === data.day && data.attempts > 0 && data.streak > 0)) &&
    (data.pending === null || (!data.cleared && data.attempts > 0 &&
      typeof data.pending.id === 'string' && /^[a-f0-9-]{36}$/.test(data.pending.id) &&
      ['starting', 'active'].includes(data.pending.phase)));
}

// Private, per-profile progress. The main process owns both attempts and simulator results.
class DailyStore {
  constructor(dir, { now = Date.now, fileSystem = fs } = {}) {
    this.now = now;
    this.fs = fileSystem;
    this.file = path.join(dir, 'daily-challenge.json');
    this.error = '';
    try {
      if (this.fs.statSync(this.file).size > 8192) throw new Error('size');
      this.data = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      if (!valid(this.data)) throw new Error('invalid');
    } catch (error) {
      if (error.code === 'ENOENT') this.data = empty(dayAt(now()));
      else this.error = 'Daily challenge progress could not be read. Your saved file has been kept.';
    }
    // A closed app cannot resume its simulator. A started battle counts; setup does not.
    if (!this.error && this.data.pending) {
      this.finish(this.data.pending.id, this.data.pending.phase === 'starting' ? 'refund' : 'loss');
    }
  }

  save(data) {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.fs.writeFileSync(temp, JSON.stringify(data) + '\n', { flag: 'wx' });
      this.fs.renameSync(temp, this.file);
      this.data = data;
      return true;
    } catch {
      this.error = 'Daily challenge progress could not be saved. Restart the app to try again.';
      return false;
    } finally {
      try { this.fs.rmSync(temp, { force: true }); } catch { /* Preserve the saved file. */ }
    }
  }

  roll() {
    if (this.error) return false;
    const day = dayAt(this.now());
    // Moving the clock backwards never opens an older challenge for extra attempts.
    if (day < this.data.day) return false;
    if (day > this.data.day) {
      const streak = this.data.lastWin === day - 1 ? this.data.streak : 0;
      return this.save({ ...this.data, day, attempts: 0, cleared: false, pending: null, streak });
    }
    return true;
  }

  status() {
    const current = this.roll();
    if (this.error) return { ok: false, error: this.error };
    const data = this.data;
    return { ok: true, day: new Date(data.day * DAY).toISOString().slice(0, 10),
      resetAt: new Date((data.day + 1) * DAY).toISOString(), attemptsLeft: 3 - data.attempts,
      cleared: data.cleared, streak: data.streak, best: data.best, total: data.total,
      pending: Boolean(data.pending), canStart: current && !data.pending && !data.cleared && data.attempts < 3,
      clockError: !current };
  }

  reserve() {
    if (!this.status().canStart) return null;
    const id = randomUUID();
    return this.save({ ...this.data, attempts: this.data.attempts + 1, pending: { id, phase: 'starting' } }) ? id : null;
  }

  activate(id) {
    if (!this.roll() || this.data.pending?.id !== id) return false;
    if (this.data.pending.phase === 'active') return true;
    return this.save({ ...this.data, pending: { id, phase: 'active' } });
  }

  finish(id, result) {
    if (!this.roll() || this.data.pending?.id !== id) return;
    const data = { ...this.data, pending: null };
    if (result === 'refund') data.attempts--;
    else if (result === 'win') {
      data.cleared = true;
      data.streak = data.lastWin === data.day - 1 ? data.streak + 1 : 1;
      data.lastWin = data.day;
      data.best = Math.max(data.best, data.streak);
      data.total++;
    } else if (data.attempts === 3) data.streak = 0;
    this.save(data);
  }
}

class DailyChallenge {
  constructor(store, practice) {
    this.store = store;
    this.practice = practice;
    this.attempt = null;
    this.starting = false;
    practice.on('change', state => {
      if (!this.attempt || !state.battle) return;
      const active = store.activate(this.attempt);
      if (state.battle.finished) {
        if (active) store.finish(this.attempt, state.battle.result === 'win' ? 'win' : 'loss');
        this.attempt = null;
      }
    });
    practice.on('ending', reason => {
      if (!this.attempt) return;
      store.finish(this.attempt, reason === 'failure' || !practice.battle ? 'refund' : 'loss');
      this.attempt = null;
    });
  }

  status() {
    return { ...this.store.status(), session: Boolean(this.practice.dailyChallenge),
      running: Boolean(this.attempt), busy: this.starting };
  }

  async start(engine) {
    if (this.starting || this.attempt) return { ok: false, error: 'A daily attempt is already running.' };
    if (['starting', 'ready'].includes(this.practice.state) && !this.practice.battle?.finished) {
      return { ok: false, error: 'End the current practice session first.' };
    }
    if (!this.store.status().canStart) return { ok: false, error: this.store.error || 'No daily attempts are available.' };
    this.practice.stop();
    const id = this.store.reserve();
    if (!id) return { ok: false, error: this.store.error || 'Could not reserve an attempt.' };
    this.attempt = id;
    this.practice.dailyChallenge = true;
    this.starting = true;
    try {
      const result = await this.practice.start({ ...OPTIONS, engine });
      if (!result.ok) { this.store.finish(id, 'refund'); this.attempt = null; this.practice.dailyChallenge = false; }
      return result;
    } catch {
      this.store.finish(id, 'refund');
      this.attempt = null;
      this.practice.stop();
      return { ok: false, error: 'The daily challenge could not start. Your attempt was returned.' };
    } finally { this.starting = false; }
  }
}

module.exports = { DailyStore, DailyChallenge, OPTIONS, DAY };
