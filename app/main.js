'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, nativeTheme, shell, dialog,
  protocol, session: electronSession, screen, Notification } = require('electron');
require('./profile').configureProfile(app);
const { Settings } = require('./settings');
const { ShowdownBridge } = require('./showdown');
const { Replays } = require('./replays');
const { ReplayImports } = require('./replay-imports');
const { ReplayReview } = require('./replay-review');
const { PracticeSession } = require('./practice-session');
const { CloudEngine } = require('./practice-engines');
const { readBotConfig, runtimeOptions } = require('./bot-config');
const { PracticeView } = require('./practice-view');
const { PracticeTeams, FORMATS: TEAM_FORMATS } = require('./practice-teams');
const { Logger } = require('./logging');
const { WindowState } = require('./window-state');
const { MessageAlerts } = require('./message-alerts');
const { launcherUrl, launcherFrame, httpsHost, denyPermissions } = require('./security');
const { ShowdexIntegration, registerShowdexScheme } = require('./showdex-integration');
const { tabShortcut } = require('./shortcuts');

if (!app.isReady()) registerShowdexScheme(protocol);
const showdex = new ShowdexIntegration();
let showdexBundle = { installed: false, version: '1.4.2' };
let showdexApplied = false;
let showdexLoadFailed = false;

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const CLIENT_CSS = ['client-theme.css', 'client-shell.css', 'client-battle.css', 'client-ladder.css', 'client-teambuilder.css', 'client-community.css', 'client-messages.css', 'client-rooms.css', 'client-friends.css', 'client-chat.css', 'client-tournament.css', 'showdex-theme.css']
  .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
const REPLAY_CSS = ['client-theme.css', 'replay-theme.css']
  .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
// Window and view fills shown before pages paint; match --bg-app in each theme.
const BACKGROUND = { light: '#e6ecf5', dark: '#24304a' };
const CLIENT_URL = 'https://play.pokemonshowdown.com/';
// Persistent partition keeps the Showdown login across launches, isolated from the launcher.
const CLIENT_PARTITION = 'persist:showdown';
// Showdown's "Log in with Google" opens a popup; everything else goes to the system browser.
const POPUP_HOSTS = new Set(['accounts.google.com']);

let win = null;
let client = null;
let settings = null;
let replays = null;
let replayImports = null;
let replayReview = null;
let practice = null;
let practiceView = null;
let practiceTeams = null;
// The cloud server that computes Foul Play's moves. Lives for the whole app, independent of windows.
let cloudEngine = null;
let choosingReplayImport = false;
let undoingReplayImport = false;
let replayDirty = false;
let exportingReplays = false;
let confirmingClose = false;
let allowClose = false;
let maintenance = false;
let logger = null;
let windowState = null;
const bridge = new ShowdownBridge(() => (client ? client.webContents : null));
const messageAlerts = new MessageAlerts();
// Held so click handlers survive garbage collection until the notification closes.
const shownAlerts = new Set();

// Windows matches toasts to the installer's Start menu shortcut by this ID.
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('com.influxtion.showdowndesktop');

function background() {
  return nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light;
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isShowdownUrl(url) {
  return httpsHost(url, ['play.pokemonshowdown.com']);
}

function openExternal(url) {
  const u = parseUrl(url);
  if (u && (u.protocol === 'https:' || u.protocol === 'http:')) shell.openExternal(u.href);
}

// Tab strip shortcuts: Ctrl+Tab cycles, Ctrl+W closes the open tab, Ctrl+1–9 jump to a tab.
// The focus can be in the launcher page or in a view on top of it (the Showdown client, a
// replay, a practice battle), so the keys are caught here and passed to the launcher, which
// owns the tab order and knows which tabs can close. Sign-in popups are left alone.
let cycleFocus = false;
let cycleFocusTimer = null;

function inMainWindow(contents) {
  if (!win || win.isDestroyed()) return false;
  return contents === win.webContents || win.contentView.children.some((view) => view.webContents === contents);
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('before-input-event', (event, input) => {
    const shortcut = tabShortcut(input);
    if (!shortcut || !inMainWindow(contents)) return;
    event.preventDefault();
    // The keyboard follows the tab: the client takes it when shown, the launcher otherwise.
    cycleFocus = true;
    clearTimeout(cycleFocusTimer);
    cycleFocusTimer = setTimeout(() => { cycleFocus = false; }, 2000);
    // Ctrl+W can open the forfeit popup in the launcher, so its keys (Escape) must reach it.
    if (shortcut.type === 'close' && contents !== win.webContents) win.webContents.focus();
    win.webContents.send('nav:shortcut', shortcut);
  });
});

