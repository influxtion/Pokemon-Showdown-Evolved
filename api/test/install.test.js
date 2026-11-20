'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installOuData, refreshOuData, promoteRuntime, paths, OU_FILES } = require('../install');
const lock = require('../lock.json');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const reply = text => new Response(text, { status: 200, headers: { 'content-length': String(Buffer.byteLength(text)) } });

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ou-data-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('installs the OU files where Foul Play caches them, usage stats without their header', async t => {
  const dir = temp(t);
  const bodies = { usageStats: JSON.stringify({ info: { metagame: 'gen9ou' }, data: { 'Great Tusk': {} } }),
    showdownSets: '{"dex":{}}', fullSets: '{"greattusk":{}}', replayMoves: '{}' };
  const pins = Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, { url: `https://example.test/${name}`, sha256: sha(body) }]));
  const fetcher = async url => reply(bodies[url.split('/').pop()]);
  await installOuData(path.join(dir, 'data'), path.join(dir, 'downloads'), { fetcher, pins });
  const read = name => fs.readFileSync(path.join(dir, 'data', ...OU_FILES[name]), 'utf8');
  assert.deepEqual(JSON.parse(read('usageStats')), { 'Great Tusk': {} });
  assert.equal(read('fullSets'), bodies.fullSets);
  assert.equal(read('replayMoves'), '{}');
});

test('a changed OU file stops setup and names the refresh command', async t => {
  const dir = temp(t);
  const pins = Object.fromEntries(Object.keys(OU_FILES).map(name => [name, { url: `https://example.test/${name}`, sha256: sha('old') }]));
  await assert.rejects(installOuData(path.join(dir, 'data'), path.join(dir, 'downloads'), { fetcher: async () => reply('{}'), pins }),
    /refresh-ou/);
});

test('a download write failure rejects without crashing the app process', t => {
  const dir = temp(t);
  const downloads = path.join(dir, 'downloads');
  fs.mkdirSync(path.join(downloads, 'ou-usageStats.json.partial'), { recursive: true });
  const script = `
    const { installOuData, OU_FILES } = require(${JSON.stringify(require.resolve('../install'))});
    const pins = Object.fromEntries(Object.keys(OU_FILES).map(name => [name, { url: 'https://example.test/' + name, sha256: '0'.repeat(64) }]));
    installOuData(${JSON.stringify(path.join(dir, 'data'))}, ${JSON.stringify(downloads)}, {
      pins, fetcher: async () => new Response('x'.repeat(1024 * 1024))
    }).then(() => { process.exitCode = 2; }, () => console.log('Download failed safely'));
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.match(child.stdout, /Download failed safely/);
});

test('cancelling a stalled download closes the stream and removes partial data', { timeout: 5000 }, async t => {
  const dir = temp(t);
  const downloads = path.join(dir, 'downloads');
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({
    start(stream) { stream.enqueue(Buffer.from('partial')); },
    cancel() { cancelled = true; },
  });
  const pins = { usageStats: { url: 'https://example.test/stats', sha256: sha('{}') } };
  const pending = installOuData(path.join(dir, 'data'), downloads, {
    signal: controller.signal, pins, fetcher: async () => new Response(body),
  });
  const timer = setTimeout(() => controller.abort(), 50);
  t.after(() => clearTimeout(timer));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.equal(fs.existsSync(path.join(downloads, 'ou-usageStats.json.partial')), false);
});

test('a failed runtime replacement restores the previous working install', async t => {
  const where = paths(temp(t));
  for (const [directory, value] of [[where.current, 'old'], [where.staging, 'new']]) {
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'runtime'), value);
  }
  const failure = Object.assign(new Error('Blocked replacement'), { code: 'EPERM' });
  const fileSystem = { ...fs.promises, rename: async (from, to) => {
    if (from === where.staging) throw failure;
    return fs.promises.rename(from, to);
  } };
  await assert.rejects(promoteRuntime(where, fileSystem), failure);
  assert.equal(fs.readFileSync(path.join(where.current, 'runtime'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(where.staging, 'runtime'), 'utf8'), 'new');
  await promoteRuntime(where);
  assert.equal(fs.readFileSync(path.join(where.current, 'runtime'), 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(path.dirname(where.current)), ['current']);
});

test('refresh moves the usage stats to the newest published month and re-pins the sets', async t => {
  const dir = temp(t);
  const lockFile = path.join(dir, 'lock.json');
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  const fetcher = async url => (url.includes('/2026-11/') ? new Response('', { status: 404 }) : reply(`{"u":"${url}"}`));
  const pins = await refreshOuData({ fetcher, now: new Date(Date.UTC(2026, 11, 3)), lockFile });
  assert.equal(pins.usageStats.month, '2026-10');
  assert.equal(pins.usageStats.url, 'https://www.smogon.com/stats/2026-10/chaos/gen9ou-0.json');
  assert.equal(pins.fullSets.sha256, sha(`{"u":"${lock.ouData.fullSets.url}"}`));
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')).ouData, pins);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')).foulPlay, lock.foulPlay);
});
