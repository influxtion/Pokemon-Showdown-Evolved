'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Updates, restartBlocker } = require('../app/updates');

const session = () => ({ ready: true, connected: true, rooms: [], search: { pending: false, formats: [] }, messages: [] });
function fixture(options = {}) {
  const updater = new EventEmitter();
  let checks = 0, downloads = 0, installs = 0;
  updater.checkForUpdates = async () => { checks++; return { updateInfo: { version: '0.3.0' }, cancellationToken: {} }; };
  updater.downloadUpdate = async () => { downloads++; updater.emit('download-progress', { percent: 55 }); updater.emit('update-downloaded'); };
  const updates = new Updates({ updater, version: '0.2.0', checkSafe: async () => '', confirm: async () => true,
    install: () => installs++, ...options });
  return { updates, updater, counts: () => ({ checks, downloads, installs }) };
}

test('downloads without ever installing automatically or on ordinary exit', async () => {
  const f = fixture();
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.updater.allowDowngrade, false);
  assert.equal(f.updater.allowPrerelease, true);
  await f.updates.check();
  assert.equal(f.updates.status().phase, 'ready');
  await f.updates.check();
  assert.deepEqual(f.counts(), { checks: 1, downloads: 1, installs: 0 });
});
test('restart is explicit, checked twice, and cancellable', async () => {
  let safeChecks = 0;
  const f = fixture({ checkSafe: async () => { safeChecks++; return ''; } });
  assert.equal((await f.updates.restart()).ok, false);
  await f.updates.check();
  assert.equal((await f.updates.restart()).ok, true);
  assert.equal(safeChecks, 2);
  assert.equal(f.counts().installs, 1);
  const cancelled = fixture({ confirm: async () => false });
  await cancelled.updates.check();
  assert.equal((await cancelled.updates.restart()).cancelled, true);
  assert.equal(cancelled.counts().installs, 0);
});
test('battle or unsaved draft appearing during confirmation prevents restart', async () => {
  for (const message of ['Finish your battle.', 'Save your note.']) {
    let blocker = '';
    const f = fixture({ checkSafe: async () => blocker, confirm: async () => { blocker = message; return true; } });
    await f.updates.check();
    assert.equal((await f.updates.restart()).error, message);
    assert.equal(f.counts().installs, 0);
    assert.equal(f.updates.status().phase, 'ready');
  }
});
test('unknown, disconnected, searching, challenged, spectating, and practice states block', () => {
  assert.equal(restartBlocker({ session: session() }), '');
  for (const change of [{ dirty: true }, { busy: true }, { session: null },
    { session: { ...session(), connected: false } },
    { session: { ...session(), rooms: [{ id: 'battle-gen9ou-1', battle: false, ended: false }] } },
    { session: { ...session(), rooms: [{ battle: true, players: [], ended: false }] } },
    { session: { ...session(), search: { pending: true } } },
    { session: { ...session(), search: { formats: ['gen9ou'] } } },
    { session: { ...session(), messages: [{ challenge: { dir: 'out' } }] } },
    { practice: { state: 'starting' } }, { practice: { state: 'ready', battle: { finished: false } } }]) {
    assert.ok(restartBlocker({ session: session(), ...change }));
  }
  assert.equal(restartBlocker({ session: { ...session(), rooms: [{ battle: true, ended: true }] }, practice: { state: 'ready', battle: { finished: true } } }), '');
});
test('network/checksum failures keep the app open, allow retry, and never mark ready', async () => {
  const f = fixture();
  f.updater.downloadUpdate = async () => { throw new Error('checksum mismatch'); };
  await f.updates.check();
  assert.equal(f.updates.status().phase, 'error');
  assert.equal((await f.updates.restart()).ok, false);
  f.updater.downloadUpdate = async () => f.updater.emit('update-downloaded');
  await f.updates.check();
  assert.equal(f.updates.status().phase, 'ready');
  assert.equal(f.counts().installs, 0);
});
test('manual and development builds do not check or download', async () => {
  for (const mode of ['manual', 'development']) {
    const f = fixture({ mode });
    f.updates.start();
    await f.updates.check();
    assert.deepEqual(f.counts(), { checks: 0, downloads: 0, installs: 0 });
    f.updates.dispose();
  }
});
test('simultaneous checks and restart clicks cannot launch duplicates', async () => {
  let release;
  const f = fixture({ confirm: () => new Promise(resolve => { release = resolve; }) });
  await Promise.all([f.updates.check(), f.updates.check()]);
  assert.equal(f.counts().checks, 1);
  const first = f.updates.restart();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.updates.restart()).ok, false);
  release(true);
  await first;
  assert.equal(f.counts().installs, 1);
});
