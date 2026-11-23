'use strict';

// Real IPC, worker and views in an isolated Electron profile. Battle events from the public
// gen9randombattle-2718460432 replay, with player names replaced and chat/ratings removed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const { BattleReviewInput } = require('../app/battle-review-input');
const root = path.join(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-battle-review-'));
const log = fs.readFileSync(path.join(__dirname, 'fixtures', 'battle-review.log.txt'), 'utf8').replace(/\r\n/g, '\n').trim();
const privateUrl = 'https://replay.pokemonshowdown.com/gen9randombattle-42-privatepw';
const room = 'battle-gen9randombattle-42';
const captures = path.join(root, 'out', 'battle-review');
app.setPath('userData', profile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, title) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(65);
  }
  throw new Error('Timed out waiting for ' + title);
}

app.whenReady().then(async () => {
  const playerSession = session.fromPartition('persist:showdown');
  playerSession.protocol.handle('https', () => new Response('<!doctype html><title>Offline client</title>', {
    headers: { 'content-type': 'text/html' },
  }));
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: /^https?:/.test(request.url) }));
  let runs = 0;
  const review = BattleReviewInput.prototype.review;
  BattleReviewInput.prototype.review = function (source) { runs++; return review.call(this, source); };
  const requests = [];
  let waitForCancel = false;
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (!url.startsWith('https://replay.pokemonshowdown.com/')) throw new Error('Offline fixture');
    requests.push(url);
    if (waitForCancel) return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    return new Response(log);
  };
  const downloaded = path.join(profile, 'Saved battle.html');
  fs.writeFileSync(downloaded, '<!doctype html><script>throw new Error("HTML must stay inert")</script>' +
    '<script type="text/plain" class="battle-log-data">' + log.replaceAll('/', '\\/') + '</script>');
  let cancelPicker = true;
  dialog.showOpenDialog = async () => ({ canceled: cancelPicker, filePaths: cancelPicker ? [] : [downloaded] });
  require('../app/main');
  await until(() => BrowserWindow.getAllWindows().length > 0, 'window');
  const win = BrowserWindow.getAllWindows()[0];
  const contents = win.webContents;
  await until(() => !contents.isLoading() && contents.getURL().endsWith('/index.html'), 'Home');
  const client = win.contentView.children[0];
  const clientId = client.webContents.id;
  let state = { ready: true, connected: true, me: 'Rowan', current: '', rooms: [], search: { pending: false, formats: [] }, popups: 0 };
  ipcMain.removeHandler('showdown:session');
  ipcMain.handle('showdown:session', () => state);
  const run = code => contents.executeJavaScript(code);
  const call = (fn, ...args) => run('window.desktop[' + JSON.stringify(fn) + '](...' + JSON.stringify(args) + ')');
  const load = (name, query) => win.loadFile(path.join(root, 'renderer', name), { query });
  const click = id => run('document.getElementById(' + JSON.stringify(id) + ').click()');
  const change = (id, value) => run('(() => { const el = document.getElementById(' + JSON.stringify(id) +
    '); el.value = ' + JSON.stringify(value) + '; el.dispatchEvent(new Event("change", { bubbles: true })); })()');
  const visible = id => run('Boolean(document.getElementById(' + JSON.stringify(id) + ')?.getClientRects().length)');
  const showingReport = () => contents.getURL().includes('battle-review.html') && visible('report');
  async function capture(name, rect) {
    for (let i = 0; i < 4; i++) {
      try {
        const image = await contents.capturePage(rect);
        assert.equal(image.isEmpty(), false);
        fs.writeFileSync(path.join(captures, name + '.png'), image.toPNG());
        return;
      } catch (error) {
        if (i === 3 || !/UnknownVizError|Current display surface/.test(error.message)) throw error;
        await pause(250);
      }
    }
  }
  const assertReport = async () => {
    await until(showingReport, 'review report');
    const result = await call('getBattleReview');
    assert.deepEqual(result.report.players, { p1: 'Sage', p2: 'Rowan' });
    assert.equal(result.report.turnCount, 14);
    return result;
  };
  assert.equal((await call('reviewBattle', { kind: 'url', url: privateUrl })).ok, false, 'wrong source page');
  assert.equal((await call('getBattleReview')).ok, false);
  const saved = await call('saveReplayNote', { title: 'Public battle clip', format: 'gen9randombattle', notes: 'Saved note', url: privateUrl });
  assert.equal(saved.ok, true, saved.error);
  await load('replays.html');
  await until(() => run("!document.getElementById('analyse-note').disabled"), 'saved note');
  await run("const draft = document.getElementById('note-body');draft.value = 'In-progress note';draft.dispatchEvent(new Event('input', {bubbles:true}))");
  await click('import-battle-review');
  await until(() => visible('source-panel'), 'import form');
  assert.equal(runs, 0, 'opening the importer starts no review');
  assert.deepEqual(requests, []);
  assert.equal((await call('getBattleReview')).report, null);
  await run("document.querySelector('input[value=file]').click()");
  await click('choose-file');
  assert.equal(await run("document.getElementById('file-name').textContent"), 'No file selected');
  cancelPicker = false;
  await click('choose-file');
  await until(() => run("document.getElementById('file-name').textContent === 'Saved battle.html'"), 'native selected filename');
  assert.equal(runs, 0, 'choosing a file reads no battle');
  await click('run-review');
  const initial = await assertReport();
  assert.equal(initial.side, 'p1');
  assert.equal(await visible('watch-review-source'), false);
  assert.equal(runs, 1);
  assert.deepEqual(requests, []);
  await change('perspective', 'p2');
  assert.ok(await run("document.getElementById('game-summary').textContent.length > 20"));
  await change('turn-filter', 'rated');
  assert.ok(await run("document.querySelectorAll('.analysis-turn').length > 0"));
  await change('turn-filter', 'luck');
  assert.ok(await run("document.getElementById('turn-detail').textContent.length > 0"));
  await change('perspective', 'p1');
  await run("document.querySelector('.analysis-moment').click()");
  assert.ok(await run("document.getElementById('turn-detail').textContent.includes('Before the choice')"));
  assert.equal(runs, 1, 'perspective, filters and key moments never rerun analysis');
  fs.mkdirSync(captures, { recursive: true });
  win.showInactive();
  for (const [width, height] of [[1366, 768], [1024, 640]]) {
    win.setSize(width, height);
    for (const theme of ['light', 'dark']) {
      await call('setTheme', theme);
      await run("document.querySelector('.content').scrollTo(0, 0)");
      await pause(370);
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth && document.querySelector(".content").scrollWidth <= document.querySelector(".content").clientWidth'), true);
      assert.ok(await run("document.getElementById('turn-detail').getBoundingClientRect().width > 300"));
      await capture('review-' + width + '-' + theme);
    }
  }
  await load('replays.html');
  await until(() => run("document.getElementById('note-body').value === 'In-progress note'"), 'note draft restored');
  await click('analyse-note');
  await assertReport();
  assert.equal(await run("document.getElementById('watch-review-source').getAttribute('href')"), 'replays.html?review=' + saved.note.id);
  assert.equal(requests.at(-1), privateUrl + '.log');
  await click('review-another');
  await change('review-url', 'https://invalid.example/replay');
  await click('run-review');
  await until(() => run("document.getElementById('analysis-status').textContent.includes('Enter a replay link')"), 'invalid URL feedback');
  assert.equal(requests.length, 1);
  await change('review-url', privateUrl);
  waitForCancel = true;
  await click('run-review');
  await until(() => requests.length === 2, 'pending replay request');
  await click('cancel-review');
  await until(() => run("document.getElementById('analysis-status').textContent.includes('cancelled')"), 'cancelled GET');
  assert.equal((await call('getBattleReview')).report.winner, 'Sage', 'prior good report retained');
  await click('run-review');
  await until(() => requests.length === 3, 'second pending request');
  await load('settings.html');
  await pause(150);
  assert.ok(contents.getURL().endsWith('/settings.html'), 'late fetch does not steal navigation');
  waitForCancel = false;
  await load('battle-review.html', { import: '1' });
  await until(() => visible('source-panel'), 'direct URL import');
  await change('review-url', privateUrl);
  await click('run-review');
  await assertReport();
  assert.equal(requests.length, 4);

  // The content is an isolated client fixture at the official origin. No user account or
  // public battle is contacted. Its stepQueue is read by the same bridge as a real battle.
  const battle = { id: room, title: 'Sage vs. Rowan', battle: true, ended: false, players: ['Sage', 'Rowan'], formatId: 'gen9randombattle' };
  const historical = { ...battle, id: room + '1', ended: true };
  state = { ...state, current: historical.id, rooms: [historical] };
  await load('play.html');
  await until(() => visible('result-review'), 'previously finished battle remains reviewable');
  assert.equal(await visible('review-offer'), false, 'opening a historical battle raises no offer');
  state = { ...state, current: room, rooms: [battle] };
  await until(() => !client.webContents.isLoading() && client.webContents.getURL().startsWith('https://play.pokemonshowdown.com/'), 'offline Showdown view');
  await client.webContents.executeJavaScript('window.app = {curRoom:{id:' + JSON.stringify(room) +
    '}, rooms:{}, user:{get(k){return k === "named" ? true : "Rowan"}}};window.app.rooms[app.curRoom.id] = {battle: {ended:false,p1:{name:"Sage"},p2:{name:"Rowan"},stepQueue:' +
    JSON.stringify(log.split('\n')) + '}};0');
  await until(async () => (await visible('save-note')) && !(await visible('result-bar')), 'live room painted');
  assert.equal(await visible('result-review'), false);
  assert.equal((await call('reviewBattle', { kind: 'online', roomId: room })).ok, false, 'live battle refused by main capture');
  state.me = 'Observer';
  battle.ended = true;
  await client.webContents.executeJavaScript('app.rooms[app.curRoom.id].battle.ended = true;0');
  await pause(850);
  assert.equal(await visible('result-review'), false, 'spectator receives no prompt');
  const runsBeforeOffer = runs;
  state.me = 'Rowan';
  await until(() => visible('review-offer'), 'completed own battle offers review');
  assert.equal(runs, runsBeforeOffer, 'displaying the end prompt performs no analysis');
  for (const theme of ['dark', 'light']) {
    await call('setTheme', theme);
    await pause(370);
    const rect = await run("(() => { const r = document.getElementById('review-offer').getBoundingClientRect(); return { x:Math.ceil(r.x), y:Math.ceil(r.y), width:Math.floor(r.width), height:Math.floor(r.height) }; })()");
    await capture('offer-1024-' + theme, rect);
  }
  await click('offer-dismiss');
  await until(() => visible('result-review'), 'dismiss retains review button');
  await load('play.html');
  await until(() => visible('result-review'), 'finished room after navigating back');
  assert.equal(await visible('review-offer'), false, 'offer stays dismissed across polls and navigation');
  assert.equal(runs, runsBeforeOffer, 'dismissing an offer performs no analysis');
  await click('result-review');
  assert.equal((await assertReport()).side, 'p2', 'online review opens on participant side');
  assert.equal(runs, runsBeforeOffer + 1);
  assert.equal(requests.length, 4, 'online review never uploads or looks up a replay');
  assert.equal(client.webContents.id, clientId);
  assert.equal(await run("JSON.parse(sessionStorage.getItem('replayNote.editorDraft')).notes"), 'In-progress note');
  console.log('PASS battle review: explicit starts, file/link/note/own battle, real worker, both sides, filters, errors, cancellation, drafts, both themes and sizes');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
