'use strict';
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session, dialog } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-roster-')));
const { CloudEngine, MetamonEngine } = require('../app/practice-engines');
const { PracticeSession } = require('../app/practice-session');
let metamonAvailable = false;
let downloaded = false, downloading = false;
MetamonEngine.prototype.status = () => ({ supported: true, installed: downloaded, current: downloaded, installing: downloading, formats: ['gen9ou'] });
MetamonEngine.prototype.inspect = () => ({ installed: downloaded });
MetamonEngine.prototype.install = async () => { downloading = true; return { ok: true }; };
MetamonEngine.prototype.cancel = () => { downloading = false; return { ok: true }; };
MetamonEngine.prototype.remove = async () => { downloaded = false; return { ok: true }; };
dialog.showMessageBox = async () => ({ response: 1 });
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
  await until(() => run("document.querySelectorAll('#practice-bots .bot-card').length === 6"), 'random roster');
  await click('[data-format=gen9ou]');
  await until(() => run("document.querySelectorAll('#practice-bots .bot-card').length === 4"), 'OU roster');
  for (const id of ['foulplay', 'foulplay-casual', 'foulplay-medium', 'metamon']) assert.equal(await run(`Boolean(document.querySelector('[data-bot=${id}]'))`), true);
  assert.equal(await run("document.querySelector('[data-bot=metamon] .bot-play').disabled"), true);
  assert.equal(await run("document.getElementById('practice-downloads').hidden"), true, 'downloads stay on their own tab');
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
  await until(() => run("document.querySelectorAll('#practice-bots .bot-card').length === 3"), 'AG roster');
  await until(() => run("[...document.querySelectorAll('.team-slot-note')].every(el=>el.textContent.includes('Legal for Anything Goes'))"), 'AG revalidation');
  assert.equal(await run("[...document.querySelectorAll('.bot-play')].every(el=>el.disabled)"), true, 'AG requires updated host');
  await click('[data-format=downloads]');
  assert.equal(await run("document.getElementById('practice-roster').hidden"), true);
  assert.equal(await run("document.querySelectorAll('#practice-downloads .bot-card').length"), 2);
  assert.equal(await run("document.querySelectorAll('#practice-downloads .bot-play, #practice-downloads .bots-group').length"), 0);
  assert.equal(await run("document.querySelector('.bots-credit').textContent.includes('Jake Grigsby')"), true);
  await click('#metamon-download');
  await until(() => downloading, 'Metamon download requested');
  await until(() => run("!document.getElementById('metamon-cancel').hidden"), 'cancel control');
  await click('#metamon-cancel');
  await until(() => !downloading, 'download cancelled');
  await until(() => run("!document.getElementById('metamon-download').hidden && !document.getElementById('metamon-download').disabled"), 'retry enabled');
  await click('#metamon-download');
  await until(() => downloading, 'download retry');
  downloading = false; downloaded = true;
  await until(() => run("!document.getElementById('metamon-where').hidden"), 'installed controls');
  await click('#metamon-where [data-engine=local]');
  await until(() => run("document.querySelector('#metamon-where [data-engine=local]').getAttribute('aria-checked') === 'true'"), 'local preference');
  const status = await run('window.desktop.getPractice()');
  assert.equal(status.metamonEngineChoice, 'local'); assert.equal(status.engineChoice, 'cloud');
  await click('[data-format=gen9ou]');
  await until(() => run("!document.querySelector('[data-bot=metamon] .bot-play').disabled"), 'local Metamon ready');
  await click('[data-bot=metamon] .bot-play');
  await until(() => calls.length === 2, 'local Metamon start');
  assert.equal(calls[1].engine, 'local');
  await click('[data-format=downloads]');
  await click('#metamon-remove');
  await until(() => !downloaded, 'Metamon removed');
  await until(() => run("!document.getElementById('metamon-download').hidden"), 'download restored');
  assert.equal((await run('window.desktop.getPractice()')).metamonEngineChoice, 'cloud');
  const dir = path.join(__dirname, '../out/roster-desktop'); fs.mkdirSync(dir, { recursive: true });
  win.show();
  for (const [width, height] of [[1366,768],[1024,640]]) {
    win.setSize(width,height);
    for (const theme of ['light','dark']) {
      await run(`window.desktop.setTheme('${theme}')`);
      for (const format of ['gen9ou','gen9anythinggoes','downloads']) {
        await click(`[data-format=${format}]`);
        await pause(1200);
        await run("document.querySelector('.bots-head').scrollIntoView(); 0");
        assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, 'no overflow');
        fs.writeFileSync(path.join(dir, `${format}-${width}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
        await run("document.querySelector('#practice-downloads:not([hidden]), #practice-bots').scrollIntoView(); 0");
        await pause(150);
        fs.writeFileSync(path.join(dir, `${format}-cards-${width}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  console.log('Roster desktop passed: OU/AG tabs, validation on format change, old-host gating, Metamon cloud availability, flat Downloads tab, both themes/sizes.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