function isLauncherFrame(event) {
  return launcherFrame(event, win?.webContents, RENDERER_DIR);
}

function reviewNoteId(event) {
  if (!isLauncherFrame(event)) return null;
  const url = parseUrl(event.senderFrame.url);
  if (!url || !url.pathname.endsWith('/replays.html')) return null;
  const id = url.searchParams.get('review');
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

function toBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 20000) return null;
    out[key] = Math.round(n);
  }
  return out.width > 0 && out.height > 0 ? out : null;
}

// Loaded hidden at startup so Home can read formats, teams and rooms. Leaving Play only
// hides it, so an active battle survives screen changes.
function ensureClient() {
  if (client) return client;

  client = new WebContentsView({
    webPreferences: {
      partition: CLIENT_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Keep battle timers and the connection running at full speed while hidden.
      backgroundThrottling: false,
    },
  });
  client.setVisible(false);
  client.setBackgroundColor(background());

  const contents = client.webContents;
  // The launcher sends challenge and message notifications itself (see announce), so the
  // client's own would only duplicate them, and clicking those cannot raise the window.
  denyPermissions(contents.session);
  contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame) logger.write('client-load-failed', code);
  });
  contents.on('render-process-gone', () => logger.write('client-process-gone'));
  // Re-applied on every load; the stylesheet follows prefers-color-scheme, which tracks nativeTheme.
  contents.on('dom-ready', () => {
    contents.insertCSS(CLIENT_CSS, { cssOrigin: 'user' }).catch(() => {});
    bridge.installFormatModal();
    bridge.installTeamsView();
    bridge.installTeamEditor();
    showdexApplied = Boolean(showdexBundle.installed && settings.get('showdexEnabled'));
    showdexLoadFailed = false;
    if (showdexApplied) bridge.loadShowdex().then((loaded) => {
      if (!loaded) showdexLoadFailed = true;
    });
  });
  contents.setWindowOpenHandler(({ url }) => {
    const u = parseUrl(url);
    if (u && httpsHost(url, [...POPUP_HOSTS])) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isShowdownUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  contents.on('will-redirect', (event, url) => {
    if (!isShowdownUrl(url)) event.preventDefault();
  });
  // The client moves its address (/lobby, /battle-…) whenever it opens or switches rooms.
  // Tell the launcher page at once, so its tabs and top bar follow without waiting for the
  // next poll. It carries no data; the page reads the session through the bridge as usual.
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame && win && !win.isDestroyed()) win.webContents.send('client:changed');
  });
  contents.on('did-create-window', popup => {
    const child = popup.webContents;
    denyPermissions(child.session);
    child.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event, url) => {
      if (!httpsHost(url, ['accounts.google.com', 'pokemonshowdown.com', 'play.pokemonshowdown.com'])) event.preventDefault();
    };
    child.on('will-navigate', guard);
    child.on('will-redirect', guard);
  });

  win.contentView.addChildView(client);
  contents.loadURL(CLIENT_URL).catch(() => {});
  return client;
}

function hideClient() {
  if (client) client.setVisible(false);
}

function windowDisplays() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display) => ({ ...display, primary: display.id === primary }));
}

