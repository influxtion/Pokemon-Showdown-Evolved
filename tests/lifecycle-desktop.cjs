'use strict';

// Controlled download/close regression. No real downloads, accounts or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'evolved-close-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ confirmOnClose: false, homeLayout: 'classic', showdexPrompted: true }));
const { LocalEngine } = require('../app/practice-engines');
const engines = new Map();
const originalStatus = LocalEngine.prototype.status;
LocalEngine.prototype.status = function() { engines.set(this.name, this); return originalStatus.call(this); };
let accepted = false;
let prompted = 0;
let readyToExit = false;
app.on('before-quit', event => { if (!readyToExit) event.preventDefault(); });
dialog.showMessageBox = async (_win, options) => {
  assert.equal(options.message, 'A bot is still downloading.');
  prompted++;
  return { response: accepted ? 1 : 0 };
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(100); }
  throw new Error('Close lifecycle timed out');
}
app.whenReady().then(async () => {
  for (const s of [session.defaultSession, session.fromPartition('persist:showdown')]) {
    s.webRequest.onBeforeRequest((details, reply) => reply({ cancel: /^https?:/.test(details.url) }));
  }
  require('../app/main');
  await until(() => BrowserWindow.getAllWindows()[0]);
  const win = BrowserWindow.getAllWindows()[0];
  await until(() => !win.webContents.isLoading());
  await win.webContents.executeJavaScript('window.desktop.getPractice()');
  assert.equal(engines.size, 2);
  let cancelled = 0;
  let serversClosed = 0;
  for (const engine of engines.values()) {
    engine.installing = new Promise(() => {});
    engine.cancel = () => { cancelled++; engine.installing = null; };
    engine.server = { api: { close: async () => { serversClosed++; } } };
  }
  win.close();
  await until(() => prompted === 1);
  await pause(150);
  assert.equal(win.isDestroyed(), false);
  assert.equal(cancelled, 0, 'declining preserves downloads');
  accepted = true;
  win.close();
  await until(() => win.isDestroyed());
  assert.equal(cancelled, 2, 'confirmed close cancels both engines without waiting for app quit');
  assert.equal(serversClosed, 2);
  readyToExit = true;
  console.log('PASS window lifecycle: declined close preserves downloads; confirmed close cancels both engines and closes private servers before app quit.');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
