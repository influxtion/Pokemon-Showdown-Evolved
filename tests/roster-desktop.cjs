'use strict';
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-roster-')));
const { CloudEngine } = require('../app/practice-engines');
const { PracticeSession } = require('../app/practice-session');
let metamonAvailable = false;
const calls = [];
CloudEngine.prototype.status = () => ({ configured: true, checked: true, online: true, available: true,
  bots: [{ id: 'foulplay', formats: ['gen9randombattle', 'gen9ou'], available: true },
    ...['foulplay-medium', 'foulplay-casual'].map(id => ({ id, formats: ['gen9randombattle'], available: true })),
    { id: 'metamon', formats: ['gen9ou'], available: metamonAvailable }] });
PracticeSession.prototype.start = async function(options) { calls.push(options); return { ok: false, error: 'Test start recorded' }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
app.whenReady().then(async () => {
  for (const s of [session.defaultSession, session.fromPartition('persist:showdown')]) s.webRequest.onBeforeRequest((d, cb) => cb({ cancel: /^https?:/.test(d.url) }));
  require('../app/main');
  await until(() => BrowserWindow.getAllWindows().length, 'window');
  const win = BrowserWindow.getAllWindows()[0];
  await until(() => !win.webContents.isLoading(), 'initial page');
  await win.loadFile(path.join(__dirname, '../renderer/practice.html'));
  const run = code => win.webContents.executeJavaScript(code);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click(); 0`);
  await until(() => run("document.querySelectorAll('.bot-card').length === 6"), 'random roster');
  await click('[data-format=gen9ou]');
  await until(() => run("document.querySelectorAll('.bot-card').length === 4"), 'OU roster');
  for (const id of ['foulplay', 'foulplay-casual', 'foulplay-medium', 'metamon']) assert.equal(await run(`Boolean(document.querySelector('[data-bot=${id}]'))`), true);
  assert.equal(await run("document.querySelector('[data-bot=metamon] .bot-play').disabled"), true);
  assert.equal(await run("Boolean(document.getElementById('metamon-download'))"), false, 'no local model download');
  const team = fs.readFileSync(path.join(__dirname, 'fixtures/ou-team.txt'), 'utf8');
  for (const side of ['player', 'bot']) {
    await click(`[data-side=${side}] [data-source=paste]`);
    await run(`{const el=document.querySelector('[data-side=${side}] textarea'); el.value=${JSON.stringify(team)}; el.dispatchEvent(new Event('input'));} 0`);
  }
  await until(() => run("[...document.querySelectorAll('.team-slot-note')].every(el=>el.textContent.includes('Legal for OU'))"), 'OU validation');
  assert.equal(await run("document.querySelector('[data-bot=foulplay-medium] .bot-play').disabled"), true, 'old host cannot play Medium OU');
  assert.equal(await run("document.querySelector('[data-bot=foulplay] .bot-play').disabled"), false);
  metamonAvailable = true;
  await until(() => run("!document.querySelector('[data-bot=metamon] .bot-play').disabled"), 'Metamon cloud ready');
  await click('[data-bot=metamon] .bot-play');
  await until(() => calls.length === 1, 'Metamon start');
  assert.equal(calls[0].opponent, 'metamon'); assert.equal(calls[0].format, 'gen9ou');
  await click('[data-format=gen9anythinggoes]');
  await until(() => run("document.querySelectorAll('.bot-card').length === 3"), 'AG roster');
  await until(() => run("[...document.querySelectorAll('.team-slot-note')].every(el=>el.textContent.includes('Legal for Anything Goes'))"), 'AG revalidation');
  assert.equal(await run("[...document.querySelectorAll('.bot-play')].every(el=>el.disabled)"), true, 'AG requires updated host');
  const dir = path.join(__dirname, '../out/roster-desktop'); fs.mkdirSync(dir, { recursive: true });
  win.show();
  for (const [width, height] of [[1366,768],[1024,640]]) {
    win.setSize(width,height);
    for (const theme of ['light','dark']) {
      await run(`window.desktop.setTheme('${theme}')`);
      for (const format of ['gen9ou','gen9anythinggoes']) {
        await click(`[data-format=${format}]`);
        await pause(1200);
        await run("document.querySelector('.bots-head').scrollIntoView(); 0");
        assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, 'no overflow');
        fs.writeFileSync(path.join(dir, `${format}-${width}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
        await run("document.getElementById('practice-bots').scrollIntoView(); 0");
        await pause(150);
        fs.writeFileSync(path.join(dir, `${format}-cards-${width}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  console.log('Roster desktop passed: OU/AG tabs, validation on format change, old-host gating, cloud-only Metamon, both themes/sizes.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