function createWindow() {
  const { maximized, ...savedBounds } = windowState.load(windowDisplays());
  win = new BrowserWindow({
    ...savedBounds,
    minWidth: 1024,
    minHeight: 640,
    title: 'Showdown Desktop',
    backgroundColor: background(),
    show: false,
    opacity: process.env.SHOWDOWN_DESKTOP_BACKGROUND === '1' ? 0 : 1,
    focusable: process.env.SHOWDOWN_DESKTOP_BACKGROUND !== '1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Pages poll the client for challenges and messages; keep that timely when minimized.
      backgroundThrottling: false,
    },
  });

  const currentWindow = win;
  win.on('focus', () => { if (!currentWindow.isDestroyed()) currentWindow.flashFrame(false); });
  if (process.env.SHOWDOWN_DESKTOP_BACKGROUND === '1') win.setIgnoreMouseEvents(true);
  replayReview = new ReplayReview({ window: win, css: REPLAY_CSS, background: background() });
  let practiceRoot = app.isPackaged ? path.join(process.resourcesPath, 'practice')
    : path.join(__dirname, '..', 'vendor', 'laplace', 'dist');
  const practiceScripts = app.isPackaged ? path.join(process.resourcesPath, 'practice-adapter')
    : path.join(__dirname, '..', 'scripts', 'laplace');
  // The simulator runs here; only the bot's moves come from the cloud server.
  const target = () => cloudEngine.target();
  try {
    const botConfig = !app.isPackaged ? readBotConfig(process.env.SHOWDOWN_BOT_CONFIG || path.join(__dirname, '../out/bots/config.json')) : null;
    if (botConfig) practiceRoot = botConfig.root;
    const checks = botConfig ? runtimeOptions(botConfig, path.join(__dirname, '..')) : {};
    practice = new PracticeSession({ root: practiceRoot, scripts: practiceScripts, target,
      ...(checks.verify ? { verify: checks.verify } : {}), ...(checks.installed ? { installed: checks.installed } : {}) });
  } catch {
    practice = new PracticeSession({ root: practiceRoot, scripts: practiceScripts, target, installed: () => false });
    practice.state = 'failed';
    practice.error = 'Battle configuration could not load. Check the practice runtime setup.';
  }
  practiceTeams = new PracticeTeams({ root: practiceRoot });
  practiceView = new PracticeView({ window: win, root: path.join(practiceRoot, 'client'), css: CLIENT_CSS,
    background: background(), onFailure: token => practice?.clientFailed(token) });
  practice.on('ready', connection => { logger.write('practice-ready'); practiceView?.open(connection); });
  practice.on('failure', code => {
    logger.write('practice-failed', { start: 1, exited: 2, timeout: 3, client: 4, integrity: 5, engine: 6 }[code] || 0);
    // Show the cloud server's real state right away instead of at the next periodic check.
    if (code === 'engine') cloudEngine?.refresh();
  });
  practice.on('change', state => { if (state.state === 'failed' || state.state === 'idle') practiceView?.close(); });
  let windowSaveTimer;
  const persistWindow = () => {
    if (!currentWindow.isDestroyed()) windowState.save({
      bounds: currentWindow.getNormalBounds(), maximized: currentWindow.isMaximized(),
    });
  };
  for (const event of ['move', 'resize', 'maximize', 'unmaximize']) {
    currentWindow.on(event, () => {
      clearTimeout(windowSaveTimer);
      windowSaveTimer = setTimeout(persistWindow, 250);
    });
  }

  const contents = win.webContents;
  denyPermissions(contents.session);
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  // will-frame-navigate fires first, for every frame; cancelling it there means will-navigate
  // never fires, so an outside link (Home's news, for one) is handed to the browser here.
  contents.on('will-frame-navigate', event => {
    if (event.isMainFrame && launcherUrl(event.url, RENDERER_DIR)) return;
    event.preventDefault();
    if (event.isMainFrame) openExternal(event.url);
  });
  // Kept as a second guard; it only blocks, so a link can never open twice.
  contents.on('will-navigate', (event, url) => {
    if (!launcherUrl(url, RENDERER_DIR)) event.preventDefault();
  });
  contents.on('will-redirect', event => event.preventDefault());
  // Every launcher page change hides the client; play.html shows it again with fresh bounds.
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      hideClient();
      replayReview?.close();
      practiceView?.hide();
    }
  });
  contents.on('did-navigate', () => {
    // An outgoing page's ResizeObserver can enqueue bounds during navigation.
    if (!parseUrl(contents.getURL())?.pathname.endsWith('/practice-battle.html')) practiceView?.hide();
    // After Ctrl+Tab away from the client, typing must not go to the hidden view.
    if (cycleFocus && !parseUrl(contents.getURL())?.pathname.endsWith('/play.html')) {
      cycleFocus = false;
      contents.focus();
    }
  });

  win.on('close', (event) => {
    if (allowClose) { persistWindow(); return; }
    event.preventDefault();
    if (confirmingClose) return;
    confirmingClose = true;
    (async () => {
      if (maintenance) return;
      if (replayDirty && !(await confirmDiscardReplay())) return;
      if (settings.get('confirmOnClose') && practice?.battle && !practice.battle.finished) {
        const result = await dialog.showMessageBox(win, { type: 'question', buttons: ['Keep playing', 'Close app'],
          defaultId: 0, cancelId: 0, message: 'Close during practice?', detail: 'The practice battle will end.' });
        if (result.response !== 1) return;
      }
      if (settings.get('confirmOnClose') && !(await confirmClientInterruption('Close app', 'Close the app?'))) return;
      if (win) {
        allowClose = true;
        win.close();
      }
    })().catch(() => {}).finally(() => { confirmingClose = false; });
  });

  win.once('ready-to-show', () => {
    if (maximized) win.maximize();
    if (process.env.SHOWDOWN_DESKTOP_BACKGROUND === '1') win.showInactive();
    else win.show();
  });
  win.on('closed', () => {
    clearTimeout(windowSaveTimer);
    if (client && !client.webContents.isDestroyed()) client.webContents.close();
    replayReview?.close();
    replayReview = null;
    practice?.stop();
    practiceView?.close();
    practice = null;
    practiceView = null;
    win = null;
    client = null;
    allowClose = false;
  });
  const pages = { home: 'index.html', showdown: 'play.html', replays: 'replays.html' };
  win.loadFile(path.join(RENDERER_DIR, pages[settings.get('startPage')] || 'index.html'));
  ensureClient();
}

