'use strict';
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';

// Real Practice battles against Foul Play in a disposable Electron profile: the app's simulator,
// the bridge, and a stand-in for the cloud inference API (the same server, on loopback with an
// API key). Needs a Foul Play install from `npm run api:setup` (api/runtime) or BOT_TEST_FOULPLAY_DIR.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
// This harness starts main only after its local inference service is listening. Protocol
// privileges still must be declared before Electron is ready, as in the normal app entry.
require('../app/showdex-integration').registerShowdexScheme(require('electron').protocol);

const root = path.join(__dirname, '..');
const captures = path.join(root, 'out', 'desktop-smoke');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-practice-test-'));
process.env.SHOWDOWN_DESKTOP_USER_DATA = profile;
app.setPath('userData', profile);
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const deadline = Date.now() + 240000;
const children = [];
const diagnose = process.argv.includes('--diagnose-practice');
const withShowdex = process.argv.includes('--showdex');
const foulPlayDir = path.resolve(process.env.BOT_TEST_FOULPLAY_DIR || path.join(root, 'api', 'runtime'));
const selection = { opponent: 'foulplay', preset: 'balanced' };
let service;
let statusRequests = 0;

async function until(check, label, timeout = 12000) {
  const end = Math.min(Date.now() + timeout, deadline);
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function recordPracticeLifecycle() {
  const originalSpawn = childProcess.spawn;
  const originalHandle = ipcMain.handle;
  childProcess.spawn = (executable, args, options) => {
    const child = originalSpawn(executable, args, options);
    const name = args.find(arg => typeof arg === 'string' && /[\\/](scripts[\\/]practice[\\/]server\.cjs|api[\\/]worker[\\/]foulplay_worker\.py)$/.test(arg));
    if (name) children.push(child);
    return child;
  };
  ipcMain.handle = (channel, listener) => originalHandle.call(ipcMain, channel,
    channel === 'practice:status' ? (...args) => { statusRequests++; return listener(...args); } : listener);
  try {
    const { inspect } = require('../api/install');
    if (!inspect(foulPlayDir).installed) throw new Error(`Foul Play is not installed in ${foulPlayDir}. Run npm run api:setup first.`);
    // The same server the cloud host runs, here on loopback with an API key.
    const { createApiServer } = require('../api/server');
    const key = require('node:crypto').randomBytes(32).toString('hex');
    service = createApiServer({ runtime: inspect(foulPlayDir), apiKey: key, maxThreads: 2 });
    process.env.SHOWDOWN_PRACTICE_API_URL = await service.listen();
    process.env.SHOWDOWN_PRACTICE_API_KEY = key;
    require('../app/main');
  } finally {
    childProcess.spawn = originalSpawn;
    ipcMain.handle = originalHandle;
  }
}

function blockNetwork(partition) {
  partition.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^(https?|wss?):/i.test(details.url) });
  });
}

function battleEval(contents, script) {
  return contents.executeJavaScript(`(() => {
    const room = Object.values(window.app?.rooms || {}).find(value =>
      /^battle-gen9randombattle-/.test(value.id) && value.side && value.battle && value.request);
    if (!room) return null;
    const control = (name) => [...room.el.querySelectorAll('button[name="' + name + '"]:enabled')]
      .find(button => button.getClientRects().length && getComputedStyle(button).visibility === 'visible');
    ${script}
  })()`);
}

async function capture(contents, name) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const screenshot = await contents.capturePage();
      if (!screenshot.isEmpty()) {
        if (name) fs.writeFileSync(path.join(captures, `foulplay-${name}.png`), screenshot.toPNG());
        return;
      }
    } catch (error) {
      if (!/UnknownVizError|display surface not available/i.test(error.message)) throw error;
    }
    await pause(250);
  }
  throw new Error(`Could not capture ${name}`);
}

