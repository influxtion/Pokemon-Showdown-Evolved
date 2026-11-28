'use strict';
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-stats-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeLayout: 'classic', theme: 'light', showdexPrompted: true }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 100; i++) { try { if (await check()) return; } catch {} await pause(80); }
  throw new Error('Timed out: ' + label);
}
app.whenReady().then(async () => {
  session.fromPartition('persist:showdown').protocol.handle('https', () => new Response('<!doctype html><body>Isolated Stats test</body>', { headers: { 'content-type': 'text/html' } }));
  require('../app/main');
  await until(() => BrowserWindow.getAllWindows().length, 'window');
  const win = BrowserWindow.getAllWindows()[0], renderer = win.webContents;
  const run = code => renderer.executeJavaScript(code);
  await until(() => !renderer.isLoading(), 'renderer');
  const errors = [];
  renderer.on('console-message', event => { if (event.level === 'error' && !/ERR_|Failed to load resource/.test(event.message)) errors.push(event.message); });
  let state = {
    ready: true, connected: true, user: { name: 'Stats Tester', userid: 'statstester', registered: true },
    formats: [
      { id: 'gen9ou', name: '[Gen 9] OU' }, { id: 'gen9randombattle', name: '[Gen 9] Random Battle' },
      { id: 'gen9uu', name: '[Gen 9] UU' }, { id: 'gen9ru', name: '[Gen 9] RU' },
    ],
    stats: {
      gen9ou: { elo: 1540, gxe: 68, wins: 30, losses: 15 },
      gen9randombattle: { elo: 1720, gxe: 74.3, wins: 100, losses: 60 },
      gen9uu: { elo: 1230, gxe: 52, wins: 8, losses: 12 },
      gen9ru: { elo: 1000, gxe: null, wins: 0, losses: 0 },
      gen8ou: { elo: 1410, gxe: 60, wins: 60, losses: 20 },
    },
    counts: {}, teams: [], news: [], rooms: [], ratings: {}, friends: { available: true, items: [] },
  };
  ipcMain.removeHandler('showdown:session');
  ipcMain.handle('showdown:session', () => ({ ready: true, connected: true, me: 'Stats Tester', named: true, rooms: [], search: { pending: false, formats: [] }, popups: 0 }));
  ipcMain.removeHandler('showdown:snapshot');
  ipcMain.handle('showdown:snapshot', () => state);
  const load = async () => {
    await win.loadFile(path.join(__dirname, '../renderer/stats.html'));
    await run('window.HomeAppearance.ready.then(()=>true)');
  };
  const names = () => run('[...document.querySelectorAll(".ladder-format")].map(n=>n.textContent)');
  const sort = async value => run(`(()=>{const select=document.getElementById('stats-sort');select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change'));})()`);
  await load();
  await until(() => run('document.querySelectorAll(".ladder-format").length===5'), 'stats');
  assert.deepEqual(await names(), ['[Gen 9] Random Battle', '[Gen 8] ou', '[Gen 9] OU', '[Gen 9] UU', '[Gen 9] RU'], 'unknown recency falls back to games');
  await run(`localStorage.setItem('stats.activity.statstester',JSON.stringify({
    gen9ou:{battle:100,at:Date.now()-86400000},gen9uu:{battle:200,at:Date.now()-10000}
  }));document.dispatchEvent(new CustomEvent('showdown-session'));`);
  assert.deepEqual((await names()).slice(0, 2), ['[Gen 9] UU', '[Gen 9] OU'], 'recent first');
  for (const [value, expected] of [
    ['recent:1', '[Gen 9] OU'], ['games:-1', '[Gen 9] Random Battle'], ['games:1', '[Gen 9] RU'],
    ['wins:-1', '[Gen 9] Random Battle'], ['wins:1', '[Gen 9] RU'],
    ['losses:-1', '[Gen 9] Random Battle'], ['losses:1', '[Gen 9] RU'],
    ['elo:-1', '[Gen 9] Random Battle'], ['elo:1', '[Gen 9] RU'],
    ['gxe:-1', '[Gen 9] Random Battle'], ['gxe:1', '[Gen 9] UU'],
    ['name:1', '[Gen 8] ou'], ['name:-1', '[Gen 9] UU'],
  ]) {
    await sort(value);
    assert.equal((await names())[0], expected, value);
    if (value.startsWith('recent:')) assert.equal((await names()).at(-1), '[Gen 9] RU', 'unknown dates remain last');
  }
  await sort('wins:-1');
  await run('document.querySelector("[data-sort=wins]").click()');
  assert.equal(await run('document.getElementById("stats-sort").value'), 'wins:1');
  assert.equal(await run('document.activeElement.dataset.sort'), 'wins', 'header retains keyboard focus');
  await run(`document.getElementById('stats-filter').value='random';document.getElementById('stats-filter').dispatchEvent(new Event('input'));`);
  assert.deepEqual(await names(), ['[Gen 9] Random Battle']);
  await run(`document.getElementById('stats-filter').value='unmatched';document.getElementById('stats-filter').dispatchEvent(new Event('input'));`);
  assert.match(await run('document.getElementById("stats-body").textContent'), /No formats match/);
  await load();
  await until(() => run('document.querySelectorAll(".ladder-format").length===5'), 'reload');
  assert.equal((await names())[0], '[Gen 9] UU', 'reload defaults to recent and retains activity');
  assert.equal(await run('document.querySelector(".stats-page").textContent.includes("Win rate")'), false);
  assert.equal(await run('document.querySelectorAll(".record-bar").length'), 0);
  assert.equal(await run('document.querySelectorAll("[data-play]").length'), 4, 'retired format has no Play');
  const output = path.join(__dirname, '../out/stats-page'); fs.mkdirSync(output, { recursive: true });
  win.showInactive();
  for (const theme of ['light', 'dark']) {
    await run(`window.desktop.setTheme(${JSON.stringify(theme)})`);
    await load();
    await until(() => run('document.querySelectorAll(".ladder-format").length===5'), 'themed stats');
    for (const [width, height] of [[1600, 900], [1366, 768], [1024, 640]]) {
      win.setSize(width, height);
      await pause(250);
      const geometry = await run(`(() => {
        const areas=[document.documentElement,...document.querySelectorAll('.stats-page,#stats-body,.stats-toolbar')];
        return {overflow:areas.filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>n.id||n.className||n.tagName),
          header:document.getElementById('stats-head').getBoundingClientRect().height,
          clipped:[...document.querySelectorAll('.ladder-sort,.col-play')].filter(n=>n.scrollWidth>n.clientWidth).map(n=>n.textContent)};
      })()`);
      assert.deepEqual(geometry.overflow, [], theme + width);
      assert.deepEqual(geometry.clipped, [], theme + width + ' headings');
      assert.ok(geometry.header < 140, 'compact summary');
      fs.writeFileSync(path.join(output, `stats-${width}-${theme}.png`), (await renderer.capturePage()).toPNG());
    }
  }
  await run('document.querySelector("[data-play=gen9uu]").click()');
  await until(() => /index\.html$/.test(renderer.getURL()), 'Play opens Home');
  assert.equal(await run('localStorage.getItem("hub.format")'), 'gen9uu');
  state = { ...state, user: { name: 'Alt', userid: 'alt', registered: true } };
  await load();
  await until(() => run('document.querySelectorAll(".ladder-format").length===5'), 'other account');
  assert.equal((await names())[0], '[Gen 9] Random Battle', 'other account has no activity');
  for (const [patch, text] of [
    [{ ready: false }, 'Connecting'],
    [{ ready: true, user: { registered: false } }, 'Sign in'],
    [{ user: { name: 'Alt', userid: 'alt', registered: true }, stats: {}, pending: true }, 'Loading your ladder record'],
    [{ pending: false }, 'No ladder battles yet'],
  ]) {
    state = { ...state, ...patch };
    await load();
    await until(() => run(`document.getElementById('stats-body').textContent.includes(${JSON.stringify(text)})`), text);
    assert.equal(await run('document.getElementById("stats-sort").disabled'), true);
  }
  assert.deepEqual(errors, []);
  console.log('PASS Stats: all sorts, missing dates/GXE, filters, account isolation, reload, keyboard focus, Play, empty states, light/dark at three sizes.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