// Practice is set up on practice.html and played on practice-battle.html, its own tab.
function isPracticeFrame(event, pages = ['/practice.html', '/practice-battle.html']) {
  if (!isLauncherFrame(event)) return false;
  const sender = parseUrl(event.senderFrame.url)?.pathname || '';
  const shown = parseUrl(win.webContents.getURL())?.pathname || '';
  return pages.some(page => sender.endsWith(page) && shown.endsWith(page));
}
const isBattleFrame = event => isPracticeFrame(event, ['/practice-battle.html']);

ipcMain.handle('practice:status', async event => {
  if (!isLauncherFrame(event)) return null;
  const clientState = await practiceView.status();
  return { ...practice.status(), clientState: clientState.state, clientError: clientState.error, cloud: cloudEngine.status() };
});
// A team the Bots page picked: a Teambuilder team ({ source: 'teambuilder', index, name }) or a
// pasted export ({ source: 'paste', text }). Teambuilder teams are read here, never sent by the page.
async function practiceTeam(format, spec) {
  if (!spec || typeof spec !== 'object') return { ok: false, error: 'Choose a team.' };
  if (spec.source === 'paste') return practiceTeams.check(format, 'export', typeof spec.text === 'string' ? spec.text : '');
  if (spec.source !== 'teambuilder' || !Number.isSafeInteger(spec.index) || typeof spec.name !== 'string') {
    return { ok: false, error: 'Choose a team.' };
  }
  const teams = await bridge.teams(format);
  if (!teams) return { ok: false, error: "The Teambuilder isn't loaded yet. Try again in a moment." };
  const team = teams.find(value => value.index === spec.index && value.name === spec.name.slice(0, 80));
  if (!team) return { ok: false, error: 'This team is no longer in the Teambuilder. Choose another.' };
  return practiceTeams.check(format, 'packed', team.team);
}
const publicTeam = result => (result.ok ? { ok: true, species: result.species } : { ok: false, error: result.error, problems: result.problems });

