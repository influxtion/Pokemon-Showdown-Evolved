'use strict';

const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { WebContentsView, session } = require('electron');
const { ShowdexIntegration } = require('./showdex-integration');
const { ShowdownBridge } = require('./showdown');

function allowRequest(details, root, connection, showdex = false) {
  let url;
  try { url = new URL(details.url); } catch { return false; }
  if (showdex && url.protocol === 'showdex:' && url.hostname === 'assets' && !url.search && !url.hash &&
      /^\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url.pathname)) return true;
  // Read-only format metadata for the two supported practice formats. No account lookups,
  // arbitrary URLs, query strings, or uploads from the practice partition.
  if (showdex && details.method === 'GET' && details.resourceType === 'xhr' &&
      url.origin === 'https://pkmn.github.io' && !url.search && !url.hash &&
      ['/randbats/data/gen9randombattle.json', '/randbats/data/stats/gen9randombattle.json',
        '/smogon/data/sets/gen9ou.json', '/smogon/data/stats/gen9ou.json'].includes(url.pathname)) return true;
  if (connection.clientUrl) {
    if (url.href === connection.socketUrl) return true;
    if (url.origin === connection.serviceOrigin && url.pathname.startsWith(`/s/${connection.token}/`) &&
        (!url.search || /^\?v=[a-zA-Z0-9.-]{1,32}$/.test(url.search)) && !url.hash && ['https:', 'http:'].includes(url.protocol)) return true;
    if (url.protocol === 'file:' || url.protocol === 'ws:' || url.protocol === 'wss:') return false;
  }
  if (url.protocol === 'file:') {
    try {
      if (url.hostname) return false;
      const relative = path.relative(root, fileURLToPath(url));
      return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    } catch { return false; }
  }
  if (url.protocol === 'ws:') return url.href === `ws://127.0.0.1:${connection.port}/showdown/websocket?token=${connection.token}`;
  const spriteVersion = (url.pathname === '/sprites/pokemonicons-sheet.png' && url.search === '?v22') ||
    (url.pathname === '/sprites/itemicons-sheet.png' && url.search === '?v1');
  return details.resourceType === 'image' && url.origin === 'https://play.pokemonshowdown.com' &&
    /^\/(sprites|fx)\/[a-zA-Z0-9_./-]+\.(png|gif|webp|jpg)$/.test(url.pathname) && (!url.search || spriteVersion) && !url.hash;
}

class PracticeView {
  // `battleCss()` returns the battle-room stylesheet while the launcher battle style is on, else ''.
  // `script()` returns JavaScript to run in each new document (the battle resize handle), and
  // `onConsole(text)` receives the page's console messages (how that handle reports a new size).
  constructor({ window, root, css, battleCss = () => '', script = () => '', onConsole = () => {}, showdex = () => null, background, onFailure = () => {}, onContents = () => {}, View = WebContentsView }) {
    this.window = window;
    this.root = root;
    this.css = css;
    this.onContents = onContents;
    this.battleCss = battleCss;
    this.script = script;
    this.onConsole = onConsole;
    this.showdex = showdex;
    this.generation = 0;
    this.battleCssKey = null;
    this.battleCssQueue = Promise.resolve();
    this.background = background;
    this.View = View;
    this.onFailure = onFailure;
    this.view = null;
    this.visible = false;
    this.bounds = null;
    this.state = 'idle';
    this.error = '';
    this.healthTimer = null;
  }

