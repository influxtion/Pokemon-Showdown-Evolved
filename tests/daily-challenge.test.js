'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DailyStore, DailyChallenge, OPTIONS, DAY } = require('../app/daily-challenge');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-challenge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-11-19T12:00:00Z');
  const clock = () => now;
  const store = new DailyStore(dir, { now: clock });
  const finish = result => { const id = store.reserve(); assert.ok(id); store.activate(id); store.finish(id, result); return id; };
  return { dir, clock, store, finish, advance: days => { now += DAY * days; } };
}
test('three attempts, third-attempt win, duplicate result and completion lock', t => {
  const { store, finish } = setup(t);
  finish('loss'); finish('loss');
  assert.equal(store.status().attemptsLeft, 1);
  const id = finish('win');
  store.finish(id, 'win');
  assert.equal(store.status().streak, 1);
  assert.equal(store.status().total, 1);
  assert.equal(store.reserve(), null);
});
test('consecutive days build streak; exhausted day resets it and retains records', t => {
  const { store, finish, advance } = setup(t);
  finish('win'); advance(1); finish('win'); advance(1);
  assert.equal(store.status().streak, 2);
  finish('loss'); finish('loss');
  assert.equal(store.status().streak, 2);
  finish('tie');
  assert.equal(store.status().streak, 0);
  assert.equal(store.status().best, 2);
  assert.equal(store.reserve(), null);
  advance(1); finish('win');
  assert.equal(store.status().streak, 1);
  assert.equal(store.status().total, 3);
});
test('missed day resets; backwards clock cannot reopen an old day', t => {
  const { store, finish, advance } = setup(t);
  finish('win'); advance(2);
  assert.equal(store.status().streak, 0);
  assert.equal(store.status().best, 1);
  advance(-1);
  assert.equal(store.status().clockError, true);
  assert.equal(store.reserve(), null);
});
test('midnight expires pending attempt; late results cannot clear the next day', t => {
  const { store, advance } = setup(t);
  const id = store.reserve(); store.activate(id); advance(1);
  store.finish(id, 'win');
  assert.equal(store.status().total, 0);
  assert.equal(store.status().attemptsLeft, 3);
});
test('restart charges active attempt but refunds setup; records persist', t => {
  const { store, dir, clock, finish } = setup(t);
  finish('loss');
  store.reserve();
  const restarted = new DailyStore(dir, { now: clock });
  assert.equal(restarted.status().attemptsLeft, 2);
  const id = restarted.reserve(); restarted.activate(id);
  const again = new DailyStore(dir, { now: clock });
  assert.equal(again.status().attemptsLeft, 1);
  assert.equal(again.status().pending, false);
});
test('corrupt and failed-write stores fail closed without overwriting data', t => {
  const { dir, clock, store, finish } = setup(t);
  finish('win');
  const file = path.join(dir, 'daily-challenge.json');
  const bytes = fs.readFileSync(file, 'utf8');
  const broken = new DailyStore(dir, { now: () => clock() + DAY, fileSystem: { ...fs, renameSync() { throw new Error('disk'); } } });
  assert.equal(broken.reserve(), null);
  assert.equal(broken.status().ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  fs.writeFileSync(file, '{broken');
  const corrupt = new DailyStore(dir, { now: clock });
  assert.equal(corrupt.reserve(), null);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert.equal(store.status().cleared, true);
});
class Session extends EventEmitter {
  state = 'idle'; battle = null; dailyChallenge = false;
  async start(options) { this.options = options; this.state = 'ready'; this.emit('change', this); return { ok: true }; }
  stop(reason = 'stop') { this.emit('ending', reason); this.dailyChallenge = false; this.battle = null; this.state = 'idle'; }
  play(result) { this.battle = { finished: Boolean(result), result }; this.emit('change', this); }
}
test('controller pins Medium and counts only daily simulator results', async t => {
  const { store } = setup(t); const session = new Session(); const daily = new DailyChallenge(store, session);
  session.play('win');
  assert.equal(store.status().total, 0);
  session.battle = null;
  assert.equal((await daily.start('cloud')).ok, true);
  assert.deepEqual(session.options, { ...OPTIONS, engine: 'cloud' });
  assert.equal((await daily.start('cloud')).ok, false);
  session.play(); session.play('win'); session.play('win');
  assert.equal(store.status().total, 1);
  assert.equal((await daily.start('cloud')).ok, false);
});
test('controller refunds setup cancellation and engine failures but charges active quits', async t => {
  const { store } = setup(t); const session = new Session(); const daily = new DailyChallenge(store, session);
  await daily.start('cloud'); session.stop();
  assert.equal(store.status().attemptsLeft, 3);
  await daily.start('cloud'); session.play(); session.stop('failure');
  assert.equal(store.status().attemptsLeft, 3);
  await daily.start('local'); session.play(); session.stop();
  assert.equal(store.status().attemptsLeft, 2);
});
test('rejected startup refunds and unrelated active practice is preserved', async t => {
  const { store } = setup(t); const session = new Session(); const daily = new DailyChallenge(store, session);
  session.state = 'ready';
  assert.equal((await daily.start('cloud')).ok, false);
  assert.equal(session.state, 'ready');
  session.state = 'idle'; session.start = async () => ({ ok: false });
  assert.equal((await daily.start('cloud')).ok, false);
  assert.equal(store.status().attemptsLeft, 3);
});

test('expired daily battle can finish without blocking the next challenge', async t => {
  const { store, advance } = setup(t); const session = new Session(); const daily = new DailyChallenge(store, session);
  await daily.start('cloud'); session.play(); advance(1); session.play('win');
  assert.equal(daily.status().running, false);
  assert.equal(store.status().total, 0);
  assert.equal((await daily.start('cloud')).ok, true);
});
