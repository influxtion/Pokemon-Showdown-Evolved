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
let starts = 0;
PracticeSession.prototype.installed = () => true;
PracticeSession.prototype.start = async function(options) {
  starts++;
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
  await until(() => !win.webContents.isLoading() && win.webContents.getURL().endsWith('/index.html'), 'initial Home load');
  const run = code => win.webContents.executeJavaScript(code);
  const home = async () => { await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')); await until(() => run("document.getElementById('daily-start').disabled === false"), 'daily ready'); };
  await home();
  await run("document.getElementById('daily-start').click(); 0");
  await until(() => win.webContents.getURL().endsWith('practice-battle.html') && !win.webContents.isLoading(), 'daily battle');
  assert.equal(practice.options.opponent, 'foulplay-casual');
  assert.equal(practice.options.format, 'gen9randombattle');
  assert.equal((await run('window.desktop.getDailyChallenge()')).attemptsLeft, 2);
  practice.battle = { ...practice.battle, finished: true, result: 'loss' }; practice.changed();
  await until(() => run("!document.getElementById('battle-next').hidden"), 'retry');
  assert.equal((await run('window.desktop.nextPracticeBattle()')).ok, false, 'ordinary rematch blocked');
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'practice.html'));
  await until(() => run("!document.getElementById('daily-start').disabled"), 'Bots daily ready');
  assert.equal(await run("Boolean(document.getElementById('daily-record'))"), true);
  await until(() => run("document.querySelector('.bot-daily')?.disabled === false"), 'Casual daily shortcut ready');
  assert.equal(await run("document.querySelectorAll('.bot-daily').length"), 1);
  assert.equal(await run("document.querySelector('.bot-daily').closest('.bot-card').dataset.bot"), 'foulplay-casual');
  assert.equal(await run("document.querySelector('.bot-daily').textContent"), 'Play daily');
  assert.equal(await run("document.querySelector('[data-bot=foulplay-casual] .bot-play').textContent"), 'Play');
  await run("document.querySelector('.bots-format[data-format=gen9ou]').click(); 0");
  await until(() => run("!document.querySelector('.bot-daily')"), 'OU hides the Random Battle-only Casual card');
  await run("document.querySelector('.bots-format[data-format=gen9randombattle]').click(); 0");
  await until(() => run("document.querySelector('.bot-daily')?.disabled === false"), 'rebuilt shortcut shares daily state');
  await run("document.querySelector('.bot-daily').click(); document.getElementById('daily-start').click(); 0");
  await until(() => win.webContents.getURL().endsWith('practice-battle.html') && !win.webContents.isLoading(), 'Bots daily starts battle');
  await until(async () => (await run('window.desktop.getDailyChallenge()')).attemptsLeft === 1, 'second attempt');
  assert.equal(starts, 2, 'the shortcut reserves only one attempt even when both actions are clicked');
  assert.equal(practice.options.opponent, 'foulplay-casual');
  assert.equal(practice.options.format, 'gen9randombattle');
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'practice.html'));
  await until(() => run("document.querySelector('.bot-daily')?.textContent === 'Return to daily'"), 'running daily shortcut');
  await run("document.querySelector('.bot-daily').click(); 0");
  await until(() => win.webContents.getURL().endsWith('practice-battle.html') && !win.webContents.isLoading(), 'shortcut returns to the active daily');
  assert.equal(starts, 2, 'returning does not start another session');
  assert.equal((await run('window.desktop.getDailyChallenge()')).attemptsLeft, 1);
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
        assert.equal(await run("document.querySelector('.daily-compact').getBoundingClientRect().height <= 76"), true, 'compact challenge height');
        fs.writeFileSync(path.join(dir, `${layout}-${width}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  await run("document.querySelector('.daily-details').click(); 0");
  await until(() => win.webContents.getURL().includes('practice.html') && !win.webContents.isLoading(), 'details opens Bots');
  await until(() => run("document.getElementById('daily-record').textContent.includes('Daily clears: 1')"), 'Bots records');
  assert.equal(await run("document.getElementById('daily-start').disabled"), true);
  await until(() => run("document.querySelector('.bot-daily')?.textContent === 'Cleared today' && document.querySelector('.bot-daily').disabled"), 'completed daily shortcut');
  for (const theme of ['light', 'dark']) {
    await run(`window.desktop.setTheme('${theme}'); 0`);
    await pause(200);
    await run("document.getElementById('daily-challenge').scrollIntoView({block:'nearest'}); 0");
    assert.equal(await run("document.documentElement.scrollWidth <= innerWidth"), true, 'Bots no horizontal overflow');
    fs.writeFileSync(path.join(dir, `bots-1024-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    await run("document.querySelector('[data-bot=foulplay-casual]').scrollIntoView({block:'center'}); 0");
    await pause(150);
    assert.equal(await run("(()=>{const c=document.querySelector('[data-bot=foulplay-casual]');return c.scrollWidth <= c.clientWidth && [...c.querySelectorAll('button')].every(b=>b.getBoundingClientRect().right <= c.getBoundingClientRect().right);})()"), true, 'Casual actions fit the card');
    fs.writeFileSync(path.join(dir, `casual-1024-${theme}.png`), (await win.webContents.capturePage()).toPNG());
  }
  console.log('Daily challenge desktop passed: real IPC, pinned Casual, loss/retry/win, rematch guard, flame, both layouts/themes/sizes.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
