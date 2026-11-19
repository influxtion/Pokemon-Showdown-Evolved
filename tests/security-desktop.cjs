'use strict';
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';

// Exercise production guards against controlled remote pages, never real accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, session, shell } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-security-'));
app.setPath('userData', profile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  const remote = session.fromPartition('persist:showdown');
  const requests = [];
  await remote.protocol.handle('https', request => {
    requests.push(request.url);
    if (request.url === 'https://play.pokemonshowdown.com/redirect-test') {
      return new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid/redirected' } });
    }
    return new Response('<!doctype html><html><body>Controlled security fixture</body></html>',
      { headers: { 'Content-Type': 'text/html' } });
  });
  const external = [];
  shell.openExternal = async url => { external.push(url); };
  require('../app/main');
  await until(() => BrowserWindow.getAllWindows().length > 0, 'launcher');
  const win = BrowserWindow.getAllWindows()[0];
  await until(() => !win.webContents.isLoading() && win.webContents.getURL().endsWith('index.html'), 'Home');
  const client = win.contentView.children[0].webContents;
  await until(() => !client.isLoading() && client.getURL() === 'https://play.pokemonshowdown.com/', 'client fixture');
  let secondInstance = false;
  app.once('second-instance', () => { secondInstance = true; });
  const childEnv = { ...process.env, SHOWDOWN_DESKTOP_USER_DATA: profile };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const second = spawn(process.execPath, [path.join(__dirname, '..')], { env: childEnv, windowsHide: true, stdio: 'ignore' });
  const secondExit = new Promise((resolve, reject) => { second.once('error', reject); second.once('exit', resolve); });
  await until(() => secondInstance, 'second launch reuses the profile owner');
  assert.equal(await secondExit, 0);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  const run = code => client.executeJavaScript(code);
  assert.equal(await run('typeof require'), 'undefined');
  assert.equal(await run('typeof window.desktop'), 'undefined');
  for (const name of ['geolocation', 'notifications', 'camera', 'microphone']) {
    assert.equal(await run(`navigator.permissions.query({name:${JSON.stringify(name)}}).then(p=>p.state)`), 'denied', name);
  }
  assert.equal(await run('Notification.requestPermission()'), 'denied');
  assert.equal((await win.webContents.executeJavaScript('window.desktop.getSettings()')).ok, true);
  assert.equal(await win.webContents.executeJavaScript(`fetch('https://attacker.invalid/csp-test').then(()=>false,()=>true)`), true);

  // A different webContents with the actual preload cannot invoke privileged handlers.
  const fixture = path.join(profile, 'untrusted.html');
  fs.writeFileSync(fixture, '<!doctype html><html><body>Untrusted document</body></html>');
  const untrusted = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, '../app/preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  await untrusted.loadFile(fixture);
  assert.equal((await untrusted.webContents.executeJavaScript('window.desktop.getSettings()')).ok, false);
  assert.equal(await untrusted.webContents.executeJavaScript('window.desktop.getDailyChallenge()'), null);
  assert.equal((await untrusted.webContents.executeJavaScript('window.desktop.startDailyChallenge()')).ok, false);
  untrusted.destroy();

  // Unsupported schemes cannot escape to the system shell.
  await run("window.open('file:///C:/Windows/win.ini'); window.open('javascript:void(0)'); void 0");
  await pause(100);
  assert.deepEqual(external, []);

  await run("window.open('https://accounts.google.com/security-fixture'); void 0");
  await until(() => BrowserWindow.getAllWindows().length === 2, 'allowed OAuth popup');
  const popup = BrowserWindow.getAllWindows().find(w => w !== win);
  await until(() => !popup.webContents.isLoading(), 'OAuth fixture load');
  assert.equal(await popup.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await popup.webContents.executeJavaScript('typeof window.desktop'), 'undefined');
  await popup.webContents.executeJavaScript("location.href='https://attacker.invalid/popup-escape'; void 0");
  await pause(200);
  assert.equal(popup.webContents.getURL(), 'https://accounts.google.com/security-fixture');
  await popup.webContents.executeJavaScript("window.open('https://accounts.google.com/nested'); void 0");
  await pause(100);
  assert.equal(BrowserWindow.getAllWindows().length, 2);
  assert(!requests.some(url => url.includes('popup-escape') || url.includes('/nested')));
  popup.destroy();

  await run("location.href='https://play.pokemonshowdown.com/redirect-test'; void 0");
  await until(() => requests.some(url => url.includes('/redirect-test')), 'redirect requested');
  await pause(300);
  assert(!requests.includes('https://attacker.invalid/redirected'));
  assert(!client.getURL().includes('attacker.invalid'));
  console.log('PASS security desktop: permissions denied, isolated remote views, real IPC rejection, CSP network block, unsafe schemes, OAuth popup containment, redirect block');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
