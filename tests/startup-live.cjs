'use strict';

// Optional guest-only startup budget and page audit. Captures contain no account data.
const started = performance.now();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'evolved-startup-'));
process.env.SHOWDOWN_DESKTOP_USER_DATA = profile;
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
  theme: 'dark', homeLayout: 'modern', showdexPrompted: true, confirmOnClose: false,
}));
const output = path.join(__dirname, '..', 'out', 'startup-audit');
fs.mkdirSync(output, { recursive: true });
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', event => {
    if (event.level === 'error' && contents.getURL().startsWith('file:')) errors.push(event.message);
  });
  contents.on('render-process-gone', () => errors.push('Renderer process exited unexpectedly'));
});
require('../app/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (await fn()) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}
app.whenReady().then(async () => {
  await until(() => BrowserWindow.getAllWindows().length, 'window');
  const win = BrowserWindow.getAllWindows()[0];
  const page = code => win.webContents.executeJavaScript(code);
  await until(() => !win.webContents.isLoading() && win.webContents.getURL().endsWith('/index.html'), 'Home');
  const timings = { launcherMs: Math.round(performance.now() - started), pages: {} };
  assert.ok(timings.launcherMs < 10000, 'launcher ready within 10 seconds');
  await until(async () => (await page('window.desktop.getSession()')).connected, 'live Showdown connection', 60000);
  await until(async () => (await page('window.desktop.getShowdown()')).formats?.length > 0, 'formats', 30000);
  timings.connectedMs = Math.round(performance.now() - started);
  await until(() => page('Boolean(document.querySelector("#format")?.options.length > 1)'), 'Home formats rendered');
  for (const theme of ['dark', 'light']) {
    await page(`window.desktop.setTheme(${JSON.stringify(theme)})`);
    for (const name of ['index', 'practice', 'replays', 'stats', 'resources', 'settings']) {
      const begin = performance.now();
      await win.loadFile(path.join(__dirname, '..', 'renderer', `${name}.html`));
      await until(() => page('Boolean(window.desktop && document.querySelector(".main"))'), `${name} ready`);
      timings.pages[`${name}-${theme}`] = Math.round(performance.now() - begin);
      assert.ok(timings.pages[`${name}-${theme}`] < 5000, `${name} navigation within 5 seconds`);
      await pause(500);
      assert.equal(await page('document.documentElement.scrollWidth > innerWidth'), false, `${name} horizontal overflow`);
      assert.equal(await page('[...document.images].some(i => i.complete && !i.naturalWidth)'), false, `${name} broken image`);
      fs.writeFileSync(path.join(output, `${name}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    }
  }
  assert.deepEqual(errors, [], 'no launcher console errors');
  fs.writeFileSync(path.join(output, 'timings.json'), JSON.stringify(timings, null, 2));
  console.log('PASS guest startup and all launcher pages:', JSON.stringify(timings));
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
