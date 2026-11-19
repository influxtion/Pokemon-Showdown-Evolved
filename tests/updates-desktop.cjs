'use strict';
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { app, BrowserWindow, dialog, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-updates-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeLayout: 'classic', showdexPrompted: true }));
async function until(check, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { try { if (await check()) return; } catch {} await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`Timed out: ${label}`);
}
app.whenReady().then(async () => {
  let server;
  try {
    const { NsisUpdater } = require('electron-updater');
    const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
    const { Updates } = require('../app/updates');
    const payload = Buffer.from('Harmless update test payload. Never executed.');
    let version = '0.3.0', corrupt = false, quitHooks = 0;
    server = http.createServer((req, res) => {
      if (req.url.startsWith('/latest.yml')) {
        const hash = createHash('sha512').update(payload).digest('base64');
        res.end(`version: ${version}\nfiles:\n  - url: test.exe\n    sha512: ${hash}\n    size: ${payload.length}\npath: test.exe\nsha512: ${hash}\n`);
      } else res.end(corrupt ? Buffer.from('corrupt') : payload);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    async function download(name) {
      const config = path.join(profile, `${name}.yml`);
      fs.writeFileSync(config, `provider: generic\nurl: ${url}\nupdaterCacheDirName: ${name}\n`);
      const native = new NsisUpdater(null, { version: '0.2.0', name, isPackaged: true, userDataPath: profile,
        baseCachePath: profile, appUpdateConfigPath: config, whenReady: () => Promise.resolve(),
        onQuit: () => { quitHooks++; }, quit: () => { throw new Error('Unexpected quit'); } });
      native.httpExecutor = new ElectronHttpExecutor();
      native.disableDifferentialDownload = true;
      const controller = new Updates({ updater: native, version: '0.2.0' });
      await controller.check();
      return { native, controller };
    }
    const good = await download('good');
    assert.equal(good.controller.status().phase, 'ready');
    assert.deepEqual(fs.readFileSync(good.native.installerPath), payload);
    assert.equal(quitHooks, 0);
    corrupt = true;
    assert.equal((await download('bad')).controller.status().phase, 'error');
    corrupt = false; version = '0.2.0';
    assert.equal((await download('same')).controller.status().phase, 'current');
    version = '0.1.0';
    assert.equal((await download('older')).controller.status().phase, 'current');
    await new Promise(resolve => server.close(resolve)); server = null;

    session.fromPartition('persist:showdown').protocol.handle('https', () => new Response(`<!doctype html><script>
      window.app = { rooms: { '': { searching: false, $: () => ({length: 0}) } },
      user: { get: key => key === 'name' ? 'Tester' : '' }, curRoom: {id:''}, updateLayout(){},
      isDisconnected:false, popups:[] };</script>`, { headers: { 'content-type': 'text/html' } }));
    let controller, installed = 0, onConfirm = async () => {}, confirms = 0;
    const fake = new EventEmitter();
    fake.checkForUpdates = async () => ({ updateInfo: { version: '0.3.0' }, cancellationToken: {} });
    fake.downloadUpdate = async () => fake.emit('update-downloaded');
    require('../app/updates').Updates = class extends Updates {
      constructor(options) {
        super({ ...options, version: '0.2.0', mode: 'automatic', updater: fake, install: () => { installed++; } });
        controller = this;
      }
    };
    dialog.showMessageBox = async (_win, options) => {
      if (options.title === 'Restart to update') { confirms++; await onConfirm(); return { response: 1 }; }
      return { response: 0 };
    };
    require('../app/main');
    await until(() => BrowserWindow.getAllWindows().length === 1 && controller, 'app');
    const win = BrowserWindow.getAllWindows()[0];
    const run = code => win.webContents.executeJavaScript(code);
    const load = page => win.loadFile(path.join(__dirname, '..', 'renderer', page));
    const client = () => win.contentView.children[0].webContents;
    await until(() => !win.webContents.isLoading() && win.webContents.getURL().endsWith('/index.html'), 'home');
    await until(() => client() && !client().isLoading(), 'client');
    await controller.check();
    await load('settings.html');
    await until(() => run("!document.getElementById('update-restart').hidden"), 'update ready UI');
    const restart = () => run('window.desktop.restartForUpdate()');
    await run("sessionStorage.setItem('replayNote.editorDraft', JSON.stringify({notes:'Keep this draft'}))");
    assert.match((await restart()).error, /unsaved/);
    assert.equal(confirms, 0);
    assert.match(await run("sessionStorage.getItem('replayNote.editorDraft')"), /Keep this draft/);
    await run("sessionStorage.removeItem('replayNote.editorDraft')");
    await client().executeJavaScript("app.rooms['battle-gen9ou-1'] = {id:'battle-gen9ou-1', battle:{ended:false, p1:{name:'Tester'}, p2:{name:'Opponent'}}}; void 0");
    assert.match((await restart()).error, /battles/);
    await client().executeJavaScript("delete app.rooms['battle-gen9ou-1']; app.rooms[''].searching=['gen9ou']; void 0");
    assert.match((await restart()).error, /search/);
    await client().executeJavaScript("app.rooms[''].searching=false; void 0");
    onConfirm = async () => { await client().executeJavaScript("app.isDisconnected=true; void 0"); };
    assert.match((await restart()).error, /Reconnect/);
    assert.equal(installed, 0);
    await client().executeJavaScript("app.isDisconnected=false; void 0");
    onConfirm = async () => {};
    assert.equal((await restart()).ok, true);
    assert.equal(installed, 1);
    const { PracticeTeams } = require('../app/practice-teams');
    const oldCheck = PracticeTeams.prototype.check;
    const preparations = [];
    PracticeTeams.prototype.check = () => new Promise(resolve => preparations.push(resolve));
    await load('practice.html');
    await run("window.desktop.startPractice({opponent:'foulplay-medium',preset:'full',format:'gen9ou',teams:{player:{source:'paste',text:'Pikachu'},bot:{source:'paste',text:'Pikachu'}}}); void 0");
    await until(() => preparations.length === 2, 'team preparation');
    await load('settings.html');
    assert.match((await restart()).error, /operation/);
    for (const finish of preparations) finish({ ok: false, error: 'Test cancellation' });
    PracticeTeams.prototype.check = oldCheck;
    await new Promise(resolve => setTimeout(resolve, 50));
    await load('replays.html');
    assert.match((await restart()).error, /Settings/);
    await run('window.desktop.setReplayNoteDirty(true)');
    await load('settings.html');
    assert.match((await restart()).error, /unsaved/);
    await run("document.getElementById('update-restart').click(); void 0");
    await until(() => run("!document.getElementById('update-error').hidden"), 'blocked restart explanation');
    fs.mkdirSync(path.join(__dirname, '..', 'out', 'updates-desktop'), { recursive: true });
    for (const theme of ['light', 'dark']) {
      win.setSize(1024, 640);
      await run(`window.desktop.setTheme('${theme}')`);
      await run("document.getElementById('update-status').scrollIntoView({block:'center'}); void 0");
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
      fs.writeFileSync(path.join(__dirname, '..', 'out', 'updates-desktop', `${theme}.png`), (await win.webContents.capturePage()).toPNG());
    }
    console.log('PASS updates: real download/hash/version checks, no quit hook, UI, drafts, battles, search, confirmation race');
    controller.dispose(); app.exit(0);
  } catch (error) { console.error(error); server?.close(); app.exit(1); }
});
