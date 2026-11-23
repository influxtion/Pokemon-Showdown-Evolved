'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { BattleReviewInput, MAX_FILE_BYTES, MAX_LINES, MAX_LINE_LENGTH, extractProtocol, replayLogUrl,
  fetchReplay, MESSAGES } = require('../app/battle-review-input');

const PRIVATE = 'https://replay.pokemonshowdown.com/gen9ou-1289-privatesecretpw';
const INPUT = [
  '|player|p1|Player|432|1600', '|player|p2|Opponent|413|1550', '|gen|9', '|gametype|singles', '|tier|[Gen 9] OU',
  '|teamsize|p1|1', '|teamsize|p2|1', '|start',
  '|switch|p1a: Pikachu|Pikachu|211/211', '|switch|p2a: Magikarp|Magikarp|100/100',
  '|turn|1', '|request|{"side":"secret"}', '|c|Player|private chat',
  '|move|p1a: Pikachu|Thunderbolt|p2a: Magikarp', '|-damage|p2a: Magikarp|0 fnt',
  '|faint|p2a: Magikarp', '|win|Player',
].join('\n');
const SOURCE = { kind: 'online', roomId: 'battle-gen9ou-123' };

test('official public, private and tournament replay links map only to their credential-free log URL', () => {
  assert.equal(replayLogUrl(PRIVATE), PRIVATE + '.log');
  assert.equal(replayLogUrl(' http://replay.pokemonshowdown.com/smogtours-gen9ou-123/ '),
    'https://replay.pokemonshowdown.com/smogtours-gen9ou-123.log');
  assert.equal(replayLogUrl(PRIVATE + '.json'), PRIVATE + '.log');
  for (const query of ['?p2', '?p2=1&turn=17', '?t=2']) assert.equal(replayLogUrl(PRIVATE + query), PRIVATE + '.log');
  for (const value of [null, '/gen9ou-12', 'file:///replay.log', PRIVATE + '?p2=1&p2=1', PRIVATE + '?t=10001',
    PRIVATE + '?manage', PRIVATE + '#secret', PRIVATE + '.inputlog',
    PRIVATE.replace('com/', 'com:443/'), PRIVATE.replace('com/', 'com@localhost/'),
    PRIVATE.replace('com/', 'com.evil.test/'), PRIVATE.replace('com/', 'com/../'), PRIVATE.replace('com/', 'com/%2e%2e/'),
    PRIVATE.replace('com/', 'com\\'), PRIVATE + '\n/other']) assert.equal(replayLogUrl(value), null);
});

test('upstream HTML and JSON are parsed as data and only the public battle transcript survives', () => {
  const result = extractProtocol(INPUT, 'log');
  assert.match(result, /\|player\|p1\|Player\n/);
  assert.match(result, /\|switch\|p1a: Pikachu\|Pikachu\|100\/100/);
  assert.doesNotMatch(result, /432|1600|211\/211|chat|request|secret/);
  const markup = '<script>throw "executed"</script><script type="text/plain" class="battle-log-data">' +
    INPUT.replace(/\//g, '\\/') + '</script><script src="https://example.com/other"></script>';
  assert.equal(extractProtocol(markup, 'html'), result);
  for (const log of [INPUT, INPUT.split('\n')]) {
    assert.equal(extractProtocol(JSON.stringify({ inputlog: 'packed secret team', log }), 'json'), result);
  }
  const split = '|split|p1\n|-damage|p1a: Pikachu|207/211\n|-damage|p1a: Pikachu|99/100';
  assert.match(extractProtocol(INPUT.replace('|turn|1', '|turn|1\n' + split), 'log'), /99\/100/);
  assert.doesNotMatch(extractProtocol(INPUT.replace('|turn|1', '|turn|1\n' + split), 'log'), /207\/211/);
  assert.throws(() => extractProtocol(INPUT + '\n'.repeat(MAX_LINES), 'log'), { code: 'review-limit' });
  assert.throws(() => extractProtocol('|player|p1|' + 'p'.repeat(MAX_LINE_LENGTH) + '\n|tie', 'log'), { code: 'review-limit' });
  assert.throws(() => extractProtocol('|start\n|turn|1\n|c|Someone||win|Player', 'log'), { code: 'incomplete-replay' });
  assert.throws(() => extractProtocol('{"inputlog":"|tie"}', 'json'), { code: 'invalid-replay' });
  assert.throws(() => extractProtocol('<html><img src="https://example.com">|tie</html>', 'html'), { code: 'invalid-replay' });
  assert.throws(() => extractProtocol('|gen|9\n|split|p1\n|win|Private', 'log'), { code: 'invalid-replay' });
});

test('a replay fetch omits credentials, refuses redirects and limits the streamed bytes', async () => {
  const signal = new AbortController().signal;
  assert.equal(await fetchReplay(PRIVATE, signal, async (url, options) => {
    assert.equal(url, PRIVATE + '.log');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.cache, 'no-store');
    return new Response(INPUT);
  }), INPUT);
  for (const response of [new Response('', { status: 302 }), new Response('', { status: 404 })]) {
    await assert.rejects(fetchReplay(PRIVATE, signal, async () => response), { code: 'review-fetch' });
  }
  await assert.rejects(fetchReplay(PRIVATE, signal, async () => new Response('small', {
    headers: { 'content-length': String(MAX_FILE_BYTES + 1) },
  })), { code: 'review-limit' });
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(65536)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(fetchReplay(PRIVATE, signal, async () => new Response(stream)), { code: 'review-limit' });
  assert.equal(cancelled, true);
  await assert.rejects(fetchReplay(PRIVATE, signal, async () => { throw new Error(PRIVATE); }),
    { message: MESSAGES['review-fetch'] });
});