async function smoke() {
  if (withShowdex) app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', details => {
      if (details.level === 'error' && contents.getURL().includes('practice-client.html')) {
        console.error(String(details.message).replace(/[a-f0-9]{32,128}/gi, '[session]'));
      }
    });
  });
  blockNetwork(session.defaultSession);
  blockNetwork(session.fromPartition('persist:showdown'));
  if (diagnose) {
    app.on('web-contents-created', (_event, contents) => {
      contents.on('console-message', details => {
        if (!contents.getURL().includes('practice-client.html')) return;
        const message = String(details.message).replace(/[a-f0-9]{32,128}/gi, '[session]');
        if (details.level === 'error') console.error(message);
        if (/^>> .*\|\/choose /.test(message)) console.error(message);
        if (/^<< /.test(message)) {
          const events = message.split('\n').flatMap(line => {
            const event = /^\|(error|turn|move|switch|request|-terastallize)\|/.exec(line);
            return event ? [event[1]] : [];
          });
          if (events.length) console.error(events.join(' '));
        }
      });
    });
  }
  let externalOpens = 0;
  shell.openExternal = async () => { externalOpens++; };
  let response = 0;
  const dialogs = [];
  dialog.showMessageBox = async (_win, options) => {
    dialogs.push(options);
    return { response };
  };
  await recordPracticeLifecycle();

  const win = await until(() => BrowserWindow.getAllWindows()[0], 'launcher window');
  const renderer = win.webContents;
  if (diagnose) renderer.on('did-start-navigation', (details, url, sameDocument, main) => {
    console.error('Launcher navigation', path.basename(details.url || url),
      details.isSameDocument ?? sameDocument, details.isMainFrame ?? main);
  });
  const run = (script) => renderer.executeJavaScript(script);
  const call = (method, ...args) => run(`window.desktop[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const status = () => call('getPractice');
  const load = (page) => win.loadFile(path.join(root, 'renderer', page));
  await until(() => !renderer.isLoading() && renderer.getURL().endsWith('/index.html'), 'Home');
  const live = win.contentView.children[0];
  const liveId = live.webContents.id;
  const practice = () => win.contentView.children.find(view => view !== live);
  assert.equal((await call('startPractice', 'balanced')).ok, false, 'Home cannot start Practice');
  if (withShowdex) assert.equal((await call('installShowdex')).ok, true, 'install optional Showdex for practice');

  await load('practice.html');
  await until(async () => (await status()).installed, 'practice runtime ready');
  assert.equal((await status()).state, 'idle');
  fs.mkdirSync(captures, { recursive: true });
  // The cloud is the default; local Foul Play is an opt-in that nothing downloads unasked.
  const initial = await status();
  assert.equal(initial.engineChoice, 'cloud', 'cloud engine by default');
  assert.equal(initial.local.installing, false, 'no download until the player asks');
  await capture(renderer, 'setup');
  assert.equal((await call('startPractice', selection)).ok, true);
  // The battle plays in its own tab; the setup page never shows the battle client.
  await load('practice-battle.html');
  assert.equal(await run(`[...document.querySelectorAll('[data-nav="rooms"] .nav-page')]
    .some(tab => tab.title === 'Bot battle' && tab.getAttribute('aria-current') === 'page')`), true, 'battle tab open and current');
  await until(async () => {
    const state = await status();
    if (state.error || state.clientError) throw new Error(state.error || state.clientError);
    return state.state === 'ready' && practice();
  }, 'practice session ready', 47000);
  const view = practice();
  const player = view.webContents;
  const playerId = player.id;
  await until(() => !player.isLoading() && player.getURL().startsWith('file:'), 'battle client document');
  assert.equal(new URL(player.getURL()).pathname.endsWith('/practice-client.html'), true);
  assert.notEqual(player.session, live.webContents.session);
  const preferences = player.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.preload, undefined);
  assert.equal(await player.executeJavaScript('typeof window.desktop'), 'undefined');
  assert.equal(await player.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await player.executeJavaScript(`(() => {
    const url = new URL(window.Config.practiceSocketUrl);
    return url.protocol === 'ws:' && url.hostname === '127.0.0.1' && url.pathname.endsWith('/websocket');
  })()`), true);
  assert.equal(live.getVisible(), false);
  assert.equal(await player.executeJavaScript("getComputedStyle(document.getElementById('header')).display"), 'none',
    'the client header and its closable room tabs are hidden');
  const roomId = await until(async () => {
    const state = await status();
    if (state.error || state.clientError) throw new Error(state.error || state.clientError);
    if (await player.executeJavaScript("document.documentElement.dataset.practiceState === 'failed'")) {
      throw new Error('Local battle client reported failure');
    }
    const browserRoom = await battleEval(player, "return control('chooseMove') ? room.id : null;");
    return state.battle?.room === browserRoom && view.getVisible() ? browserRoom : null;
  }, 'real battle with a move request', 18000);
  assert.equal(children.length, 2, 'simulator and Foul Play worker started');
  if (withShowdex) {
    await until(() => player.executeJavaScript("window.__SHOWDOWN_DESKTOP_SHOWDEX?.state === 'loaded'"), 'Showdex loaded in practice', 30000).catch(async error => {
      console.error('Practice Showdex status', await player.executeJavaScript('({status:window.__SHOWDOWN_DESKTOP_SHOWDEX, requested:window.__SD_SHOWDEX_REQUESTED, app:typeof app, host:window.__SHOWDEX_HOST, rooms:Object.keys(app.rooms), scripts:[...document.scripts].filter(s=>s.src.startsWith("showdex:")).map(s=>s.src)})'));
      throw error;
    });
    await until(() => player.executeJavaScript("!!document.querySelector('.sd-showdex-dock-toggle')"), 'practice calculator');
    await player.executeJavaScript(`(() => {
      const button = document.querySelector('.sd-showdex-dock-toggle');
      if (button.getAttribute('aria-pressed') !== 'true') button.click();
    })()`);
    const damage = await until(() => player.executeJavaScript(`(() => {
      const calc = document.querySelector('.sd-calcdex-docked [data-showdex-module=calcdex]');
      if (!calc) return null;
      const ranges = [...calc.querySelectorAll('[class*="PokeMoves-module-damageButtonLabel--"]')]
        .map(n => n.textContent.trim()).filter(text => /\\d+(?:\\.\\d+)?\\s*-\\s*\\d+(?:\\.\\d+)?%/.test(text));
      return ranges.length ? ranges : null;
    })()`), 'actual practice damage ranges', 20000);
    console.log('Practice Showdex damage ranges:', damage);
    assert.ok(damage.some(range => /[1-9]/.test(range)), 'nonzero computed damage');
    await capture(player, 'showdex-first-turn');
    assert.equal(await player.executeJavaScript(`(() => {
      const room = app.curRoom.el;
      const field = room.querySelector('.battle').getBoundingClientRect();
      const log = room.querySelector('.battle-log').getBoundingClientRect();
      const calc = document.querySelector('.sd-calcdex-docked').getBoundingClientRect();
      return log.left >= field.right && calc.left >= log.right && calc.right <= innerWidth;
    })()`), true, 'practice order: battle, log, Showdex');
  }

  const firstMove = await battleEval(player, `
    const move = control('chooseMove');
    if (!move) return null;
    const tera = room.el.querySelector('input[name="terastallize"]:enabled');
    const initial = { turn: room.battle.turn, move: move.dataset.move,
      queued: room.battle.stepQueue.length, tera: Boolean(tera?.getClientRects().length) };
    if (initial.tera && !tera.checked) tera.click();
    move.click();
    return initial;
  `);
  assert.ok(firstMove?.move, 'clicked an enabled upstream move button');
  await until(() => battleEval(player, `
    const player = room.side + 'a:';
    const events = room.battle.stepQueue.slice(${firstMove.queued});
    return room.battle.turn > ${firstMove.turn} ||
      events.some(line => line.startsWith('|move|' + player) || line.startsWith('|cant|' + player)) ||
      room.request.requestType === 'switch';
  `), 'server processed the human move').catch(async error => {
    if (diagnose) {
      const state = await status();
      console.error('Foul Play state', { turn: state.battle?.turn, elapsed: state.battle?.elapsedMs });
      console.error('Browser battle state', await battleEval(player, `
        return { turn: room.battle.turn, rqid: room.request.rqid, type: room.request.requestType,
          choice: room.choice, position: room.battle.currentStep, queued: room.battle.stepQueue.length };
      `));
    }
    throw error;
  });
  if (firstMove.tera) {
    await until(() => battleEval(player, `
      return room.battle.stepQueue.slice(${firstMove.queued})
        .some(line => line.startsWith('|-terastallize|' + room.side + 'a:'));
    `), 'server reported the human Terastallization');
  }
  await until(async () => (await status()).battle?.elapsedMs > 0, 'Foul Play submitted a searched move');

  const firstSwitch = await until(() => battleEval(player, `
    const button = control('chooseSwitch');
    const active = room.request.side?.pokemon?.find(mon => mon.active)?.ident;
    if (!button || !active) return null;
    button.click();
    return { active, turn: room.battle.turn };
  `), 'clicked an enabled upstream switch button').catch(async error => {
    console.error('Practice switch state', await battleEval(player, `return {
      turn:room.battle.turn, ended:room.battle.ended, request:room.request.requestType,
      trapped:room.request.active?.[0]?.trapped, choice:room.choice,
      buttons:[...room.el.querySelectorAll('button[name="chooseSwitch"]')].map(n=>({
        label:n.textContent, disabled:n.disabled, visible:!!n.getClientRects().length}))
    };`));
    await capture(player, 'switch-timeout');
    throw error;
  });
  await until(() => battleEval(player, `
    const active = room.request.side?.pokemon?.find(mon => mon.active)?.ident;
    return Boolean(active && active !== ${JSON.stringify(firstSwitch.active)});
  `), 'server processed the human switch');
  await until(() => battleEval(player, "return Boolean(control('chooseMove') || control('chooseSwitch'));"), 'next human decision');

  await load('index.html');
  await until(() => !view.getVisible(), 'Practice hides on Home');
  assert.equal((await status()).battle.room, roomId);
  assert.equal(player.isAudioMuted(), true);
  assert.equal(player.isDestroyed(), false);
  await load('play.html');
  await until(() => live.getVisible(), 'live Showdown view restored');
  assert.equal(live.webContents.id, liveId);
  assert.equal(view.getVisible(), false);
  await load('practice.html');
  await pause(500);
  assert.equal(view.getVisible(), false, 'the setup page does not show the battle');
  assert.equal(await run("!document.getElementById('practice-go').hidden && [...document.querySelectorAll('.bot-play')].every(play => play.disabled)"), true,
    'the setup page leads back to the running battle');
  await load('practice-battle.html');
  await until(() => view.getVisible(), 'Practice returns');
  assert.equal(practice().webContents.id, playerId);
  assert.equal((await status()).battle.room, roomId);
  assert.equal(await battleEval(player, 'return room.id;'), roomId);
  assert.equal(live.getVisible(), false);
  assert.equal(live.webContents.id, liveId);

  // Transparent background test windows can pause Showdex's color transitions.
  // Paint a real visible surface before checking themes and capturing evidence.
  win.setOpacity(1);
  win.setFocusable(true);
  win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  fs.mkdirSync(captures, { recursive: true });
  const turnBeforeResize = await battleEval(player, 'return room.battle.turn;');
  const layoutFailures = [];
  for (const [width, height] of [[1366, 768], [1024, 640]]) {
    win.setSize(width, height);
    await until(async () => {
      const [actualWidth, actualHeight] = win.getSize();
      const content = win.getContentBounds();
      const viewport = await run('({ width: innerWidth, height: innerHeight })');
      return Math.abs(actualWidth - width) <= 2 && Math.abs(actualHeight - height) <= 2 &&
        Math.abs(viewport.width - content.width) <= 2 && Math.abs(viewport.height - content.height) <= 2;
    }, `launcher resized to ${width}×${height}`).catch(async error => {
      if (diagnose) console.error('Window size', win.getSize(), win.getContentBounds(),
        await run('({ width: innerWidth, height: innerHeight })'));
      throw error;
    });
    for (const theme of ['light', 'dark']) {
      assert.equal(await call('setTheme', theme), true);
      await until(async () => {
        const expected = await run(`(() => {
          const rect = document.getElementById('battle-area').getBoundingClientRect();
          return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
        })()`);
        const bounds = view.getBounds();
        return Object.keys(expected).every(key => bounds[key] === expected[key]) &&
          (await player.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches")) === (theme === 'dark');
      }, `local client fits ${width}px in ${theme}`);
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
      assert.equal(await battleEval(player, 'return room.battle.turn;'), turnBeforeResize);
      assert.equal(practice().webContents.id, playerId);
      await pause(250);
      if (withShowdex) {
        const chrome = await until(() => player.executeJavaScript(`(() => {
          const root = document.querySelector('.sd-calcdex-docked [data-showdex-module=calcdex]');
          const moves = root?.querySelector('[class*="PokeMoves-module-container--"]');
          const damage = moves?.querySelector('[class*="PokeMoves-module-damageButtonLabel--"]');
          if (!damage) return null;
          const probe = document.createElement('span');
          root.append(probe);
          const color = token => { probe.style.color = 'var(' + token + ')'; return getComputedStyle(probe).color; };
          const result = { background: getComputedStyle(moves).backgroundColor,
            color: getComputedStyle(damage).color, panel: color('--sd-panel'), text: color('--sd-text'),
            rootBackground: getComputedStyle(root, '::before').backgroundColor, app: color('--sd-app') };
          probe.remove();
          return result.background === result.panel && result.rootBackground === result.app ? result : null;
        })()`), `${theme} practice calculator finished its color transition`);
        assert.ok(chrome, 'practice calculator remains available');
        assert.equal(chrome.background, chrome.panel, `${theme} practice damage panel follows theme`);
        assert.equal(chrome.color, chrome.text, `${theme} practice damage ranges follow theme`);
        assert.equal(chrome.rootBackground, chrome.app, `${theme} practice calculator follows theme`);
      }
      await until(() => battleEval(player, `return [...room.el.querySelectorAll('.innerbattle img')].some(img => img.naturalWidth > 0);`), 'official battle artwork loaded', 30000);
      const layout = await battleEval(player, `
        const box = element => {
          if (!element) return null;
          const {left, right, top, bottom, width, height} = element.getBoundingClientRect();
          return {left, right, top, bottom, width, height};
        };
        const choiceBox = (choice, menu) => {
          if (!control(choice)) control(menu)?.click();
          return box(control(choice));
        };
        const switchChoice = choiceBox('chooseSwitch', 'selectSwitch');
        const moveChoice = choiceBox('chooseMove', 'selectMove');
        const field = room.el.querySelector('.battle');
        const scene = field?.querySelector('.innerbattle');
        const backdrop = scene?.querySelector('.backdrop');
        return { width: innerWidth, height: innerHeight, room: box(room.el), moveChoice, switchChoice,
          expectMove: room.request.requestType === 'move',
          expectSwitch: Boolean(room.el.querySelector('button[name=chooseSwitch]:enabled')),
          field: box(field), log: box(room.el.querySelector('.battle-log')),
          logButton: box(control('showChat')), hp: scene?.querySelectorAll('.statbar .hp').length ?? 0,
          sprites: [...(scene?.querySelectorAll('img') ?? [])].filter(img => img.naturalWidth > 0).length,
          backdrop: backdrop ? getComputedStyle(backdrop).backgroundImage !== 'none' : false };
      `);
      const withinView = rect => rect?.width > 0 && rect.height > 0 && rect.left >= -1 &&
        rect.right <= layout.width + 1 && rect.top >= -1 && rect.bottom <= layout.height + 1;
      if ((!layout.expectMove && !layout.expectSwitch) ||
          (layout.expectMove && !withinView(layout.moveChoice)) ||
          (layout.expectSwitch && !withinView(layout.switchChoice)) ||
          !withinView(layout.field) || !layout.hp ||
          !layout.sprites || !layout.backdrop || !(layout.log?.height || withinView(layout.logButton))) {
        layoutFailures.push({ windowWidth: width, theme, ...layout });
      }
      for (const [surface, contents] of [['shell', renderer], ['battle', player]]) {
        // Wait for the compositor as well as computed styles before keeping a capture.
        await capture(contents);
        await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        await pause(300);
        await capture(contents, `practice-${width}-${theme}-${surface}`);
      }
    }
  }

  // A battle still on needs the launcher's own confirmation; no Windows dialog is used.
  assert.deepEqual(await call('stopPractice'), { ok: false, needsConfirm: true });
  assert.equal((await status()).battle.room, roomId);
  assert.equal(practice().webContents.id, playerId);
  assert.ok(children.every(child => !childExited(child)));
  assert.equal((await call('stopPractice', true)).ok, true);
  assert.equal(dialogs.length, 0, 'no native dialogs');
  await until(() => !practice() && player.isDestroyed(), 'Practice view disposed');
  await until(() => children.every(childExited), 'simulator and worker exited');
  assert.equal((await status()).state, 'idle');
  assert.equal(live.webContents.id, liveId);
  assert.equal(externalOpens, 0);
  assert.deepEqual(layoutFailures, [], 'Battlefield, sprites, HP, log and action controls remain visible or reachable');

  const waitForBattle = label => until(async () => {
    const state = await status();
    if (state.error || state.clientError) throw new Error(state.error || state.clientError);
    const current = practice();
    if (!current || !state.battle || state.clientState !== 'battle' || !current.getVisible()) return null;
    return (await battleEval(current.webContents, 'return room.id;')) === state.battle.room ? current : null;
  }, label, 27000);
  assert.equal((await call('startPractice', selection)).ok, true, 'restart after Stop');
  const restarted = await waitForBattle('new battle after Stop');
  const restartedPlayer = restarted.webContents;
  const forfeitedRoom = (await status()).battle.room;
  assert.notEqual(restartedPlayer.id, playerId);
  assert.equal(children.length, 4);
  await until(() => run(`(() => {
    const forfeit = document.getElementById('battle-forfeit');
    if (forfeit.hidden || forfeit.disabled) return false;
    forfeit.click();
    return true;
  })()`), 'clicked Forfeit on the battle tab');
  await until(() => restartedPlayer.executeJavaScript(`
    (() => {
      const popup = [...document.querySelectorAll('.ps-popup')].find(element =>
        element.textContent.includes('Forfeiting makes you lose the battle.'));
      const submit = popup?.querySelector('button[type=submit]');
      if (!submit) return false;
      if (popup.querySelector('input[name=closeroom]:checked')) throw new Error('Practice Forfeit would close the room');
      submit.click();
      return true;
    })()
  `), 'confirmed the actual battle forfeit');
  await until(async () => {
    const state = await status();
    return state.battle?.room === forfeitedRoom && state.battle.finished &&
      state.battle.result === 'loss' && state.clientState === 'finished';
  }, 'forfeit ended the battle and kept the room');
  await until(() => run("!document.getElementById('review-offer').hidden"), 'finished battle offers review');
  await run("document.getElementById('offer-open').click()");
  await until(() => renderer.getURL().endsWith('/battle-review.html'), 'reviewed actual practice player log');
  const completedReview = await call('getBattleReview');
  assert.equal(completedReview.ok, true);
  assert.ok(completedReview.report.players[completedReview.side]);
  assert.ok(completedReview.report.winner);
  await load('practice-battle.html');
  await until(() => restarted.getVisible(), 'finished battle survived review');
  await until(() => run("!document.getElementById('battle-review-prompt').hidden && document.getElementById('review-offer').hidden"), 'old battle keeps review action without repeating the offer');
  await until(() => run(`(() => {
    const next = document.getElementById('battle-next');
    if (next.hidden || next.disabled) return false;
    next.click();
    return true;
  })()`), 'clicked New battle after forfeiting');
  await until(async () => {
    const state = await status();
    if (state.error || state.clientError) throw new Error(state.error || state.clientError);
    return state.battle?.room !== forfeitedRoom && !state.battle?.finished && state.clientState === 'battle' &&
      (await battleEval(restartedPlayer, 'return room.id;')) === state.battle?.room;
  }, 'a distinct rematch opened on the same view');
  assert.equal(practice().webContents.id, restartedPlayer.id);
  assert.equal(children.length, 4, 'rematch reuses the simulator and worker');

  restartedPlayer.forcefullyCrashRenderer();
  await until(async () => (await status()).state === 'failed', 'renderer crash reported as a Practice failure');
  await until(() => !practice() && restartedPlayer.isDestroyed(), 'crashed Practice view disposed');
  await until(() => children.every(childExited), 'both restarted runtime children exited after the crash');
  assert.equal(live.webContents.id, liveId);
  assert.equal(live.webContents.isDestroyed(), false);

  assert.equal((await call('startPractice', selection)).ok, true, 'restart after renderer crash');
  const hiddenView = await waitForBattle('new battle after renderer crash');
  const hiddenPlayer = hiddenView.webContents;
  const hiddenChildren = children.slice(4);
  assert.equal(hiddenChildren.length, 2);
  assert.ok(hiddenChildren.every(child => !childExited(child)));
  await load('index.html');
  await until(() => !hiddenView.getVisible(), 'Practice hidden on Home before disconnect');
  // Home checks once whether the battle tab still has a session; it does not keep polling Practice.
  await pause(1500);
  const homeRequests = statusRequests;
  assert.equal(await hiddenPlayer.executeJavaScript(`(() => {
    if (window.app?.socket?.readyState !== WebSocket.OPEN) return false;
    window.app.socket.close();
    return true;
  })()`), true, 'closed only the hidden player socket');
  await until(() => !practice() && hiddenPlayer.isDestroyed(), 'disconnected hidden view disposed');
  await until(() => hiddenChildren.every(childExited), 'both runtime children exited after hidden disconnect');
  assert.equal(statusRequests, homeRequests, 'Home made no Practice status requests during cleanup');
  assert.ok(win.isVisible() && renderer.getURL().endsWith('/index.html'), 'Home stayed visible');
  assert.equal(live.webContents.id, liveId);
  assert.equal(live.webContents.isDestroyed(), false);

  // Closing the battle tab ends practice and returns to the tab on its left, never a blank page.
  await load('practice.html');
  assert.equal((await call('startPractice', selection)).ok, true, 'start for the tab close check');
  await load('practice-battle.html');
  const closingPlayer = (await waitForBattle('battle before closing its tab')).webContents;
  await run(`[...document.querySelectorAll('[data-nav="rooms"] .nav-page')].find(tab => tab.title === 'Bot battle')
    .querySelector('.nav-close').click(); 0`);
  // The forfeit popup opens under the tab; Cancel keeps the battle, Forfeit ends practice.
  await until(() => run("Boolean(document.querySelector('.forfeit-ask'))"), 'forfeit popup');
  await run("document.querySelector('.forfeit-ask-no').click(); 0");
  await pause(300);
  assert.equal((await status()).state, 'ready', 'Cancel keeps playing');
  assert.ok(renderer.getURL().endsWith('/practice-battle.html'));
  await run(`[...document.querySelectorAll('[data-nav="rooms"] .nav-page')].find(tab => tab.title === 'Bot battle')
    .querySelector('.nav-close').click(); 0`);
  await until(() => run("Boolean(document.querySelector('.forfeit-ask'))"), 'forfeit popup again');
  await run("document.querySelector('.forfeit-ask-yes').click(); 0");
  await until(() => renderer.getURL() && !renderer.getURL().endsWith('/practice-battle.html') && !renderer.isLoading(), 'left the closed battle tab');
  await until(async () => (await status()).state === 'idle' && closingPlayer.isDestroyed(), 'closing the tab ended practice');
  assert.equal(await run(`[...document.querySelectorAll('[data-nav="rooms"] .nav-page')].some(tab => tab.title === 'Bot battle')`), false,
    'battle tab removed');
  console.log(`PASS Practice desktop (Foul Play): real loopback battle, move and switch, ${firstMove.tera ? 'server-confirmed Tera' : 'Tera unavailable'}, view retention, size/theme captures, Stop, Forfeit and rematch, crash and hidden disconnect cleanup, battle tab close`);
}

app.whenReady().then(smoke).then(async () => { await service?.close(); app.exit(0); }, async error => {
  console.error(error);
  for (const child of children) {
    if (!childExited(child)) child.kill();
  }
  const end = Date.now() + 1500;
  while (children.some(child => !childExited(child)) && Date.now() < end) await pause(50);
  await service?.close();
  app.exit(1);
});
