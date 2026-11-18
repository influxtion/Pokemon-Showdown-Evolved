'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalEngine, CloudEngine } = require('../app/practice-engines');

// A stand-in installer: install() resolves when the test says so, and inspect() reports whatever
// the fake disk holds. Nothing here downloads or runs Foul Play.
function fakeInstaller() {
  const disk = { installed: false, current: true, revision: null };
  let finish = null;
  const calls = { install: 0, remove: 0 };
  return {
    disk,
    calls,
    finish: (error) => finish(error),
    install: ({ signal, onProgress }) => new Promise((resolve, reject) => {
      calls.install++;
      onProgress({ fraction: 0.4, label: 'Compiling the search engine', index: 3, steps: 7, detail: '' });
      signal.addEventListener('abort', () => reject(signal.reason));
      finish = (error) => {
        if (error) return reject(error);
        Object.assign(disk, { installed: true, current: true, revision: 'abcdef1234567' });
        resolve();
      };
    }),
    remove: async () => { calls.remove++; Object.assign(disk, { installed: false, revision: null }); },
    inspect: () => ({ ...disk, python: 'python', source: '/fp', worker: '/w.py' }),
  };
}

// LocalEngine closes any running server before it calls the installer, so the fake starts a
// moment after install(); wait for that before finishing it or reading its progress.
const started = () => new Promise((resolve) => setImmediate(resolve));

function engine(fake, extra = {}) {
  return new LocalEngine({ dir: '/foulplay', worker: '/w.py', install: fake.install, remove: fake.remove, inspect: fake.inspect,
    threads: 4, ...extra });
}

test('nothing is downloaded until the player asks, and target() refuses until then', async () => {
  const fake = fakeInstaller();
  const local = engine(fake);
  assert.equal(fake.calls.install, 0);
  const status = local.status();
  assert.equal(status.installed, false);
  assert.equal(status.installing, false);
  await assert.rejects(local.target(), /not on this computer/);
});

test('install reports progress, then the engine is installed', async () => {
  const fake = fakeInstaller();
  const local = engine(fake);
  const done = local.install();
  assert.equal(local.install(), done, 'a second click joins the running download');
  assert.equal(local.status().installing, true);
  await started();
  assert.equal(local.status().progress.label, 'Compiling the search engine');
  await assert.rejects(local.target(), /still downloading/);
  fake.finish();
  assert.deepEqual(await done, { ok: true });
  const status = local.status();
  assert.equal(status.installed, true);
  assert.equal(status.installing, false);
  assert.equal(status.revision, 'abcdef1');
  assert.equal(status.threads, 4);
});

test('cancel stops the download without an error, and a failure is reported', async () => {
  const fake = fakeInstaller();
  const local = engine(fake);
  const cancelled = local.install();
  await started();
  local.cancel();
  assert.deepEqual(await cancelled, { ok: false, cancelled: true });
  assert.equal(local.status().error, '');
  const failed = local.install();
  await started();
  fake.finish(new Error('Download failed (404): example.org'));
  assert.deepEqual(await failed, { ok: false, error: 'Download failed (404): example.org' });
  assert.equal(local.status().error, 'Download failed (404): example.org');
  assert.equal(local.status().installed, false);
});

test('target() starts one private loopback server with a key, and remove() closes it', async () => {
  const fake = fakeInstaller();
  fake.disk.installed = true;
  const servers = [];
  const createServer = (options) => {
    const api = { options, closed: false, listen: async (port, host) => `http://${host}:4321`, close: async () => { api.closed = true; } };
    servers.push(api);
    return api;
  };
  const local = engine(fake, { createServer });
  const first = await local.target();
  const second = await local.target();
  assert.equal(servers.length, 1);
  assert.deepEqual(first, second);
  assert.equal(first.url, 'http://127.0.0.1:4321');
  assert.match(first.key, /^[a-f0-9]{64}$/);
  assert.equal(servers[0].options.apiKey, first.key);
  assert.equal(servers[0].options.lowPriority, true);
  assert.equal(servers[0].options.maxThreads, 4);
  assert.deepEqual(await local.remove(), { ok: true });
  assert.equal(servers[0].closed, true);
  assert.equal(fake.calls.remove, 1);
  assert.equal(local.status().installed, false);
});

test('remove waits for a running download', async () => {
  const fake = fakeInstaller();
  const local = engine(fake);
  const done = local.install();
  assert.match((await local.remove()).error, /Wait for the download/);
  await started();
  fake.finish();
  await done;
});

test('the cloud engine stays the default target and needs no download', async () => {
  const cloud = new CloudEngine({ url: 'https://example.org', Client: class { async info() { return { bots: [] }; } } });
  assert.deepEqual(await cloud.target(), { url: 'https://example.org', key: null });
});