ipcMain.handle('practice:teams', async (event, format) => {
  if (!isPracticeFrame(event, ['/practice.html']) || !Object.hasOwn(TEAM_FORMATS, format)) return null;
  const teams = await bridge.teams(format);
  return { ready: Boolean(teams), teams: (teams || []).map(({ index, name }) => ({ index, name })) };
});
ipcMain.handle('practice:check-team', async (event, value) => {
  if (!isPracticeFrame(event, ['/practice.html']) || !value || typeof value !== 'object' || !Object.hasOwn(TEAM_FORMATS, value.format)) {
    return { ok: false };
  }
  return publicTeam(await practiceTeam(value.format, value.team));
});
ipcMain.handle('practice:start', async (event, options) => {
  if (!isPracticeFrame(event) || !options || typeof options !== 'object') return { ok: false };
  const { opponent, preset, format } = options;
  if (format === undefined || format === 'gen9randombattle') return practice.start({ opponent, preset });
  if (!Object.hasOwn(TEAM_FORMATS, format) || !options.teams || typeof options.teams !== 'object') return { ok: false, error: 'Choose both teams first.' };
  const [player, bot] = await Promise.all([practiceTeam(format, options.teams.player), practiceTeam(format, options.teams.bot)]);
  if (!player.ok) return { ok: false, error: `Your team: ${player.error}`, side: 'player' };
  if (!bot.ok) return { ok: false, error: `Foul Play's team: ${bot.error}`, side: 'bot' };
  return practice.start({ opponent, preset, format, teams: { player: player.packed, bot: bot.packed, botExport: bot.exported } });
});
// Closing the battle's tab ends practice, and that tab can be closed from any launcher page.
// A battle still on is forfeited by stopping, so the launcher confirms first in its own popup
// under the battle's tab, then calls again with confirmed set.
ipcMain.handle('practice:stop', async (event, confirmed) => {
  if (!isLauncherFrame(event)) return { ok: false };
  if (practice.battle && !practice.battle.finished && confirmed !== true) return { ok: false, needsConfirm: true };
  return practice.stop();
});
ipcMain.handle('practice:show', (event, bounds) => {
  if (!isBattleFrame(event)) return { ok: false };
  return { ok: practiceView.show(bounds) };
});
// The client's header is hidden in practice, so Forfeit opens the client's own confirmation
// through the battle tab's (hidden) close button. Nothing is sent until the player confirms there.
ipcMain.handle('practice:forfeit', async event => {
  if (!isBattleFrame(event) || !practice.battle || practice.battle.finished || !practiceView.view) return { ok: false };
  try {
    const ok = await practiceView.view.webContents.executeJavaScript(`(() => {
      const id = window.app?.curRoom?.id || '';
      if (!/^battle-/.test(id)) return false;
      const close = [...document.querySelectorAll('button[name=closeRoom]')].find(button => button.value === id);
      if (!close) return false;
      close.click();
      return true;
    })()`);
    return { ok: Boolean(ok) };
  } catch { return { ok: false, error: 'Could not open the forfeit prompt.' }; }
});
ipcMain.handle('practice:next', async event => {
  if (!isBattleFrame(event) || !practice.battle?.finished || !practiceView.view) return { ok: false };
  try {
    const ok = await practiceView.view.webContents.executeJavaScript('Boolean(window.desktopPracticeStart?.())');
    return { ok };
  } catch { return { ok: false, error: 'Could not start another battle. Stop and try again.' }; }
});

ipcMain.on('client:show', (event, value) => {
  if (!isLauncherFrame(event)) return;
  if (maintenance && !client) return;
  const bounds = toBounds(value);
  if (!bounds) return;
  const view = ensureClient();
  view.setBounds(bounds);
  view.setVisible(true);
  if (cycleFocus) {
    cycleFocus = false;
    view.webContents.focus();
  }
});

ipcMain.handle('review:show', (event, bounds) => {
  const id = reviewNoteId(event);
  if (!id) return { ok: false, error: 'This saved replay note is unavailable.' };
  if (replayReview.status().noteId === id) return replayReview.show(bounds);
  const note = replays.get(id);
  if (!note) return { ok: false, error: 'This saved replay note is unavailable.' };
  hideClient();
  return replayReview.open(note, bounds);
});

ipcMain.handle('review:status', (event) => {
  const id = reviewNoteId(event);
  if (!id || replayReview.status().noteId !== id) return { ok: false, error: 'This saved replay note is unavailable.' };
  return replayReview.status();
});

ipcMain.handle('review:reload', (event) => {
  const id = reviewNoteId(event);
  if (!id || replayReview.status().noteId !== id) return { ok: false, error: 'This saved replay note is unavailable.' };
  return replayReview.reload();
});

ipcMain.on('client:hide', (event) => {
  if (isLauncherFrame(event)) hideClient();
});

ipcMain.handle('client:reload', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (maintenance) return { ok: false, error: 'Another operation is in progress.' };
  maintenance = true;
  try {
    if (!(await confirmClientInterruption('Reload client', 'Reload the Showdown client?'))) return { ok: true, cancelled: true };
    if (client) client.webContents.reload();
    logger.write('client-reload-requested');
    return { ok: true };
  } finally { maintenance = false; }
});

async function confirmClientInterruption(title, message) {
  const state = await Promise.race([
    bridge.session(), new Promise((resolve) => setTimeout(() => resolve({ ready: false }), 2000)),
  ]);
  const active = state.ready && (state.rooms.some((room) => room.battle && !room.ended &&
    state.me && room.players.includes(state.me)) || state.search.pending || state.search.formats.length);
  if (state.ready && !active) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', title, message,
    detail: active ? 'A battle or search is in progress. The connection will be interrupted.' :
      'The client state could not be checked. A battle or search may still be running.',
    buttons: ['Cancel', title], defaultId: 0, cancelId: 0, noLink: true,
  });
  return response === 1;
}

