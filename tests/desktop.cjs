'use strict';
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';

// Simulated desktop smoke test. Never loads the user's profile or contacts Showdown.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
// Links leave for the system browser; record them instead of opening anything.
const openedExternally = [];
shell.openExternal = async (url) => { openedExternally.push(url); };
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-desktop-test-'));
app.setPath('userData', profile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  // The production partition name is safe inside this temporary userData directory.
  session.fromPartition('persist:showdown').webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/.test(details.url) });
  });
  require('../app/main');
  await until(() => BrowserWindow.getAllWindows().length, 'launcher window');
  const win = BrowserWindow.getAllWindows()[0];
  const renderer = win.webContents;
  await until(() => !renderer.isLoading() && renderer.getURL().endsWith('index.html'), 'initial page load');
  const client = win.contentView.children[0];
  const clientId = client.webContents.id;
  let current = { ready: true, connected: true, me: 'Tester', rooms: [], search: { pending: false, formats: [] }, popups: 0 };
  const snapshot = {
    ready: true, connected: true, user: { name: 'Tester', userid: 'tester', registered: true },
    counts: { users: 100, battles: 20 }, currentFormat: 'gen9randombattle',
    formats: [
      { id: 'gen9randombattle', name: '[Gen 9] Random Battle', section: 'Singles', presetTeam: true },
      { id: 'gen9ou', name: '[Gen 9] OU', section: 'Singles', presetTeam: false },
    ],
    teams: [{ index: 1, name: 'Selected team', format: 'gen9ou', sprites: [] }], news: [], rooms: [], ratings: {},
    friends: { available: true, items: [
      { userid: 'onlinefriend', name: 'Online Friend', online: true, status: 'online' },
      { userid: 'busyfriend', name: 'Busy Friend', online: true, status: 'busy' },
      { userid: 'offlinefriend', name: 'Offline Friend', online: false, status: 'offline' },
    ] },
  };
  ipcMain.removeHandler('showdown:session');
  ipcMain.handle('showdown:session', () => current);
  ipcMain.removeHandler('showdown:snapshot');
  ipcMain.handle('showdown:snapshot', () => ({ ...snapshot, connected: current.connected }));
  const run = (code) => renderer.executeJavaScript(code);
  const load = async (file) => {
    await win.loadFile(path.join(__dirname, '..', 'renderer', file));
    await pause(200);
  };
  const captures = path.join(__dirname, '..', 'out', 'desktop-smoke');
  fs.mkdirSync(captures, { recursive: true });
  const savedSettings = () => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));

  // First launch: no layout chosen yet, so Home asks once with previews of both.
  await load('index.html');
  await until(() => run("document.getElementById('welcome').open"), 'welcome on first launch');
  assert.deepEqual(await run("[...document.querySelectorAll('#welcome [data-layout]')].map((b) => b.dataset.layout)"), ['classic', 'modern']);
  assert.match(await run("document.getElementById('welcome').textContent"), /switch between them later in Settings/);
  assert.equal(await run("document.querySelectorAll('#welcome .layout-preview').length"), 2);
  win.showInactive();
  for (const theme of ['light', 'dark']) {
    await run(`window.desktop.setTheme('${theme}')`);
    await pause(250);
    fs.writeFileSync(path.join(captures, `welcome-${theme}.png`), (await renderer.capturePage()).toPNG());
  }
  await run("document.querySelector('#welcome [data-layout=modern]').click(); 0");
  await until(() => run("!document.getElementById('welcome').open && document.getElementById('hub').classList.contains('hub--modern')"), 'welcome choice applied');
  await until(() => { try { return savedSettings().homeLayout === 'modern'; } catch { return false; } }, 'welcome choice saved');
  // Never asked again: later launches go straight to the chosen layout.
  await load('index.html');
  await until(() => run("document.getElementById('hub').classList.contains('hub--modern')"), 'chosen layout on the next launch');
  await pause(300);
  assert.equal(await run("document.getElementById('welcome').open"), false, 'welcome not shown again');

  await until(() => run("!document.getElementById('battle').disabled"), 'Home ready');
  await until(() => run("document.getElementById('friends').textContent.includes('Busy Friend')"), 'friends rendered');
  assert.doesNotMatch(await run("document.getElementById('friends').textContent"), /Battling/);
  const actions = [];
  ipcMain.removeHandler('showdown:action');
  ipcMain.handle('showdown:action', (_event, action, args) => {
    actions.push({ action, args });
    // The simulated client follows focus changes, as the real one does.
    if (action === 'focus-room') current = { ...current, current: args.room };
    if (action === 'show-menu') current = { ...current, current: '', menuTab: args.tab };
    return true;
  });
  await run("document.getElementById('edit-team').click(); 0");
  await until(() => renderer.getURL().endsWith('/play.html'), 'random-format team list shortcut');
  assert.deepEqual(actions.pop(), { action: 'edit-team', args: { team: null } });
  await load('index.html');
  await until(() => run("!document.getElementById('format').disabled"), 'formats ready for team shortcut');
  await run("document.getElementById('format').value = 'gen9ou'; document.getElementById('format').dispatchEvent(new Event('change')); document.getElementById('edit-team').click(); 0");
  await until(() => renderer.getURL().endsWith('/play.html'), 'selected team shortcut');
  assert.deepEqual(actions.pop(), { action: 'edit-team', args: { team: 1, name: 'Selected team', format: 'gen9ou' } });

  // News: a post opens in place to its full text; its links, its page on the website and
  // All news open in the system browser, and Home stays put.
  snapshot.news = [{
    id: '123', date: 1763251200, title: 'Test post', text: 'Sign up now. More below.', author: 'Staff',
    body: [
      [{ text: 'Sign up now in the ' }, { text: 'tournament thread', href: 'https://www.smogon.com/forums/threads/1/' }, { text: '.' }],
      [{ text: 'Second paragraph that only the full post shows. Join ' }, { text: 'Cafe', href: 'https://play.pokemonshowdown.com/thecafe' }, { text: '.' }],
    ],
  }];
  await load('index.html');
  await until(() => run("!!document.querySelector('#news .post-toggle')"), 'news rendered');
  assert.equal(await run("document.querySelector('#news .post-body').hidden"), true, 'closed at first');
  await run("document.querySelector('#news .post-toggle').click(); 0");
  assert.equal(await run("document.querySelector('#news .post-body').hidden"), false, 'opens in place');
  assert.equal(await run("document.querySelector('#news .post-toggle').getAttribute('aria-expanded')"), 'true');
  assert.match(await run("document.querySelector('#news .post-body').textContent"), /Second paragraph that only the full post shows/);
  assert.equal(openedExternally.length, 0, 'opening a post never leaves the app');
  // Home re-reads regularly; the open post stays open.
  await pause(1500);
  assert.equal(await run("document.querySelector('#news .post-body').hidden"), false, 'still open after a refresh');
  await run("document.querySelector('#news .post-body p a').click(); 0");
  await until(() => openedExternally.length === 1, 'a link in the post opens in the browser');
  assert.deepEqual(openedExternally, ['https://www.smogon.com/forums/threads/1/']);
  await run("document.querySelector('#news .post-source').click(); 0");
  await until(() => openedExternally.length === 2, 'the post on the website opens in the browser');
  assert.equal(openedExternally[1], 'https://pokemonshowdown.com/news/123');
  await run("document.querySelector('a[href=\"https://pokemonshowdown.com/news\"]').click(); 0");
  await until(() => openedExternally.length === 3, 'All news opens in the browser');
  assert.equal(openedExternally[2], 'https://pokemonshowdown.com/news');
  assert.match(renderer.getURL(), /index\.html$/, 'Home stays open');
  win.showInactive();
  for (const theme of ['light', 'dark']) {
    await run(`window.desktop.setTheme('${theme}')`);
    await pause(250);
    fs.writeFileSync(path.join(captures, `home-news-open-${theme}.png`), (await renderer.capturePage()).toPNG());
  }
  await run("document.querySelector('#news .post-toggle').click(); 0");
  assert.equal(await run("document.querySelector('#news .post-body').hidden"), true, 'closes again');
  // A link to a Showdown room joins it in the app rather than opening the website.
  await run("document.querySelector('#news .post-toggle').click(); document.querySelector('#news [data-room=thecafe]').click(); 0");
  await until(() => actions.some((a) => a.action === 'join' && a.args.room === 'thecafe'), 'room link joins the room');
  await until(() => /play\.html$/.test(renderer.getURL()), 'room link opens the Showdown screen');
  assert.equal(openedExternally.length, 3, 'the room link did not open the browser');
  actions.length = 0;
  snapshot.news = [];

  // Chat room shortcuts: suggested from the busiest rooms until edited, then the player's own.
  snapshot.rooms = [
    { title: 'Lobby', desc: 'Chat', users: 600 }, { title: 'Help', desc: 'Questions', users: 120 },
    { title: 'Over Used', desc: 'OU talk', users: 200 },
  ];
  await load('index.html');
  await until(() => run("document.querySelectorAll('#rooms [data-room]').length === 3"), 'suggested rooms');
  assert.deepEqual(await run("[...document.querySelectorAll('#rooms [data-room]')].map((a) => a.dataset.room)"), ['lobby', 'overused', 'help']);
  await run("document.getElementById('rooms-edit').click(); 0");
  assert.equal(await run("document.getElementById('rooms-add').hidden"), false);
  await run("document.querySelector('[data-remove=lobby]').click(); 0");
  await run("document.getElementById('rooms-add-name').value = 'Tournaments'; document.getElementById('rooms-add').requestSubmit(); 0");
  await run("document.getElementById('rooms-add-name').value = 'help'; document.getElementById('rooms-add').requestSubmit(); 0");
  await run("document.getElementById('rooms-edit').click(); 0");
  assert.deepEqual(await run("[...document.querySelectorAll('#rooms [data-room]')].map((a) => a.dataset.room)"), ['overused', 'help', 'tournaments'], 'removed, added and de-duplicated');
  await load('index.html');
  await until(() => run("document.querySelectorAll('#rooms [data-room]').length === 3"), 'pinned rooms after reload');
  assert.deepEqual(await run("[...document.querySelectorAll('#rooms [data-room]')].map((a) => a.dataset.room)"), ['overused', 'help', 'tournaments']);
  await run("document.querySelector('#rooms [data-room=tournaments]').click(); 0");
  await until(() => actions.some((a) => a.action === 'join'), 'pinned room opens');
  assert.deepEqual(actions.pop(), { action: 'join', args: { room: 'tournaments' } });

  await load('index.html');
  current = { ...current, connected: false };
  await until(() => run("document.getElementById('battle').disabled"), 'disconnect disables search');
  current = { ...current, connected: true };
  await until(() => run("!document.getElementById('battle').disabled"), 'reconnect enables search');
  await load('play.html');
  await until(() => client.getVisible(), 'client shown');
  await until(async () => (await run("document.getElementById('connection-banner').hidden")) &&
    client.getBounds().height === await run("Math.round(document.querySelector('.client-view').getBoundingClientRect().height)"), 'connected view layout');
  assert.equal(client.webContents.id, clientId);
  const originalHeight = client.getBounds().height;
  current = { ...current, connected: false };
  await until(() => client.getBounds().height < originalHeight, 'disconnect banner adjusts native view');
  current = { ...current, connected: true };
  await until(() => client.getBounds().height === originalHeight, 'reconnect restores client bounds');
  await load('settings.html');
  assert.equal(client.getVisible(), false);
  for (const theme of ['dark', 'light']) {
    assert.equal(await run(`window.desktop.setTheme('${theme}')`), true);
    await until(() => run(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'}`), `${theme} theme`);
  }
  await load('play.html');
  assert.equal(client.webContents.id, clientId);
  await load('index.html');
  current = { ...current, rooms: [{ id: 'battle-test-1', title: 'Spectating', battle: true, ended: false, players: ['A', 'B'], format: 'Test' }] };
  await pause(3400);
  assert.match(renderer.getURL(), /index\.html$/);
  // Player identities can arrive after a battle room first appears.
  current = { ...current, rooms: [...current.rooms, { id: 'battle-test-2', title: 'Battle', battle: true, ended: false, players: [], format: 'Test' }] };
  await pause(3400);
  current = { ...current, rooms: current.rooms.map((room) => room.id.endsWith('-2') ? { ...room, players: ['Tester', 'Opponent'] } : room) };
  await until(() => /play\.html$/.test(renderer.getURL()), 'player battle auto-switch');
  // Launcher-owned room navigation: rail rows, top bar and the finished-battle bar.
  const detail = (extra) => ({ kind: 'battle', battle: true, formatId: 'gen9randombattle', turn: 3, unread: false, ended: false, ...extra });
  current = {
    ...current, named: true, current: 'battle-test-2', menuUnread: false,
    rooms: [
      detail({ id: 'battle-test-2', title: 'Battle', players: ['Tester', 'Opponent'], format: 'Random Battle' }),
      { id: 'lobby', title: 'Lobby', kind: 'chat', battle: false, players: [], format: '', formatId: '', ended: false, turn: null, unread: true },
    ],
  };
  await load('play.html');
  await until(() => run("document.querySelectorAll('[data-nav=rooms] .nav-room').length === 2"), 'rail rooms rendered');
  assert.equal(await run("document.querySelector('[data-nav=rooms] .nav-room[aria-current=page] .nav-room-title').textContent"), 'vs. Opponent');
  assert.deepEqual(await run("[...document.querySelectorAll('[data-nav=rooms] .nav-tab .nav-room-title')].map((n) => n.textContent)"), []);
  assert.equal(await run("document.querySelector('[data-nav=rooms] .nav-room-sub').textContent"), 'Random Battle · Turn 3');
  assert.equal(await run("document.querySelectorAll('[data-nav=rooms] .nav-unread').length"), 1);
  assert.equal(await run("document.querySelector('[data-nav=me]').textContent"), 'Tester');
  assert.equal(await run("document.getElementById('room-title').textContent"), 'vs. Opponent');
  assert.equal(await run("document.getElementById('room-format').textContent"), 'gen9randombattle');
  assert.equal(await run("document.getElementById('room-status').textContent"), 'Turn 3');
  assert.equal(await run("document.getElementById('save-note').hidden"), false);
  assert.equal(await run("document.getElementById('result-bar').hidden"), true);
  assert.equal(await run("!!document.querySelector('[data-action=reload-client]')"), false);
  actions.length = 0;
  await run("document.querySelector('[aria-label=\"Close Lobby\"]').click(); 0");
  await until(() => actions.some((a) => a.action === 'leave-room'), 'close sends leave-room');
  assert.deepEqual(actions.find((a) => a.action === 'leave-room'), { action: 'leave-room', args: { room: 'lobby' } });
  assert.match(renderer.getURL(), /play.html$/);
  await run("document.querySelector('[data-action=sounds]').click(); 0");
  await until(() => actions.some((a) => a.action === 'sounds'), 'sound button');
  current = { ...current, rooms: [detail({ ...current.rooms[0], ended: true }), current.rooms[1]] };
  await until(() => run("!document.getElementById('result-bar').hidden"), 'result bar for finished own battle');
  assert.equal(await run("document.getElementById('result-message').textContent"), 'Battle finished · vs. Opponent');
  assert.equal(await run("document.getElementById('room-status').textContent"), 'Finished');
  actions.length = 0;
  await pause(1500);
  assert.equal(actions.some((a) => a.action === 'search'), false, 'no search without a click');
  fs.mkdirSync(path.join(__dirname, '..', 'out', 'desktop-smoke'), { recursive: true });
  win.showInactive();
  for (const theme of ['light', 'dark']) {
    await run(`window.desktop.setTheme('${theme}')`);
    await pause(250);
    fs.writeFileSync(path.join(__dirname, '..', 'out', 'desktop-smoke', `play-${theme}.png`), (await renderer.capturePage()).toPNG());
  }
  await run("document.getElementById('result-again').click(); 0");
  await until(() => actions.some((a) => a.action === 'search'), 'Battle again search');
  assert.deepEqual(actions.find((a) => a.action === 'search'), { action: 'search', args: { format: 'gen9randombattle', team: null } });
  await until(() => /index.html$/.test(renderer.getURL()), 'Battle again returns to Home');

  // Challenges and private messages: a bar under the top bar on every page, conversations
  // under Messages in the rail, and the conversation view on the Showdown screen.
  const challenge = { userid: 'ashk', name: 'Ash_K', unread: false, active: false, last: '',
    challenge: { dir: 'in', format: 'gen9ou', formatName: '[Gen 9] OU', message: 'Ash_K wants to battle!',
      pending: false, needsTeam: true, team: 1, teams: [{ index: 1, name: 'Selected team' }] } };
  const pm = { userid: 'misty99', name: 'misty99', unread: true, active: false, last: 'gg! rematch later?', challenge: null };
  current = { ...current, messages: [challenge, pm] };
  await until(() => run("!!document.querySelector('.challenge-bars:not([hidden]) .banner--challenge-in')"), 'challenge bar on Home');
  assert.equal(await run("document.querySelector('.banner--challenge-in strong').textContent"), 'Ash_K challenges you to [Gen 9] OU');
  assert.deepEqual(await run("[...document.querySelectorAll('.rail-section--messages ~ .nav-room .nav-room-title')].map((n) => n.textContent)"), ['Ash_K', 'misty99']);
  win.showInactive();
  for (const theme of ['light', 'dark']) {
    await run(`window.desktop.setTheme('${theme}')`);
    await pause(250);
    fs.writeFileSync(path.join(__dirname, '..', 'out', 'desktop-smoke', `challenge-home-${theme}.png`), (await renderer.capturePage()).toPNG());
  }
  await load('play.html');
  await until(() => run("!!document.querySelector('.banner--challenge-in')"), 'challenge bar on play');
  await until(async () => client.getBounds().y === await run("Math.round(document.querySelector('.client-view').getBoundingClientRect().top)") &&
    client.getBounds().y > await run("Math.round(document.querySelector('.banner--challenge-in').getBoundingClientRect().bottom) - 1"), 'client view sits below the challenge bar');
  for (const theme of ['light', 'dark']) {
    await run(`window.desktop.setTheme('${theme}')`);
    await pause(250);
    fs.writeFileSync(path.join(__dirname, '..', 'out', 'desktop-smoke', `challenge-play-${theme}.png`), (await renderer.capturePage()).toPNG());
  }
  actions.length = 0;
  await run("[...document.querySelectorAll('.banner--challenge-in button')].find((b) => b.textContent === 'Accept').click(); 0");
  await until(() => actions.some((a) => a.action === 'answer-challenge'), 'Accept answers the challenge');
  assert.deepEqual(actions.find((a) => a.action === 'answer-challenge'), { action: 'answer-challenge', args: { user: 'ashk', answer: 'accept', team: 1 } });
  actions.length = 0;
  await run("[...document.querySelectorAll('.rail-section--messages ~ .nav-room .nav-room-main')][1].click(); 0");
  await until(() => actions.some((a) => a.action === 'open-pm'), 'conversation row opens the conversation');
  assert.deepEqual(actions.find((a) => a.action === 'open-pm'), { action: 'open-pm', args: { user: 'misty99' } });
  current = { ...current, current: '', menuTab: 'pm', pmOpen: 'ashk', messages: [{ ...challenge, active: true }, pm] };
  await until(() => run("document.getElementById('room-title').textContent === 'Ash_K'"), 'top bar names the conversation');
  assert.equal(await run("document.getElementById('room-status').textContent"), 'Private message');
  await until(() => run("document.querySelector('.challenge-bars').hidden"), 'no duplicate bar for the open conversation');
  assert.equal(await run("document.querySelector('.nav-room[aria-current=page] .nav-room-title').textContent"), 'Ash_K');
  // Back in a room: the client's bare main menu would hand the Showdown screen back to Home.
  current = { ...current, current: 'lobby', menuTab: 'battle', pmOpen: '', messages: [challenge, pm] };

  await load('play.html');
  win.setSize(1024, 640);
  await until(() => {
    try {
      const savedWindow = JSON.parse(fs.readFileSync(path.join(profile, 'window-state.json'), 'utf8'));
      const actual = win.getNormalBounds();
      return savedWindow.bounds.width === actual.width && savedWindow.bounds.height === actual.height;
    } catch { return false; }
  }, 'window bounds saved');
  await load('index.html');
  assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
  // The challenge bar fits the minimum window width.
  await until(() => run("!!document.querySelector('.banner--challenge-in')"), 'challenge bar at minimum width');
  assert.equal(await run("document.querySelector('.banner--challenge-in').scrollWidth <= document.querySelector('.banner--challenge-in').clientWidth"), true);
  fs.writeFileSync(path.join(__dirname, '..', 'out', 'desktop-smoke', 'challenge-home-1024.png'), (await renderer.capturePage()).toPNG());
  current = { ...current, messages: [] };
  await until(() => run("document.querySelector('.challenge-bars').hidden"), 'bar hides when the challenge is gone');
  // Both layouts at the minimum width and at a common laptop size, in both themes. Switching
  // in Settings is the same setting the welcome writes.
  win.showInactive();
  for (const layout of ['classic', 'modern']) {
    assert.equal((await run(`window.desktop.setSetting('homeLayout', '${layout}')`)).ok, true);
    for (const [width, height] of [[1024, 640], [1366, 768]]) {
      win.setSize(width, height);
      await load('index.html');
      await until(() => run(`document.getElementById('hub').classList.contains('hub--${layout}')`), `${layout} layout applied`);
      await until(() => run("!document.getElementById('battle').disabled"), `${layout} Home ready`);
      assert.equal(await run("document.getElementById('welcome').open"), false);
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, `${layout} ${width} horizontal overflow`);
      assert.equal(await run("document.getElementById('hub').scrollWidth <= document.getElementById('hub').clientWidth"), true, `${layout} ${width} hub overflow`);
      const visible = await run("['.hub-tiles', '.hero-links', '.hub-friends', '.hub-rooms', '.hub-news'].map((s) => getComputedStyle(document.querySelector(s)).display !== 'none')");
      assert.deepEqual(visible, layout === 'classic' ? [true, false, true, true, true] : [false, true, false, true, true], `${layout} panels`);
      if (layout === 'classic') {
        const [tiles, news, rooms, friends] = await run("['.hub-tiles', '.hub-news', '.hub-rooms', '.hub-friends'].map((s) => document.querySelector(s).getBoundingClientRect()).map((r) => [r.top, r.bottom])");
        assert.ok(Math.abs(rooms[1] - tiles[1]) <= 1 && Math.abs(friends[1] - tiles[1]) <= 1, 'chat rooms and friends end level with the tiles');
        assert.ok(news[0] < rooms[0] && rooms[0] - news[1] < 30, 'news sits over the lower pair');
      } else {
        const [hero, news, rooms] = await run("['.hero', '.hub-news', '.hub-rooms'].map((s) => document.querySelector(s).getBoundingClientRect()).map((r) => [r.left, r.right, r.width])");
        // Centered inside the hub's content area, which excludes any vertical scrollbar.
        const hubCenter = await run("(() => { const h = document.getElementById('hub'); return h.getBoundingClientRect().left + h.clientWidth / 2; })()");
        assert.ok(Math.abs((hero[0] + hero[1]) / 2 - hubCenter) <= 2, 'battle panel centered');
        assert.ok(Math.abs(news[2] / (news[2] + rooms[2]) - 0.7) < 0.03, 'news and chat rooms split 70/30');
        assert.equal(await run("[...document.querySelectorAll('.hero-team-grid > *')].every((n) => Math.abs(n.getBoundingClientRect().width - n.getBoundingClientRect().height) < 1)"), true, 'square team slots');
      }
      for (const theme of ['light', 'dark']) {
        await run(`window.desktop.setTheme('${theme}')`);
        await pause(250);
        fs.writeFileSync(path.join(captures, `home-${layout}-${width}-${theme}.png`), (await renderer.capturePage()).toPNG());
      }
    }
  }
  win.setSize(1024, 640);

  // Ctrl+Tab and Ctrl+Shift+Tab step through the tab strip from real key presses, whether
  // the focus is in the launcher page or in the Showdown client view.
  const press = (contents, shift) => {
    const modifiers = shift ? ['control', 'shift'] : ['control'];
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers });
  };
  const stripReady = () => until(() => run("document.querySelectorAll('[data-nav=rooms] .nav-page').length >= 1"), 'tab strip rendered');
  const titles = "[...document.querySelectorAll('[data-nav=rooms] .nav-item .nav-room-title')].map((n) => n.textContent)";
  // Community gets a tab once its view shows, and keeps it until closed.
  current = { ...current, current: '', menuTab: 'community' };
  await load('play.html');
  await until(() => run(`${titles}.includes('Community')`), 'Community tab appears with its view');
  current = { ...current, current: '', menuTab: 'battle' };
  await load('index.html');
  await stripReady();
  // No Battle tab: Home and the launcher pages, Community, then the open rooms.
  assert.deepEqual(await run(titles), ['Home', 'Settings', 'Community', 'vs. Opponent', 'Lobby']);
  press(renderer, false);
  await until(() => /settings\.html$/.test(renderer.getURL()), 'Ctrl+Tab opens the next tab');
  await stripReady();
  press(renderer, true);
  await until(() => /index\.html$/.test(renderer.getURL()), 'Ctrl+Shift+Tab opens the previous tab');
  await stripReady();
  actions.length = 0;
  press(renderer, true);
  await until(() => /play\.html$/.test(renderer.getURL()), 'Ctrl+Shift+Tab wraps from Home to the last tab');
  assert.deepEqual(actions.find((a) => a.action === 'focus-room'), { action: 'focus-room', args: { room: 'lobby' } });
  await until(() => client.getVisible(), 'client shown after Ctrl+Tab');
  await stripReady();
  // Inside the client view: Lobby, then the battle, then Community, then Settings.
  await until(() => run("document.querySelector('.nav-room[aria-current=page] .nav-room-title')?.textContent === 'Lobby'"), 'Lobby open');
  actions.length = 0;
  press(client.webContents, true);
  await until(() => actions.some((a) => a.action === 'focus-room'), 'Ctrl+Shift+Tab inside the client focuses the battle');
  assert.deepEqual(actions.pop(), { action: 'focus-room', args: { room: 'battle-test-2' } });
  await until(() => run("document.querySelector('.nav-room[aria-current=page] .nav-room-title')?.textContent === 'vs. Opponent'"), 'battle open');
  press(client.webContents, true);
  await until(() => actions.some((a) => a.action === 'show-menu'), 'then Community');
  assert.deepEqual(actions.pop(), { action: 'show-menu', args: { tab: 'community' } });
  await until(() => run("document.querySelector('.nav-page[aria-current=page] .nav-room-title')?.textContent === 'Community'"), 'Community open');
  press(client.webContents, true);
  await until(() => /settings\.html$/.test(renderer.getURL()), 'Ctrl+Shift+Tab inside the client view');
  assert.equal(client.getVisible(), false);
  await stripReady();
  // A plain Tab is not a tab switch.
  renderer.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  await pause(400);
  assert.match(renderer.getURL(), /settings\.html$/);

  // Ctrl+1 to Ctrl+9 jump to a tab; Ctrl+W and a middle click close one, but never Home.
  const chord = (contents, keyCode) => {
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['control'] });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['control'] });
  };
  chord(renderer, '1');
  await until(() => /index\.html$/.test(renderer.getURL()), 'Ctrl+1 opens Home');
  await stripReady();
  chord(renderer, 'W');
  await pause(500);
  assert.match(renderer.getURL(), /index\.html$/, 'Ctrl+W leaves Home open');
  assert.deepEqual(await run(titles), ['Home', 'Settings', 'Community', 'vs. Opponent', 'Lobby']);
  chord(renderer, '2');
  await until(() => /settings\.html$/.test(renderer.getURL()), 'Ctrl+2 opens the second tab');
  await stripReady();
  chord(renderer, 'W');
  await until(() => /index\.html$/.test(renderer.getURL()), 'Ctrl+W closes the open page tab');
  await stripReady();
  assert.deepEqual(await run(titles), ['Home', 'Community', 'vs. Opponent', 'Lobby']);
  chord(renderer, '2');
  await until(() => /play\.html$/.test(renderer.getURL()), 'Ctrl+2 opens Community');
  await until(() => client.getVisible(), 'client shown after Ctrl+2');
  await stripReady();
  actions.length = 0;
  chord(client.webContents, 'W');
  await until(() => /index\.html$/.test(renderer.getURL()), 'Ctrl+W closes Community and returns Home');
  assert.deepEqual(actions.filter((a) => a.action === 'show-menu'), [{ action: 'show-menu', args: { tab: 'battle' } }]);
  assert.equal(actions.some((a) => a.action === 'leave-room'), false);
  await stripReady();
  assert.deepEqual(await run(titles), ['Home', 'vs. Opponent', 'Lobby']);
  chord(renderer, '3');
  await until(() => /play\.html$/.test(renderer.getURL()), 'Ctrl+3 opens Lobby');
  await until(() => client.getVisible(), 'client shown after Ctrl+3');
  await until(() => run("document.querySelector('.nav-room[aria-current=page] .nav-room-title')?.textContent === 'Lobby'"), 'Lobby is the open tab');
  chord(client.webContents, 'W');
  await until(() => actions.some((a) => a.action === 'leave-room'), 'Ctrl+W inside the client closes the open room');
  assert.deepEqual(actions.filter((a) => a.action === 'leave-room'), [{ action: 'leave-room', args: { room: 'lobby' } }]);
  // Real middle clicks: on Home nothing happens, on a room it closes.
  const middle = async (selector) => {
    const { x, y } = await run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + 12), y: Math.round(r.top + r.height / 2) }; })()`);
    renderer.sendInputEvent({ type: 'mouseDown', x, y, button: 'middle', clickCount: 1 });
    renderer.sendInputEvent({ type: 'mouseUp', x, y, button: 'middle', clickCount: 1 });
  };
  actions.length = 0;
  await middle('[data-nav=rooms] .nav-page:not([aria-current])');
  await pause(400);
  assert.deepEqual(actions.filter((a) => a.action === 'leave-room'), [], 'a middle click leaves a fixed tab open');
  await middle('[data-nav=rooms] .nav-room:not([aria-current])');
  await until(() => actions.some((a) => a.action === 'leave-room'), 'a middle click closes a room tab');
  assert.deepEqual(actions.filter((a) => a.action === 'leave-room'), [{ action: 'leave-room', args: { room: 'battle-test-2' } }]);
  // The client's own main menu has no tab: the Showdown screen hands it back to Home.
  current = { ...current, current: '', menuTab: 'battle' };
  await until(() => /index\.html$/.test(renderer.getURL()), 'main menu returns to Home');
  assert.equal(client.getVisible(), false);

  console.log('PASS desktop smoke: first-launch welcome (asked once), both Home layouts, editable chat rooms, no Battle tab (main menu returns Home), connection, view bounds/survival, themes, spectating, delayed battle identity, launcher rail rooms, room top bar, result bar, challenge bar and conversations, minimum width, Ctrl+Tab, Ctrl+W, Ctrl+1-9, middle-click close');
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
