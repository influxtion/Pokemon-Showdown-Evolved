'use strict';
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-daily-desktop-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeLayout: 'classic' }));
const { PracticeSession } = require('../app/practice-session');
let practice;
PracticeSession.prototype.installed = () => true;
PracticeSession.prototype.start = async function(options) {
  practice = this;
  this.options = options;
  this.state = 'ready';
  this.battle = { room: 'battle-gen9randombattle-1', turn: 1, finished: false };
  this.changed();
  return { ok: true };
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, name) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(100); }
  throw new Error(`Timed out: ${name}`);
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  session.fromPartition('persist:showdown').webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  require('../app/main');
  await until(() => BrowserWindow.getAllWindows().length, 'window');
  const win = BrowserWindow.getAllWindows()[0];
  const run = code => win.webContents.executeJavaScript(code);
  const home = async () => { await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')); await until(() => run("document.getElementById('daily-start').disabled === false"), 'daily ready'); };
  await home();
  await run("document.getElementById('daily-start').click(); 0");
  await until(() => win.webContents.getURL().endsWith('practice-battle.html') && !win.webContents.isLoading(), 'daily battle');
  assert.equal(practice.options.opponent, 'foulplay-medium');
  assert.equal(practice.options.format, 'gen9randombattle');
  assert.equal((await run('window.desktop.getDailyChallenge()')).attemptsLeft, 2);
  practice.battle = { ...practice.battle, finished: true, result: 'loss' }; practice.changed();
  await until(() => run("!document.getElementById('battle-next').hidden"), 'retry');
  assert.equal((await run('window.desktop.nextPracticeBattle()')).ok, false, 'ordinary rematch blocked');
  await run("document.getElementById('battle-next').click(); 0");
  await until(async () => (await run('window.desktop.getDailyChallenge()')).attemptsLeft === 1, 'second attempt');
  practice.battle = { ...practice.battle, finished: true, result: 'win' }; practice.changed();
  await until(async () => (await run('window.desktop.getDailyChallenge()')).cleared, 'daily cleared');
  await until(() => run("document.getElementById('battle-next').hidden"), 'no retry after win');
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await until(() => run("document.getElementById('daily-streak').classList.contains('is-lit')"), 'lit flame');
  assert.equal(await run("document.getElementById('daily-streak-text').textContent"), '1-day streak');
  assert.equal((await run('window.desktop.startDailyChallenge()')).ok, false);
  const dir = path.join(__dirname, '..', 'out', 'daily-challenge'); fs.mkdirSync(dir, { recursive: true });
  win.show();
  for (const layout of ['classic', 'modern']) {
    for (const [width, height] of [[1366, 768], [1024, 640]]) {
      win.setSize(width, height);
      for (const theme of ['light', 'dark']) {
        await run(`window.desktop.setTheme('${theme}'); document.getElementById('hub').className = 'hub hub--${layout}'; 0`);
        await pause(200);
        await run("document.querySelector('.daily-challenge').scrollIntoView({block:'nearest'}); 0");
        assert.equal(await run("document.documentElement.scrollWidth <= innerWidth && document.getElementById('hub').scrollWidth <= document.getElementById('hub').clientWidth"), true, 'no horizontal overflow');
        fs.writeFileSync(path.join(dir, `${layout}-${width}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  console.log('Daily challenge desktop passed: real IPC, pinned Medium, loss/retry/win, rematch guard, flame, both layouts/themes/sizes.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