ipcMain.handle('showdown:snapshot', (event) => {
  if (!isLauncherFrame(event)) return { ready: false };
  return bridge.snapshot();
});

ipcMain.handle('showdown:session', async (event) => {
  if (!isLauncherFrame(event)) return { ready: false, rooms: [] };
  const state = await bridge.session();
  announce(messageAlerts.observe(state));
  return state;
});

// Challenges and messages that arrive while the app is in the background. In the foreground
// the rail and the challenge bar already show them.
function announce(alerts) {
  if (!alerts.length || !win || win.isDestroyed() || win.isFocused() || !settings.get('notifyMessages')) return;
  win.flashFrame(true);
  if (!Notification.isSupported()) return;
  for (const alert of alerts.slice(0, 3)) {
    // The client plays its own challenge sound.
    const notification = new Notification({ title: alert.title, body: alert.body, silent: alert.kind === 'challenge' });
    shownAlerts.add(notification);
    notification.on('click', () => openAlert(alert).catch(() => {}));
    notification.on('close', () => shownAlerts.delete(notification));
    notification.show();
  }
}

async function openAlert(alert) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // A challenge is answered from the bar on any page; a message opens its conversation,
  // unless leaving the current page would drop an unsaved replay note.
  if (alert.kind !== 'pm' || replayDirty || maintenance) return;
  if (await bridge.act('open-pm', { user: alert.user }) !== true || !win) return;
  if (!parseUrl(win.webContents.getURL())?.pathname.endsWith('/play.html')) win.loadFile(path.join(RENDERER_DIR, 'play.html'));
}

// leave-room answers 'needs-forfeit' for a battle the user is still playing; the launcher asks
// in its own popup under the tab and repeats the call with forfeit: true once confirmed.
ipcMain.handle('showdown:action', (event, action, args) => {
  if (!isLauncherFrame(event) || typeof action !== 'string') return false;
  return bridge.act(action, args);
});

async function confirmDiscardReplay() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', title: 'Unsaved replay note',
    message: 'Discard unsaved changes?',
    detail: 'Changes to this replay note have not been saved.',
    buttons: ['Keep editing', 'Discard changes'], defaultId: 0, cancelId: 0,
    noLink: true,
  });
  return response === 1;
}

ipcMain.handle('replays:list', (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  return replays.list();
});

ipcMain.handle('replays:save', (event, value) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  return replays.save(value);
});

