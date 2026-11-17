'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const Module = require('node:module');
const path = require('node:path');

const bridgeFile = path.join(__dirname, '..', 'app', 'showdown.js');
const originalLoad = Module._load;
let ShowdownBridge;
// The public profile fetch behind ratings; a test can swap in a slow one.
const quickFetch = async () => ({ ok: false });
let fetchImpl = quickFetch;
let fetchCalls = 0;
try {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { net: { fetch: (...args) => { fetchCalls += 1; return fetchImpl(...args); } } };
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ ShowdownBridge } = require(bridgeFile));
} finally {
  Module._load = originalLoad;
}

function page(options = {}) {
  const identity = { userid: options.userid || 'tester', name: options.name || 'Tester', registered: options.registered !== false };
  const listeners = new Map();
  const sends = [];
  const timers = [];
  const app = {
    rooms: { '': { curFormat: 'gen9ou' } }, roomsData: {}, isDisconnected: false,
    user: { get: (key) => identity[key] },
    once(event, callback) { listeners.set(event, callback); },
    off(event, callback) { if (listeners.get(event) === callback) listeners.delete(event); },
    send(command) {
      sends.push(command);
      if (options.silent) return;
      const sender = identity.userid;
      queueMicrotask(() => {
        const callback = listeners.get('response:friends');
        if (callback) {
          listeners.delete('response:friends');
          const response = options.responses && Object.hasOwn(options.responses, sender) ? options.responses[sender] :
            Object.hasOwn(options, 'response') ? options.response : [];
          callback(response);
        }
      });
    },
  };
  const context = vm.createContext({
    app, window: { app, BattleFormats: {}, Storage: { teams: [], unpackTeam: () => [] } },
    BattleFormats: {}, Storage: { teams: [], unpackTeam: () => [] },
    document: { querySelectorAll: () => [] },
    setTimeout(callback, ms) { timers.push(ms); return setTimeout(callback, options.fastTimeout ? 1 : ms); },
    clearTimeout,
  });
  const contents = {
    isLoading: () => false,
    executeJavaScript: (code) => vm.runInContext(code, context),
  };
  return { identity, app, contents, sends, timers, listeners };
}

test('structured friends query sanitizes names, IDs, presence and duplicates', async () => {
  const source = page({ response: [
    { userid: 'alice', name: 'Alice\n', online: true, status: 'online' },
    { userid: 'idlefriend', name: 'Idle Friend', online: true, status: 'idle' },
    { userid: 'busyfriend', name: 'Busy Friend', online: true, status: 'busy' },
    { userid: 'offlinefriend', name: 'Offline Friend', online: false, status: 'offline' },
    { userid: 'bad/id', name: 'Bad', online: true, status: 'online' },
    { userid: 'alice', name: 'Duplicate', online: true, status: 'online' },
    { userid: 'fakedbattle', name: 'Fake', online: true, status: 'battling' },
    { userid: 'mismatch', name: 'Mismatch', online: false, status: 'online' },
  ] });
  const state = await new ShowdownBridge(() => source.contents).snapshot();
  assert.equal(state.ready, true);
  assert.deepEqual(state.friends, { available: true, items: [
    { userid: 'alice', name: 'Alice', online: true, status: 'online' },
    { userid: 'idlefriend', name: 'Idle Friend', online: true, status: 'idle' },
    { userid: 'busyfriend', name: 'Busy Friend', online: true, status: 'busy' },
    { userid: 'offlinefriend', name: 'Offline Friend', online: false, status: 'offline' },
  ] });
  assert.deepEqual(source.sends, ['/cmd friends']);
  assert.equal(source.listeners.size, 0);
});

test('guest, unavailable and malformed responses keep the fallback', async () => {
  const guest = page({ registered: false });
  assert.deepEqual((await new ShowdownBridge(() => guest.contents).snapshot()).friends, { available: false, items: [] });
  assert.deepEqual(guest.sends, []);
  const offline = page();
  offline.app.isDisconnected = true;
  assert.deepEqual((await new ShowdownBridge(() => offline.contents).snapshot()).friends, { available: false, items: [] });
  assert.deepEqual(offline.sends, []);
  const empty = page({ response: [] });
  assert.deepEqual((await new ShowdownBridge(() => empty.contents).snapshot()).friends, { available: true, items: [] });

  for (const response of [null, { friends: [] }, 'bad response']) {
    const source = page({ response });
    assert.deepEqual((await new ShowdownBridge(() => source.contents).snapshot()).friends, { available: false, items: [] });
  }
  const invalidItems = page({ response: [{ userid: 'bad/id', online: true, status: 'online' }] });
  assert.deepEqual((await new ShowdownBridge(() => invalidItems.contents).snapshot()).friends, { available: false, items: [] });
  const timeout = page({ silent: true, fastTimeout: true });
  const bridge = new ShowdownBridge(() => timeout.contents);
  const result = await bridge.snapshot();
  assert.deepEqual(result.friends, { available: false, items: [] });
  assert.deepEqual(timeout.sends, ['/cmd friends']);
  assert.deepEqual(timeout.timers, [4500]);
  assert.equal(timeout.listeners.size, 0);
  await bridge.snapshot();
  assert.equal(timeout.sends.length, 1, 'short failure cache avoids repeated queries');
  bridge.friendsCache.clear();
  await bridge.snapshot();
  assert.equal(timeout.sends.length, 1, 'same-account retry stays latched after cache loss');
  assert.equal(timeout.listeners.size, 0, 'no response listener remains after timeout');
  timeout.identity.userid = 'other';
  await bridge.snapshot();
  assert.equal(timeout.sends.length, 1, 'late untagged response cannot be assigned to another account');
});

