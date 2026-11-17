'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installOuData, refreshOuData, OU_FILES } = require('../install');
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
