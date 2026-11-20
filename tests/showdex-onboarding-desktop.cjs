'use strict';
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { app, BrowserWindow, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdex-onboarding-'));
app.setPath('userData', profile);
const vendor = path.join(profile, 'fixture');
fs.mkdirSync(path.join(vendor, 'dist'), { recursive: true });
const asset = 'window.__SHOWDOWN_DESKTOP_SHOWDEX = { state: "loaded", version: "1.4.2" };';
const entry = path.join(vendor, 'dist', 'main.js');
const manifestFile = path.join(vendor, 'manifest.json');
fs.writeFileSync(entry, asset);
fs.writeFileSync(manifestFile, JSON.stringify({ version: '1.4.2', commit: '165abdb05ad08c5b286f71e21cc1907852efd76f',
  resourceProtocol: 'showdex', resourcePrefix: 'assets', assets: { 'main.js': createHash('sha256').update(asset).digest('hex') } }));
for (const file of ['LICENSE', 'SOURCE.md', 'dist/showdex-source.tar.gz']) fs.writeFileSync(path.join(vendor, file), 'Fixture source');
const installModule = require('../app/showdex-install');
const Installer = installModule.ShowdexInstaller;
installModule.ShowdexInstaller = class extends Installer { constructor(dir) { super(dir, { vendor }); } };
const integration = require('../app/showdex-integration');
const Integration = integration.ShowdexIntegration;
integration.ShowdexIntegration = class extends Integration { constructor(options) { super({ manifestFile, ...options }); } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
app.whenReady().then(async () => {
  // Home artwork stays offline in this suite; loopback update fixtures remain available.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) && new URL(details.url).hostname !== '127.0.0.1' }));
  session.fromPartition('persist:showdown').webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  require('../app/main');
  await until(() => BrowserWindow.getAllWindows().length, 'window');
  const win = BrowserWindow.getAllWindows()[0];
  const run = code => win.webContents.executeJavaScript(code);
  const load = page => win.loadFile(path.join(__dirname, '..', 'renderer', page));
  await until(() => !win.webContents.isLoading(), 'Home');
  await until(() => run("document.getElementById('welcome').open"), 'layout first');
  assert.equal(await run("document.getElementById('showdex-welcome').open"), false);
  await run("document.querySelector('[data-layout=classic]').click(); 0");
  await until(() => run("document.getElementById('showdex-welcome').open"), 'optional setup');
  assert.equal(fs.existsSync(path.join(profile, 'showdex')), false, 'nothing installed before consent');
  win.show(); win.setSize(1024, 640);
  const captures = path.join(__dirname, '..', 'out', 'showdex-onboarding'); fs.mkdirSync(captures, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await run(`window.desktop.setTheme('${theme}')`); await pause(150);
    assert.equal(await run("(() => { const r = document.getElementById('showdex-welcome').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()"), true);
    fs.writeFileSync(path.join(captures, `prompt-1024-${theme}.png`), (await win.webContents.capturePage()).toPNG());
  }
  await run("document.getElementById('showdex-welcome-skip').click(); 0");
  await until(() => run("!document.getElementById('showdex-welcome').open"), 'skip closes');
  await load('index.html'); await pause(250);
  assert.equal(await run("document.getElementById('showdex-welcome').open"), false, 'skip persists');
  assert.equal((await run('window.desktop.getSettings()')).settings.showdexEnabled, false);
  await load('settings.html');
  await until(() => run("!document.getElementById('showdex-install').hidden"), 'install later');
  fs.writeFileSync(entry, 'damaged');
  await run("document.getElementById('showdex-install').click(); 0");
  await until(() => run("document.getElementById('settings-status').textContent.includes('missing or damaged')"), 'failure feedback');
  assert.equal((await run('window.desktop.getShowdex()')).installed, false);
  assert.equal((await run('window.desktop.getSettings()')).settings.showdexEnabled, false);
  // Re-arm only this test profile to exercise acceptance in the same real first-launch dialog.
  await run("window.desktop.setSetting('showdexPrompted', false)");
  await load('index.html');
  await until(() => run("document.getElementById('showdex-welcome').open"), 'acceptance setup');
  await run("document.getElementById('showdex-welcome-install').click(); 0");
  await until(() => run("document.getElementById('showdex-welcome-install').textContent === 'Try again'"), 'retry available');
  assert.equal((await run('window.desktop.getSettings()')).settings.showdexPrompted, false);
  fs.writeFileSync(entry, asset);
  const client = win.contentView.children[0].webContents;
  let navigations = 0; client.on('did-start-loading', () => navigations++);
  await run("document.getElementById('showdex-welcome-install').click(); 0");
  await until(() => run("document.getElementById('showdex-welcome-install').textContent === 'Continue'"), 'installed');
  const state = await run('window.desktop.getShowdex()');
  assert.equal(state.installed, true); assert.equal(state.enabled, true);
  assert.equal(navigations, 0, 'install never reloads the client');
  for (const file of ['main.js', 'LICENSE', 'SOURCE.md', 'showdex-source.tar.gz']) assert.ok(fs.existsSync(path.join(profile, 'showdex', '1.4.2', file)));
  await run("document.getElementById('showdex-welcome-install').click(); 0");
  await load('index.html'); await pause(250);
  assert.equal(await run("document.getElementById('showdex-welcome').open"), false);
  await load('settings.html');
  await until(() => run("!document.getElementById('showdex-enabled').disabled"), 'enabled control');
  assert.equal(await run("document.getElementById('showdex-install').hidden"), true);
  console.log('PASS Showdex onboarding: layout first, skip persists, Settings install, failure/retry, verified opt-in, no client reload, compact light/dark prompt.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