test('cache and concurrent snapshots do not duplicate queries or mix accounts', async () => {
  const source = page({ responses: {
    tester: [{ userid: 'alice', name: 'Alice', online: true, status: 'online' }],
    other: [{ userid: 'bob', name: 'Bob', online: false, status: 'offline' }],
  } });
  const bridge = new ShowdownBridge(() => source.contents);
  const first = await Promise.all([bridge.snapshot(), bridge.snapshot()]);
  assert.deepEqual(source.sends, ['/cmd friends']);
  assert.equal(first[0].friends.items[0].userid, 'alice');
  first[0].friends.items[0].name = 'Changed locally';
  assert.equal((await bridge.snapshot()).friends.items[0].name, 'Alice', 'cache result is copied');
  source.identity.userid = 'other';
  source.identity.name = 'Other';
  const other = await bridge.snapshot();
  assert.equal(other.friends.items[0].userid, 'bob');
  assert.deepEqual(source.sends, ['/cmd friends', '/cmd friends']);
  source.identity.userid = 'tester';
  const again = await bridge.snapshot();
  assert.equal(again.friends.items[0].userid, 'alice');
  assert.equal(source.sends.length, 2);
});

test('a friends query the server is slow to answer never holds Home back', async () => {
  const source = page({ silent: true });
  const bridge = new ShowdownBridge(() => source.contents);
  const started = Date.now();
  const first = await bridge.snapshot();
  assert.ok(Date.now() - started < 1000, 'answered within the network budget, not the 4.5 s timeout');
  assert.equal(first.ready, true);
  assert.deepEqual(first.friends, { available: false, items: [], loading: true });
  assert.equal(first.pending, true, 'Home is told to look again soon');
  assert.deepEqual(source.sends, ['/cmd friends']);

  // The answer lands in the background; the next read has it, without asking again.
  source.listeners.get('response:friends')([{ userid: 'alice', name: 'Alice', online: true, status: 'online' }]);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await bridge.snapshot();
  assert.equal(second.friends.items[0].userid, 'alice');
  assert.equal(second.pending, false);
  assert.equal(source.sends.length, 1);

  // Once that goes stale, the old list shows at once while a fresh query runs.
  bridge.friendsCache.get('tester').at = 0;
  const stale = await bridge.snapshot();
  assert.equal(stale.friends.items[0].userid, 'alice', 'last known friends, not a blank panel');
  assert.equal(source.sends.length, 2, 'refreshing in the background');
  source.listeners.get('response:friends')([{ userid: 'bob', name: 'Bob', online: false, status: 'offline' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await bridge.snapshot()).friends.items[0].userid, 'bob');
});

test('a slow ratings fetch shows last known ratings and is shared by overlapping reads', async (t) => {
  let release;
  fetchImpl = () => new Promise((resolve) => { release = () => resolve({ ok: false }); });
  fetchCalls = 0;
  t.after(() => { fetchImpl = quickFetch; });
  const source = page({ response: [] });
  const bridge = new ShowdownBridge(() => source.contents);
  const started = Date.now();
  const [a, b] = await Promise.all([bridge.snapshot(), bridge.snapshot()]);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(a.ratings, {});
  assert.equal(a.pending, true);
  assert.equal(b.pending, true);
  assert.equal(fetchCalls, 1, 'one fetch for both reads');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const after = await bridge.snapshot();
  assert.equal(after.pending, false);
  assert.equal(fetchCalls, 1, 'the finished fetch is cached');
});

test('account switch waits for the previous untagged response before querying', async () => {
  const source = page({ silent: true });
  const bridge = new ShowdownBridge(() => source.contents);
  const first = bridge.snapshot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(source.sends, ['/cmd friends']);
  source.identity.userid = 'other';
  source.identity.name = 'Other';
  const second = bridge.snapshot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.sends.length, 1, 'queries for different users do not overlap');
  source.listeners.get('response:friends')([{ userid: 'alice', name: 'Alice', online: true, status: 'online' }]);
  assert.deepEqual((await first).friends, { available: false, items: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.sends.length, 2);
  source.listeners.get('response:friends')([{ userid: 'bob', name: 'Bob', online: true, status: 'online' }]);
  assert.equal((await second).friends.items[0].userid, 'bob');
});