test('native selection returns only a name and token; files are opened on review and grants expire on navigation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-review-input-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'download.html');
  let analyses = 0;
  const service = new BattleReviewInput({ analyze: async (text, type) => {
    analyses++;
    assert.equal(type, 'html');
    assert.equal(text, 'chosen after the dialog');
    return { format: 'Gen 9 OU' };
  } });
  assert.equal(service.status().report, null);
  // The file does not exist yet. Merely choosing it must still succeed.
  const choice = await service.choose(async () => file);
  assert.deepEqual(Object.keys(choice).sort(), ['name', 'ok', 'token']);
  assert.equal(choice.name, 'download.html');
  assert.equal(analyses, 0);
  assert.equal((await service.review({ kind: 'file', token: file })).ok, false);
  await fs.writeFile(file, 'chosen after the dialog');
  assert.deepEqual(await service.review({ kind: 'file', token: choice.token }), { ok: true });
  await fs.truncate(file, MAX_FILE_BYTES + 1);
  assert.deepEqual(await service.review({ kind: 'file', token: choice.token }), { ok: false, error: MESSAGES['review-limit'] });
  service.leave();
  assert.equal((await service.review({ kind: 'file', token: choice.token })).ok, false);
  assert.equal(analyses, 1);
  assert.deepEqual(service.status(), { ok: true, report: { format: 'Gen 9 OU' }, side: 'p1', noteId: null });
  let picked;
  const pending = service.choose(() => new Promise(resolve => { picked = resolve; }));
  assert.equal((await service.choose(async () => file)).ok, false);
  service.leave();
  picked(file);
  assert.deepEqual(await pending, { ok: true, cancelled: true });
});

test('cancel, navigation, replacement, and timeout cannot publish stale reports or leak private errors', async () => {
  let read = Promise.resolve({ log: INPUT, side: 'p2' });
  let runs = 0, fetches = 0;
  const service = new BattleReviewInput({ getNoteUrl: () => PRIVATE, capture: () => read, timeoutMs: 100,
    fetchImpl: async () => { fetches++; throw new Error(PRIVATE); },
    analyze: async () => ({ run: ++runs }) });
  assert.equal(fetches, 0);
  assert.deepEqual(await service.review(SOURCE), { ok: true });
  assert.deepEqual(service.status(), { ok: true, report: { run: 1 }, side: 'p2', noteId: null });
  assert.deepEqual(await service.review({ kind: 'note', id: '11111111-1111-1111-1111-111111111111' }),
    { ok: false, error: MESSAGES['review-fetch'] });
  let release;
  read = new Promise(resolve => { release = resolve; });
  const stale = service.review(SOURCE);
  read = Promise.resolve({ log: INPUT, side: 'p1' });
  assert.deepEqual(await service.review(SOURCE), { ok: true });
  assert.deepEqual(await stale, { ok: true, cancelled: true });
  release({ log: INPUT, side: 'p2' });
  read = new Promise(() => {});
  const navigating = service.review(SOURCE);
  service.leave();
  assert.deepEqual(await navigating, { ok: true, cancelled: true });
  // Node unrefs AbortSignal.timeout timers. Keep this test alive through its small deadline.
  const [timedOut] = await Promise.all([service.review(SOURCE), delay(110)]);
  assert.deepEqual(timedOut, { ok: false, error: MESSAGES['review-timeout'] });
  assert.deepEqual(service.status(), { ok: true, report: { run: 2 }, side: 'p1', noteId: null });
  service.clear();
  assert.deepEqual(service.status(), { ok: true, report: null, side: 'p1', noteId: null });
});

test('only the last successful saved-note review has a playback link while its note still exists', async () => {
  const id = '11111111-1111-1111-1111-111111111111';
  let exists = true;
  const service = new BattleReviewInput({ getNoteUrl: key => exists && key === id ? PRIVATE : null,
    fetchImpl: async () => new Response(INPUT), analyze: async () => ({ format: 'Gen 9 OU' }) });
  const note = { kind: 'note', id };
  assert.deepEqual(await service.review(note), { ok: true });
  assert.deepEqual(service.status(), { ok: true, noteId: id, side: 'p1', report: { format: 'Gen 9 OU' } });
  assert.equal((await service.review({ kind: 'url', url: 'https://example.com/game' })).ok, false);
  assert.equal(service.status().noteId, id);
  exists = false;
  assert.equal(service.status().noteId, null);
  exists = true;
  assert.deepEqual(await service.review({ kind: 'url', url: PRIVATE }), { ok: true });
  assert.equal(service.status().noteId, null);
  assert.deepEqual(await service.review(note), { ok: true });
  service.clear();
  assert.equal(service.status().noteId, null);
});

test('a real worker returns a report and keeps the finished player perspective', async () => {
  const service = new BattleReviewInput({ capture: async () => ({ log: INPUT, side: 'p2' }) });
  assert.deepEqual(await service.review(SOURCE), { ok: true });
  const { report, side } = service.status();
  assert.equal(side, 'p2');
  assert.equal(report.turnCount, 1);
  assert.equal(report.players.p1, 'Player');
  assert.doesNotMatch(JSON.stringify(report), /request|\|switch\||private chat|privatesecretpw/);
});