ipcMain.handle('replays:export', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (exportingReplays) return { ok: false, error: 'An export is already in progress.' };
  exportingReplays = true;
  try {
    const current = replays.list();
    if (!current.ok) return current;
    const result = await dialog.showSaveDialog(win, {
      title: 'Export saved replay notes and links',
      defaultPath: path.join(app.getPath('documents'), `showdown-replay-notes-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'Replay notes (JSON)', extensions: ['json'] }],
      properties: ['showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { ok: true, cancelled: true };
    return replays.exportTo(result.filePath);
  } catch {
    return { ok: false, error: 'Could not export replay notes. Try again.' };
  } finally {
    exportingReplays = false;
  }
});

ipcMain.handle('replays:delete', async (event, id) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (!replays.get(id)) return { ok: false, error: 'Replay note not found.' };
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', title: 'Delete replay note', message: 'Delete this replay note?',
    detail: 'The local note will be deleted. The replay hosted by Showdown is kept. This cannot be undone.',
    buttons: ['Cancel', 'Delete note'], defaultId: 0, cancelId: 0, noLink: true,
  });
  return response === 1 ? replays.delete(id) : { ok: true, cancelled: true };
});

ipcMain.handle('replays:choose-import', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (choosingReplayImport) return { ok: false, error: 'An import file picker is already open.' };
  choosingReplayImport = true;
  try {
    const result = await dialog.showOpenDialog(win, {
      title: 'Import replay notes',
      filters: [{ name: 'Replay notes (JSON)', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths?.length || !isLauncherFrame(event)) {
      return { ok: true, cancelled: true };
    }
    return replayImports.previewFile(result.filePaths[0]);
  } catch {
    return { ok: false, error: 'Could not open the replay notes file. Try again.' };
  } finally { choosingReplayImport = false; }
});

ipcMain.handle('replays:commit-import', (event, token, choices) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (maintenance || undoingReplayImport) return { ok: false, error: 'Another operation is in progress.' };
  if (replayDirty) return { ok: false, error: 'Save your unsaved note before importing. Your changes have been kept.' };
  return replayImports.commit(token, choices);
});

ipcMain.handle('replays:cancel-import', (event, token) => {
  if (!isLauncherFrame(event)) return false;
  replayImports.cancel(token);
  return true;
});

ipcMain.handle('replays:import-status', (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  return replayImports.status();
});

ipcMain.handle('replays:undo-import', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (maintenance || undoingReplayImport) return { ok: false, error: 'Another operation is in progress.' };
  if (replayDirty) return { ok: false, error: 'Save your unsaved note before undoing an import. Your changes have been kept.' };
  if (!replayImports.status().canUndo) return { ok: false, error: 'This import can no longer be undone. Notes may have changed or the app was restarted.' };
  undoingReplayImport = true;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', title: 'Undo replay note import', message: 'Undo the last import?',
      detail: 'Restore your saved notes to exactly how they were before that import. The imported file is kept.',
      buttons: ['Keep imported notes', 'Undo import'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) return { ok: true, cancelled: true };
    if (maintenance || replayDirty) return { ok: false, error: 'Notes are being edited. Finish editing before undoing the import.' };
    return replayImports.undo();
  } catch {
    return { ok: false, error: 'Could not undo the import. Your notes were kept.' };
  } finally { undoingReplayImport = false; }
});

ipcMain.handle('replays:open', async (event, id) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  const note = replays.get(id);
  if (!note) return { ok: false, error: 'Replay note not found.' };
  try {
    await shell.openExternal(note.url);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Failed to open the replay in your browser.' };
  }
});

ipcMain.handle('replays:confirm-discard', (event) => {
  return isLauncherFrame(event) ? confirmDiscardReplay() : false;
});

ipcMain.on('replays:dirty', (event, dirty) => {
  if (isLauncherFrame(event) && new URL(event.senderFrame.url).pathname.endsWith('/replays.html') && typeof dirty === 'boolean') {
    replayDirty = dirty;
  }
});

ipcMain.handle('replays:draft', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  const session = await bridge.session();
  const battle = session.ready && session.rooms.find((room) => room.id === session.current && room.battle);
  if (!battle) return { ok: true, draft: null };
  // A room ID is not proof that a replay has been uploaded, and lacks private tokens.
  return { ok: true, draft: {
    title: (battle.players.filter(Boolean).join(' vs. ') || battle.title).slice(0, 120),
    format: /^battle-([a-z0-9]+)-\d+/.exec(battle.id)?.[1] || '',
    url: '',
  } };
});

ipcMain.handle('settings:get-theme', (event) => {
  if (!isLauncherFrame(event)) return null;
  return settings.get('theme');
});

ipcMain.handle('settings:get', (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (settings.loadError) return { ok: false, error: settings.loadError };
  return { ok: true, settings: settings.snapshot() };
});

ipcMain.handle('showdex:status', async (event) => {
  if (!isLauncherFrame(event)) return null;
  const enabled = settings.get('showdexEnabled');
  const status = showdexBundle.invalid ? 'failed' : !showdexBundle.installed ? 'not-installed' : !showdexApplied ? 'disabled' :
    showdexLoadFailed ? 'failed' : await bridge.showdexStatus();
  return {
    installed: showdexBundle.installed, enabled, loaded: status === 'loaded', status,
    pendingReload: showdexBundle.installed && enabled !== showdexApplied,
    error: status === 'failed' ? 'Showdex failed to load. Ordinary Showdown play is still available.' : '',
    version: showdexBundle.version,
  };
});

ipcMain.handle('settings:set', (event, key, value) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (maintenance) return { ok: false, error: 'Another operation is in progress.' };
  try {
    if (!settings.set(key, value)) return { ok: false, error: 'Invalid setting.' };
    nativeTheme.themeSource = settings.get('theme');
    return { ok: true, settings: settings.snapshot() };
  } catch {
    logger.write('settings-save-failed');
    return { ok: false, error: 'Settings could not be saved. Previous settings were kept.' };
  }
});

ipcMain.handle('settings:open-logs', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  logger.write('logs-opened');
  try {
    const error = await shell.openPath(logger.dir);
    return error ? { ok: false, error: 'Failed to open the logs folder.' } : { ok: true };
  } catch { return { ok: false, error: 'Failed to open the logs folder.' }; }
});

ipcMain.handle('settings:sign-out', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (maintenance) return { ok: false, error: 'Another operation is in progress.' };
  maintenance = true;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', title: 'Sign out of Showdown', message: 'Sign out and clear saved Showdown data?',
      detail: 'This disconnects battles and searches and removes local Showdown teams, preferences and login data. Export any teams you want to keep first. Replay notes are kept.',
      buttons: ['Cancel', 'Sign out and clear data'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) return { ok: true, cancelled: true };
    const old = ensureClient();
    const clientSession = old.webContents.session;
    const bounds = old.getBounds();
    const visible = old.getVisible();
    win.contentView.removeChildView(old);
    client = null;
    // Stop the client before clearing storage so it cannot write the login back.
    await new Promise((resolve) => {
      old.webContents.once('destroyed', resolve);
      old.webContents.close();
    });
    for (const popup of BrowserWindow.getAllWindows()) {
      if (popup !== win && popup.webContents.session === clientSession) popup.destroy();
    }
    try {
      await clientSession.clearStorageData();
      await clientSession.clearCache();
      await clientSession.clearAuthCache();
      bridge.ratings.clear();
      bridge.friendsCache.clear();
      logger.write('showdown-signed-out');
    } finally {
      const next = ensureClient();
      next.setBounds(bounds);
      next.setVisible(visible);
    }
    return { ok: true };
  } catch {
    logger.write('showdown-sign-out-failed');
    return { ok: false, error: 'Could not clear all Showdown data. Try again.' };
  } finally { maintenance = false; }
});

ipcMain.handle('settings:reset', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (maintenance) return { ok: false, error: 'Another operation is in progress.' };
  maintenance = true;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', title: 'Reset launcher data', message: 'Reset settings and delete all replay notes?',
      detail: 'Launcher preferences and unsaved notes will also be discarded. Your Showdown session and teams are kept. This cannot be undone.',
      buttons: ['Cancel', 'Reset launcher data'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) return { ok: true, cancelled: true };
    // Remove only the launcher's two data files, never the Showdown partition.
    settings.reset();
    fs.rmSync(path.join(app.getPath('userData'), 'replays.json'), { force: true });
    replayImports.reset();
    fs.rmSync(path.join(app.getPath('userData'), 'window-state.json'), { force: true });
    win.unmaximize();
    const defaultBounds = windowState.load(windowDisplays());
    win.setSize(defaultBounds.width, defaultBounds.height);
    win.center();
    nativeTheme.themeSource = settings.get('theme');
    await win.webContents.executeJavaScript('localStorage.clear(); sessionStorage.clear(); void 0');
    replayDirty = false;
    logger.write('launcher-data-reset');
    return { ok: true, settings: settings.snapshot() };
  } catch {
    logger.write('launcher-reset-failed');
    return { ok: false, error: 'Reset could not finish. Some launcher data may already have been cleared.' };
  } finally { maintenance = false; }
});

ipcMain.handle('settings:set-theme', (event, value) => {
  if (!isLauncherFrame(event)) return false;
  try {
    if (!settings.set('theme', value)) return false;
  } catch {
    return false;
  }
  nativeTheme.themeSource = value;
  return true;
});

nativeTheme.on('updated', () => {
  if (win) win.setBackgroundColor(background());
  if (client) client.setBackgroundColor(background());
  replayReview?.backgroundChanged(background());
  if (practiceView) {
    practiceView.background = background();
    practiceView.view?.setBackgroundColor(background());
  }
});

app.whenReady().then(async () => {
  logger = new Logger(app.getPath('userData'));
  logger.write('app-started');
  settings = new Settings(app.getPath('userData'));
  windowState = new WindowState(app.getPath('userData'));
  replays = new Replays(app.getPath('userData'));
  replayImports = new ReplayImports(replays);
  cloudEngine = new CloudEngine();
  try {
    showdexBundle = await showdex.registerAssets(electronSession.fromPartition(CLIENT_PARTITION));
  } catch {
    logger.write('showdex-assets-failed');
  }
  nativeTheme.themeSource = settings.get('theme');
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