  async open(connection) {
    this.close();
    const generation = this.generation;
    const partition = session.fromPartition(`practice-${connection.token}`);
    const showdexOptions = this.showdex();
    let showdexReady = false;
    if (showdexOptions) {
      const integration = new ShowdexIntegration({ ...showdexOptions,
        origin: connection.clientUrl ? new URL(connection.clientUrl).origin : 'null' });
      try { showdexReady = (await integration.registerAssets(partition)).installed; } catch { /* Optional: practice still opens. */ }
    }
    if (generation !== this.generation) return;
    const view = new this.View({ webPreferences: { session: partition,
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    this.view = view;
    this.state = 'connecting';
    view.setBackgroundColor(this.background);
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    const contents = view.webContents;
    this.onContents(contents);
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    contents.session.on('will-download', event => event.preventDefault());
    contents.session.webRequest.onBeforeRequest((details, respond) => respond({ cancel: !allowRequest(details, this.root, connection, showdexReady) }));
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-frame-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('dom-ready', () => {
      if (this.view === view) {
        contents.insertCSS(this.css, { cssOrigin: 'user' }).catch(() => {});
        this.applyBattleCss({ reloaded: true });
        const code = this.script();
        if (code) contents.executeJavaScript(code).catch(() => {});
        if (showdexReady) new ShowdownBridge(() => this.view === view ? contents : null).loadShowdex();
        // Artwork can finish much later than the usable battle document.
        pollHealth();
      }
    });
    const fail = message => {
      if (this.view !== view || this.state === 'failed') return;
      this.state = 'failed';
      this.error = message;
      clearTimeout(this.healthTimer);
      this.healthTimer = null;
      this.place();
      this.onFailure(connection.token);
    };
    const loadFailed = () => fail('Practice client could not load. Stop and start a new session.');
    const pollHealth = async () => {
      if (this.view !== view || contents.isDestroyed() || this.state === 'failed') return;
      let state;
      try {
        state = await contents.executeJavaScript('document.documentElement?.dataset.practiceState');
      } catch { /* The view can close while a probe is pending. */ }
      if (this.view !== view || contents.isDestroyed() || this.state === 'failed') return;
      if (state === 'failed') {
        fail('The battle client disconnected. Start a new session to try again.');
        return;
      }
      if (['connecting', 'ready', 'battle', 'finished'].includes(state)) this.state = state;
      this.healthTimer = setTimeout(pollHealth, 500);
      this.healthTimer.unref();
    };
    contents.on('console-message', (event) => {
      if (this.view === view && event.frame === contents.mainFrame) this.onConsole(event.message);
    });
    contents.on('render-process-gone', loadFailed);
    contents.on('did-fail-load', (_event, code, _description, _url, main) => { if (main && code !== -3) loadFailed(); });
    const url = connection.clientUrl ? new URL(connection.clientUrl) : pathToFileURL(path.join(this.root, 'practice-client.html'));
    if (!connection.clientUrl) {
      for (const key of ['port', 'token', 'human', 'bot']) url.searchParams.set(key, String(connection[key]));
      // OU: the player's packed team. The view's storage partition is in memory only.
      for (const key of ['format', 'team']) if (connection[key]) url.searchParams.set(key, String(connection[key]));
    }
    contents.loadURL(url.href).catch(loadFailed);
    this.place();
  }

  show(bounds) {
    if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]) && bounds[key] >= 0 && bounds[key] <= 20000)) return false;
    const content = this.window.getContentBounds();
    const x = Math.round(bounds.x), y = Math.round(bounds.y);
    this.bounds = { x, y, width: Math.min(Math.round(bounds.width), content.width - x),
      height: Math.min(Math.round(bounds.height), content.height - y) };
    this.visible = this.bounds.width > 0 && this.bounds.height > 0;
    this.place();
    return this.visible;
  }

  hide() { this.visible = false; this.place(); }

  status() { return { state: this.state, error: this.error }; }

  finishedBattle(roomId) {
    return new ShowdownBridge(() => this.view?.webContents).finishedBattle(roomId);
  }

  // Runs JavaScript in the open battle document, if there is one.
  run(code) {
    const contents = this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null;
    if (contents && !contents.isLoading()) contents.executeJavaScript(code).catch(() => {});
  }

  // Adds or removes the battle-room stylesheet to match the Battle screen setting, in order.
  applyBattleCss({ reloaded = false } = {}) {
    const view = this.view;
    this.battleCssQueue = this.battleCssQueue.then(async () => {
      if (reloaded) this.battleCssKey = null;
      if (!view || this.view !== view || view.webContents.isDestroyed()) return;
      const css = this.battleCss();
      if (css && !this.battleCssKey) {
        this.battleCssKey = await view.webContents.insertCSS(css, { cssOrigin: 'user' });
      } else if (!css && this.battleCssKey) {
        const key = this.battleCssKey;
        this.battleCssKey = null;
        await view.webContents.removeInsertedCSS(key);
      }
    }).catch(() => {});
  }

  place() {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    if (this.bounds && this.bounds.width > 0 && this.bounds.height > 0) this.view.setBounds(this.bounds);
    this.view.setVisible(this.visible && !this.error);
    this.view.webContents.setAudioMuted(!this.visible || Boolean(this.error));
  }

  close() {
    this.generation++;
    this.battleCssKey = null;
    clearTimeout(this.healthTimer);
    this.healthTimer = null;
    this.state = 'idle';
    this.error = '';
    if (!this.view) return;
    const view = this.view;
    this.view = null;
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) { view.webContents.setAudioMuted(true); view.webContents.close(); }
  }
}

module.exports = { PracticeView, allowRequest };
