'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'nav.js'), 'utf8');

function session(rooms, extra = {}) {
  return { ready: true, connected: true, me: 'Player', named: true, current: '', menuUnread: false, rooms, search: { pending: false, formats: [] }, popups: 0, ...extra };
}

function room(id, players = ['', ''], extra = {}) {
  return { id, title: 'Battle', kind: 'battle', battle: true, players, format: 'Gen 9 OU', formatId: 'gen9ou', ended: false, turn: null, unread: false, ...extra };
}

function chat(id, title, extra = {}) {
  return { id, title, kind: 'chat', battle: false, players: [], format: '', formatId: '', ended: false, turn: null, unread: false, ...extra };
}

class Node {
  constructor(tag) {
    this.tag = tag;
    this.className = '';
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.textContent = '';
    this.innerHTML = '';
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  has(cls) { return this.className.split(' ').includes(cls); }
  querySelectorAll(selector) {
    const tags = selector.split(',').map((t) => t.trim());
    const out = [];
    const walk = (node) => node.children.forEach((c) => {
      if (!(c instanceof Node)) return;
      if (tags.includes(c.tag)) out.push(c);
      walk(c);
    });
    walk(this);
    return out;
  }
  find(predicate) {
    if (predicate(this)) return this;
    for (const c of this.children) {
      const hit = c instanceof Node && c.find(predicate);
      if (hit) return hit;
    }
    return null;
  }
  click() {
    const event = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    if (this.listeners.click) this.listeners.click(event);
    return event;
  }
}

function harness(states, { onPlay = false, saved = new Map(), act = async () => true, page = 'index.html' } = {}) {
  const timers = [];
  const events = [];
  const calls = [];
  const nav = {};
  for (const name of ['rooms', 'sign-in', 'account', 'me', 'teambuilder', 'community']) nav[name] = new Node('x');
  nav['sign-in'].hidden = true;
  nav.account.hidden = true;
  let href = onPlay ? 'play.html' : page;
  const navigations = [];
  const location = { get href() { return href; }, set href(value) { href = value; navigations.push(value); } };
  // The challenge bars are inserted after the top bar; the fake records what lands there.
  const topbar = new Node('header');
  const currentPage = onPlay ? null : new Node('a');
  const after = [];
  topbar.after = (node) => after.push(node);
  const document = {
    body: { dataset: onPlay ? { page: 'play' } : {} },
    querySelector: (selector) => {
      if (selector === '.rail a.nav-item[aria-current="page"]') return currentPage;
      if (selector === '.main > .topbar') return topbar;
      const match = /data-nav="(.+)"/.exec(selector);
      return match ? nav[match[1]] || null : null;
    },
    createElement: (tag) => new Node(tag),
    dispatchEvent: (event) => events.push(event),
  };
  const storage = { getItem: (key) => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) };
  let last = states[states.length - 1];
  const cycleHandlers = [];
  const changeHandlers = [];
  const window = {
    desktop: {
      onTabShortcut: (handler) => cycleHandlers.push(handler),
      onClientChange: (handler) => changeHandlers.push(handler),
      getSession: async () => (states.length ? (last = states.shift()) : last),
      showdown: async (action, args) => { calls.push({ action, args: JSON.parse(JSON.stringify(args)) }); return act(action, args); },
    },
  };
  vm.runInNewContext(source, {
    window,
    document,
    sessionStorage: storage,
    localStorage: storage,
    location,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    setTimeout: (fn, delay) => { const t = { fn, delay }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  return {
    location, navigations, nav, events, timers, saved, calls, currentPage, desktop: window.desktop,
    bars: () => after[0],
    // What the main process sends for Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+W and Ctrl+1 to Ctrl+9.
    shortcut: (value) => { assert.equal(cycleHandlers.length, 1); return cycleHandlers[0](value); },
    cycle(direction) { return this.shortcut({ type: 'cycle', direction }); },
    // What main sends when the client opens or switches rooms itself.
    clientChange: () => { assert.equal(changeHandlers.length, 1); changeHandlers[0](); },
    jump(index) { return this.shortcut({ type: 'jump', index }); },
    closeOpen() { return this.shortcut({ type: 'close' }); },
    middleClick: (node, button = 1) => {
      const event = { button, prevented: false, preventDefault() { this.prevented = true; } };
      if (node.listeners.auxclick) node.listeners.auxclick(event);
      return event;
    },
    rows: () => nav.rooms.children.filter((c) => c.has('nav-room')),
    row: (i) => nav.rooms.children.filter((c) => c.has('nav-room'))[i],
    tabs: () => nav.rooms.children.filter((c) => c.has('nav-tab')),
    tab: (title) => nav.rooms.children.find((c) => (c.has('nav-tab') || c.has('nav-page')) && c.children[0].children[1].children[0].textContent === title),
    main: (r) => r.children[0],
    close: (r) => r.children[1],
    title: (r) => r.children[0].children[1].children[0].textContent,
    sub: (r) => (r.children[0].children[1].children[1] || {}).textContent,
    async settle() { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); },
    async poll() { assert.ok(timers.length); timers.shift().fn(); await this.settle(); },
  };
}

test('clicking the current launcher page prevents a reload', async () => {
  const h = harness([session([])]);
  await h.settle();
  assert.equal(h.currentPage.click().prevented, true);
  assert.deepEqual(h.calls, []);
});

test('clicking the selected client tab leaves its view alone', async () => {
  for (const [title, state] of [
    ['Community', session([], { menuTab: 'community' })],
  ]) {
    const h = harness([state], { onPlay: true });
    await h.settle();
    h.main(h.tab(title)).click();
    await h.settle();
    assert.deepEqual(h.calls, [], title);
    assert.equal(h.location.href, 'play.html');
  }
});

test('new player battle switches after names arrive', async () => {
  const h = harness([session([]), session([room('battle-gen9ou-1')]), session([room('battle-gen9ou-1', ['Player', 'Rival'])])]);
  await h.settle();
  assert.equal(h.location.href, 'index.html');
  await h.poll();
  assert.equal(h.location.href, 'index.html');
  await h.poll();
  assert.equal(h.location.href, 'play.html');
  assert.equal(h.title(h.row(0)), 'vs. Rival');
});

test('first poll waits for an unresolved battle room to identify its players', async () => {
  const h = harness([session([room('battle-gen9ou-4')]), session([room('battle-gen9ou-4', ['Player', 'Rival'])])]);
  await h.settle();
  assert.equal(h.location.href, 'index.html');
  await h.poll();
  assert.equal(h.location.href, 'play.html');
});

test('spectated battles do not switch and failed session reads recover', async () => {
  const h = harness([session([]), { ready: false, rooms: [] }, session([room('battle-gen9ou-2', ['Alice', 'Bob'])])]);
  await h.settle();
  await h.poll();
  await h.poll();
  assert.equal(h.location.href, 'index.html');
  assert.equal(h.title(h.row(0)), 'Alice vs. Bob');
});

test('known rooms carry across launcher page navigation', async () => {
  const saved = new Map();
  const first = harness([session([])], { saved });
  await first.settle();
  const second = harness([session([room('battle-gen9ou-3', ['Player', 'Rival'])])], { saved });
  await second.settle();
  assert.equal(second.location.href, 'play.html');
});

test('session events are dispatched; polling is 3s idle and 1s on play or while searching', async () => {
  const idle = harness([session([])]);
  await idle.settle();
  assert.equal(idle.events[0].type, 'showdown-session');
  assert.equal(idle.timers[0].delay, 3000);
  const play = harness([session([])], { onPlay: true });
  await play.settle();
  assert.equal(play.timers[0].delay, 1000);
  const searching = harness([session([], { search: { pending: true, formats: ['gen9ou'] } })]);
  await searching.settle();
  assert.equal(searching.timers[0].delay, 1000);
});

test('rooms render as rows with titles, sub-lines, unread dots and close labels', async () => {
  const live = room('battle-gen9ou-5', ['Player', 'Rival'], { turn: 7 });
  const done = room('battle-gen9ou-6', ['Alice', 'Bob'], { ended: true });
  const lobby = chat('lobby', 'Lobby', { unread: true });
  const tb = chat('teambuilder', 'Teambuilder', { kind: 'teambuilder' });
  const h = harness([session([live, done, lobby, tb])]);
  await h.settle();
  assert.equal(h.rows().length, 3, 'the Teambuilder room is a page tab, not a row');
  assert.equal(h.title(h.row(0)), 'vs. Rival');
  assert.equal(h.sub(h.row(0)), 'Gen 9 OU · Turn 7');
  assert.ok(h.row(0).has('nav-item--live'));
  assert.equal(h.title(h.row(1)), 'Alice vs. Bob');
  assert.equal(h.sub(h.row(1)), 'Gen 9 OU · Finished');
  assert.ok(!h.row(1).has('nav-item--live'));
  assert.equal(h.sub(h.row(2)), undefined);
  assert.ok(h.main(h.row(2)).children.some((c) => c.has('nav-unread')));
  assert.ok(!h.main(h.row(1)).children.some((c) => c.has('nav-unread')));
  assert.equal(h.close(h.row(2)).getAttribute('aria-label'), 'Close Lobby');
  assert.equal(h.close(h.row(0)).getAttribute('aria-label'), 'Close vs. Rival');
  assert.equal(h.nav.account.hidden, false);
  assert.equal(h.nav.me.textContent, 'Player');
  assert.equal(h.nav['sign-in'].hidden, true);
});

test('guest accounts show a sign-in link that logs in and opens the client', async () => {
  const h = harness([session([], { me: 'Guest 123', named: false })]);
  await h.settle();
  assert.equal(h.nav['sign-in'].hidden, false);
  const event = h.nav['sign-in'].click();
  await h.settle();
  assert.equal(event.prevented, true);
  assert.deepEqual(h.calls, [{ action: 'login', args: {} }]);
  assert.equal(h.location.href, 'play.html');
});

test('rows are reused when nothing changed and rebuilt when something did', async () => {
  const h = harness([session([chat('lobby', 'Lobby')]), session([chat('lobby', 'Lobby')]), session([chat('lobby', 'Lobby', { unread: true })])]);
  await h.settle();
  const first = h.row(0);
  await h.poll();
  assert.equal(h.row(0), first);
  await h.poll();
  assert.notEqual(h.row(0), first);
});

test('only the current room is marked on play, and none elsewhere', async () => {
  const rooms = [chat('lobby', 'Lobby'), chat('help', 'Help')];
  const play = harness([session(rooms, { current: 'help' })], { onPlay: true });
  await play.settle();
  assert.deepEqual(play.rows().map((r) => r.getAttribute('aria-current')), [null, 'page']);
  const other = harness([session(rooms, { current: 'help' })]);
  await other.settle();
  assert.deepEqual(other.rows().map((r) => r.getAttribute('aria-current')), [null, null]);
});

test('there is no Battle or fixed Community tab: Home and the open rooms make up the strip', async () => {
  const rooms = [chat('lobby', 'Lobby')];
  const h = harness([session(rooms, { menuUnread: true })]);
  await h.settle();
  assert.equal(h.tab('Battle'), undefined);
  assert.deepEqual(h.nav.rooms.children.map((r) => h.title(r)), ['Home', 'Lobby']);
  assert.deepEqual(h.tabs(), [], 'no fixed tabs');

  const notReady = harness([{ ready: false, rooms: [] }]);
  await notReady.settle();
  assert.deepEqual(notReady.nav.rooms.children.map((r) => notReady.title(r)), ['Home']);
});

test('the client main menu has no tab, so the Showdown screen hands it back to Home', async () => {
  const rooms = [chat('lobby', 'Lobby')];
  const menu = session(rooms, { current: '', menuTab: 'battle' });
  const h = harness([menu], { onPlay: true });
  await h.settle();
  assert.equal(h.nav.rooms.children.some((c) => c.getAttribute('aria-current') === 'page'), false, 'nothing is marked');
  assert.equal(h.location.href, 'play.html', 'one read is not enough');
  await h.poll();
  assert.equal(h.location.href, 'index.html', 'a second read agrees, so Home takes over');

  // A room that is still opening reads as the main menu once; it must not bounce.
  const opening = harness([menu, session(rooms, { current: 'lobby' })], { onPlay: true });
  await opening.settle();
  await opening.poll();
  await opening.poll();
  assert.equal(opening.location.href, 'play.html');

  // A client popup, such as a forfeit prompt, stays on screen.
  const popup = harness([session(rooms, { current: '', menuTab: 'battle', popups: 1 })], { onPlay: true });
  await popup.settle();
  await popup.poll();
  assert.equal(popup.location.href, 'play.html');

  // Community and conversations are not the main menu, and other pages are left alone.
  for (const extra of [{ menuTab: 'community' }, { menuTab: 'pm', pmOpen: 'misty', messages: [convo('misty')] }]) {
    const other = harness([session(rooms, { current: '', ...extra })], { onPlay: true });
    await other.settle();
    await other.poll();
    assert.equal(other.location.href, 'play.html', extra.menuTab);
  }
  const off = harness([menu]);
  await off.settle();
  await off.poll();
  assert.equal(off.location.href, 'index.html');
  assert.deepEqual(off.calls, []);
});

test('Teambuilder opens from the icon bar as a small page tab that follows its room', async () => {
  const pageTabs = (h) => h.nav.rooms.children.filter((c) => c.has('nav-page'));
  const closed = harness([session([])]);
  await closed.settle();
  assert.equal(closed.tab('Teambuilder'), undefined, 'no fixed Teambuilder tab');
  assert.deepEqual(pageTabs(closed).map((t) => closed.title(t)), ['Home']);
  assert.equal(closed.nav.teambuilder.click().prevented, true);
  await closed.settle();
  assert.deepEqual(closed.calls, [{ action: 'join', args: { room: 'teambuilder' } }]);
  assert.equal(closed.location.href, 'play.html');

  const tb = chat('teambuilder', 'Teambuilder', { kind: 'teambuilder' });
  const saved = new Map([['nav.pages', '["stats.html"]']]);
  const open = harness([session([tb], { current: 'teambuilder' }), session([])], { onPlay: true, saved });
  await open.settle();
  assert.deepEqual(pageTabs(open).map((t) => open.title(t)), ['Home', 'Stats', 'Teambuilder']);
  assert.deepEqual(pageTabs(open).map((t) => t.getAttribute('aria-current')), [null, null, 'page']);
  assert.equal(open.nav.teambuilder.getAttribute('aria-current'), 'page');
  assert.deepEqual(JSON.parse(saved.get('nav.pages')), ['stats.html', 'teambuilder']);
  assert.equal(open.tab('Community'), undefined);
  assert.equal(open.rows().length, 0);
  // Clicking the open Teambuilder does nothing; closing it leaves the room.
  open.nav.teambuilder.click();
  open.main(pageTabs(open)[2]).click();
  await open.settle();
  assert.deepEqual(open.calls, []);
  open.close(pageTabs(open)[2]).click();
  await open.settle();
  assert.deepEqual(open.calls, [{ action: 'leave-room', args: { room: 'teambuilder' } }]);
  assert.deepEqual(JSON.parse(saved.get('nav.pages')), ['stats.html']);
  assert.equal(open.location.href, 'stats.html', 'the last tab falls back to its left neighbor');
  open.calls.length = 0;
});

test('Community opens from the icon bar as a page tab that stays until closed', async () => {
  const pageTabs = (h) => h.nav.rooms.children.filter((c) => c.has('nav-page'));
  const h = harness([session([])]);
  await h.settle();
  assert.equal(h.tab('Community'), undefined, 'no tab until it is opened');
  assert.equal(h.nav.community.click().prevented, true);
  await h.settle();
  assert.deepEqual(h.calls, [{ action: 'show-menu', args: { tab: 'community' } }]);
  assert.equal(h.location.href, 'play.html');

  const saved = new Map();
  const menu = harness([session([], { menuTab: 'community' })], { onPlay: true, saved });
  await menu.settle();
  assert.deepEqual(pageTabs(menu).map((t) => menu.title(t)), ['Home', 'Community']);
  assert.equal(menu.tab('Community').getAttribute('aria-current'), 'page');
  assert.equal(menu.nav.community.getAttribute('aria-current'), 'page');
  assert.deepEqual(JSON.parse(saved.get('nav.pages')), ['community']);
  // Clicking it again does nothing.
  menu.nav.community.click();
  menu.main(menu.tab('Community')).click();
  await menu.settle();
  assert.deepEqual(menu.calls, []);

  // It stays on other pages, and opens the Community view from there.
  const away = harness([session([chat('lobby', 'Lobby')], { current: 'lobby' })], { onPlay: true, saved });
  await away.settle();
  assert.equal(away.tab('Community').getAttribute('aria-current'), null);
  assert.equal(away.nav.community.getAttribute('aria-current'), null);
  away.main(away.tab('Community')).click();
  await away.settle();
  assert.deepEqual(away.calls, [{ action: 'show-menu', args: { tab: 'community' } }]);

  const list = harness([session([], { current: 'rooms' })], { onPlay: true });
  await list.settle();
  assert.equal(list.tab('Community').getAttribute('aria-current'), 'page', 'the room list belongs to Community');
});

test('closing Community while it shows goes Home; elsewhere it only drops the tab', async () => {
  const saved = new Map([['nav.pages', '["community"]']]);
  const shown = harness([session([], { menuTab: 'community' })], { onPlay: true, saved });
  await shown.settle();
  shown.close(shown.tab('Community')).click();
  await shown.settle();
  assert.deepEqual(shown.calls, [], 'Home opens directly without an intermediate client menu');
  assert.equal(shown.location.href, 'index.html');
  assert.deepEqual(JSON.parse(saved.get('nav.pages')), []);

  const other = new Map([['nav.pages', '["community","stats.html"]']]);
  const h = harness([session([])], { saved: other });
  await h.settle();
  h.close(h.tab('Community')).click();
  await h.settle();
  assert.deepEqual(h.calls, []);
  assert.equal(h.location.href, 'index.html');
  assert.equal(h.tab('Community'), undefined);
  assert.deepEqual(JSON.parse(other.get('nav.pages')), ['stats.html']);
});

test("the client's resources room gives way to the Info & Resources page", async () => {
  const resources = chat('resources', 'Help', { kind: 'other' });
  const h = harness([session([resources], { current: 'resources' }), session([])], { onPlay: true });
  await h.settle();
  assert.equal(h.rows().length, 0, 'the room never gets a tab');
  assert.deepEqual(h.calls, [{ action: 'leave-room', args: { room: 'resources' } }]);
  assert.equal(h.location.href, 'resources.html');

  const here = harness([session([resources])], { page: 'resources.html' });
  await here.settle();
  assert.deepEqual(here.calls, [{ action: 'leave-room', args: { room: 'resources' } }]);
  assert.equal(here.location.href, 'resources.html');
});

test('a room opened inside the client shows in the strip at once, not at the next poll', async () => {
  const rooms = [chat('lobby', 'Lobby')];
  const h = harness([
    session([], { current: '', menuTab: 'community' }),
    session(rooms, { current: 'lobby' }),
  ], { onPlay: true });
  await h.settle();
  assert.equal(h.tab('Community').getAttribute('aria-current'), 'page');
  const pollsBefore = h.timers.length;
  // Joining Lobby from Community's room list: the client's address changes and main says so.
  h.clientChange();
  h.clientChange();
  await h.settle();
  assert.equal(h.row(0).getAttribute('aria-current'), 'page', 'Lobby is the open tab without waiting');
  assert.equal(h.tab('Community').getAttribute('aria-current'), null);
  // One regular poll, plus a single follow-up read for the room's title from the server.
  assert.equal(h.timers.length, pollsBefore + 1, 'the regular poll is rescheduled, not doubled');
  assert.deepEqual(h.timers.map((t) => t.delay).sort(), [1000, 350]);
});

test('a new page draws the strip from the last session at once, then from the live read', async () => {
  const first = harness([session([chat('lobby', 'Lobby')])]);
  await first.settle();
  // The next page in the same window: its strip is there before its first read returns.
  const next = harness([session([chat('lobby', 'Lobby'), chat('help', 'Help')])], { saved: first.saved });
  assert.deepEqual(next.rows().map((r) => next.title(r)), ['Lobby'], 'drawn synchronously from the last read');
  await next.settle();
  assert.deepEqual(next.rows().map((r) => next.title(r)), ['Lobby', 'Help'], 'then replaced by the live read');
  // A read from before the client was ready is not kept, and stale data never navigates.
  const cold = harness([{ ready: false, rooms: [] }], { saved: new Map([['nav.lastSession', '{"ready":false,"rooms":[]}']]) });
  assert.equal(cold.rows().length, 0);
  assert.equal(cold.location.href, 'index.html');
});

test('every friends page is one tab titled Friends', async () => {
  const h = harness([session([chat('view-friends-sent', '[Friends] Sent', { kind: 'other' }), chat('view-friendsish', 'Not friends', { kind: 'other' })])]);
  await h.settle();
  assert.deepEqual(h.rows().map((r) => h.title(r)), ['Friends', 'Not friends']);
});

test('rooms follow the page tabs in the client order', async () => {
  const h = harness([session([
    chat('lobby', 'Lobby'), chat('ladder', 'Ladder', { kind: 'ladder' }), chat('battles', 'Battles', { kind: 'battles' }),
    chat('tournaments', 'Tournaments'), room('battle-gen9ou-8', ['Alice', 'Bob']), chat('teambuilder', 'Teambuilder', { kind: 'teambuilder' }),
  ])]);
  await h.settle();
  assert.deepEqual(h.nav.rooms.children.map((r) => h.title(r)),
    ['Home', 'Teambuilder', 'Lobby', 'Ladder', 'Battles', 'Tournaments', 'Alice vs. Bob']);
});

test('clicking a row focuses and opens play', async () => {
  const off = harness([session([chat('lobby', 'Lobby')])]);
  await off.settle();
  off.main(off.row(0)).click();
  await off.settle();
  assert.deepEqual(off.calls, [{ action: 'focus-room', args: { room: 'lobby' } }]);
  assert.equal(off.location.href, 'play.html');

  const on = harness([session([chat('lobby', 'Lobby')], { current: 'lobby' })], { onPlay: true });
  await on.settle();
  on.location.href = 'unchanged';
  on.main(on.row(0)).click();
  await on.settle();
  assert.deepEqual(on.calls, [], 'the current room does not need to be focused again');
  assert.equal(on.location.href, 'unchanged', 'already on play: no navigation');
});

test('close sends leave-room without triggering the row click', async () => {
  const h = harness([session([chat('lobby', 'Lobby')])]);
  await h.settle();
  const event = h.close(h.row(0)).click();
  await h.settle();
  assert.equal(event.stopped, true);
  assert.deepEqual(h.calls, [{ action: 'leave-room', args: { room: 'lobby' } }]);
});

test('close answered needs-client opens play so the popup is seen', async () => {
  const h = harness([session([room('battle-gen9ou-7', ['Player', 'Rival'])])], { act: async () => 'needs-client' });
  await h.settle();
  h.close(h.row(0)).click();
  await h.settle();
  assert.equal(h.location.href, 'play.html');
});

test('close answered false changes nothing', async () => {
  const h = harness([session([chat('lobby', 'Lobby')], { current: 'lobby' })], { onPlay: true, act: async () => false });
  await h.settle();
  h.location.href = 'unchanged';
  h.close(h.row(0)).click();
  await h.settle();
  assert.equal(h.location.href, 'unchanged');
});

test('closing selects the right room and uses Home only when it is the remaining neighbor', async () => {
  const empty = harness([session([chat('lobby', 'Lobby')], { current: 'lobby' }), session([])], { onPlay: true });
  await empty.settle();
  empty.close(empty.row(0)).click();
  await empty.settle();
  assert.equal(empty.location.href, 'index.html');

  const left = harness([
    session([chat('lobby', 'Lobby'), chat('help', 'Help')], { current: 'lobby' }),
    session([chat('help', 'Help')], { current: 'help' }),
  ], { onPlay: true });
  await left.settle();
  left.close(left.row(0)).click();
  await left.settle();
  assert.equal(left.location.href, 'play.html');
  assert.equal(left.title(left.row(0)), 'Help');

  // A transient main-menu read must not replace the explicitly selected neighbor.
  const menu = harness([
    session([chat('lobby', 'Lobby'), chat('help', 'Help')], { current: 'lobby' }),
    session([chat('help', 'Help')], { current: '', menuTab: 'battle' }),
    session([chat('help', 'Help')], { current: 'help' }),
  ], { onPlay: true });
  await menu.settle();
  menu.close(menu.row(0)).click();
  await menu.settle();
  assert.equal(menu.location.href, 'play.html');
  assert.deepEqual(menu.calls, [{ action: 'leave-room', args: { room: 'lobby', next: { room: 'help' } } }]);

  const elsewhere = harness([session([chat('lobby', 'Lobby')]), session([])]);
  await elsewhere.settle();
  elsewhere.close(elsewhere.row(0)).click();
  await elsewhere.settle();
  assert.equal(elsewhere.location.href, 'index.html');
  assert.equal(elsewhere.rows().length, 0);
});

const incoming = (userid, extra = {}) => ({ userid, name: userid.toUpperCase(), unread: false, active: false, last: '',
  challenge: { dir: 'in', format: 'gen9ou', formatName: '[Gen 9] OU', message: `${userid.toUpperCase()} wants to battle!`,
    pending: false, needsTeam: true, team: 0, teams: [{ index: 0, name: 'Rain' }, { index: 3, name: 'Sun' }], ...extra } });
const convo = (userid, extra = {}) => ({ userid, name: userid, unread: false, active: false, last: '', challenge: null, ...extra });
const button = (bar, label) => bar.find((n) => n.tag === 'button' && n.textContent === label);

test('conversations are listed under Messages; a challenge is marked and opens its conversation', async () => {
  const h = harness([session([], { messages: [incoming('ashk'), convo('misty', { unread: true })] })]);
  await h.settle();
  const label = h.nav.rooms.children.find((c) => c.has('rail-section--messages'));
  assert.ok(label, 'Messages section shown');
  const rows = h.nav.rooms.children.slice(h.nav.rooms.children.indexOf(label) + 1);
  assert.deepEqual(rows.map((r) => h.title(r)), ['ASHK', 'misty']);
  assert.equal(h.sub(rows[0]), 'Challenge');
  assert.ok(rows[0].has('nav-item--challenge'));
  assert.ok(rows[1].children[0].children.some((c) => c.className === 'nav-unread'));
  h.main(rows[1]).click();
  await h.settle();
  assert.deepEqual(h.calls, [{ action: 'open-pm', args: { user: 'misty' } }]);
  assert.equal(h.location.href, 'play.html');

  const none = harness([session([], { messages: [] })]);
  await none.settle();
  assert.equal(none.nav.rooms.children.some((c) => c.has('rail-section--messages')), false);
});

test('the open conversation is marked current, and close sends close-pm', async () => {
  const h = harness([session([], { menuTab: 'pm', pmOpen: 'misty', messages: [convo('misty')] })], { onPlay: true });
  await h.settle();
  const row = h.nav.rooms.children[h.nav.rooms.children.length - 1];
  assert.equal(row.getAttribute('aria-current'), 'page');
  const event = h.close(row).click();
  await h.settle();
  assert.equal(event.stopped, true);
  assert.deepEqual(h.calls, [{ action: 'close-pm', args: { user: 'misty' } }]);
});

test('an incoming challenge shows a bar after the top bar; Accept sends the chosen team', async () => {
  const h = harness([session([], { messages: [incoming('ashk')] })]);
  await h.settle();
  const box = h.bars();
  assert.equal(box.hidden, false);
  const bar = box.children[0];
  assert.ok(bar.has('banner--challenge-in'));
  assert.equal(bar.find((n) => n.tag === 'strong').textContent, 'ASHK challenges you to [Gen 9] OU');
  const select = bar.find((n) => n.tag === 'select');
  assert.deepEqual(select.children.map((o) => [o.value, o.textContent]), [['0', 'Rain'], ['3', 'Sun']]);
  assert.equal(select.value, '0');
  select.value = '3';
  select.listeners.change();
  button(bar, 'Accept').click();
  await h.settle();
  assert.deepEqual(h.calls, [{ action: 'answer-challenge', args: { user: 'ashk', answer: 'accept', team: 3 } }]);
  assert.equal(button(bar, 'Decline').disabled, true, 'controls lock while answering');
});

test('the bar prefers the team Home last used for the format, and Decline sends reject', async () => {
  const saved = new Map([['hub.team.gen9ou', '3']]);
  const h = harness([session([], { messages: [incoming('ashk')] })], { saved });
  await h.settle();
  const bar = h.bars().children[0];
  assert.equal(bar.find((n) => n.tag === 'select').value, '3');
  button(bar, 'Decline').click();
  await h.settle();
  assert.deepEqual(h.calls, [{ action: 'answer-challenge', args: { user: 'ashk', answer: 'reject' } }]);
});

test('a preset-team challenge has no team picker; a client popup opens the conversation', async () => {
  const h = harness([session([], { messages: [incoming('ashk', { needsTeam: false, team: null, teams: [] })] })],
    { act: async (action) => (action === 'answer-challenge' ? 'needs-client' : true) });
  await h.settle();
  const bar = h.bars().children[0];
  assert.equal(bar.find((n) => n.tag === 'select'), null);
  button(bar, 'Accept').click();
  await h.settle();
  assert.deepEqual(h.calls.map((c) => c.action), ['answer-challenge', 'open-pm']);
  assert.deepEqual(h.calls[0].args, { user: 'ashk', answer: 'accept' });
  assert.equal(h.location.href, 'play.html');
});

test('outgoing, cancelled and starting challenges show their own bars', async () => {
  const out = convo('misty', { challenge: { dir: 'out', format: 'gen9ou', formatName: '[Gen 9] OU', message: '' } });
  const gone = convo('brock', { challenge: { dir: 'cancelled', format: '', formatName: '', message: '' } });
  const starting = incoming('ashk', { pending: true });
  const h = harness([session([], { messages: [out, gone, starting] })]);
  await h.settle();
  const [a, b, c] = h.bars().children;
  assert.equal(a.find((n) => n.tag === 'strong').textContent, 'Waiting for misty to accept');
  assert.equal(b.find((n) => n.tag === 'strong').textContent, 'brock cancelled the challenge');
  assert.equal(c.find((n) => n.tag === 'button'), null, 'no buttons while the battle starts');
  button(a, 'Cancel challenge').click();
  button(b, 'OK').click();
  await h.settle();
  assert.deepEqual(h.calls.map((x) => x.args.answer), ['cancel', 'dismiss']);
});

test('the bar hides for the conversation already open on the Showdown screen', async () => {
  const shown = harness([session([], { menuTab: 'pm', pmOpen: 'ashk', messages: [incoming('ashk')] })], { onPlay: true });
  await shown.settle();
  assert.equal(shown.bars().hidden, true);
  const elsewhere = harness([session([], { menuTab: 'pm', pmOpen: 'ashk', messages: [incoming('ashk')] })]);
  await elsewhere.settle();
  assert.equal(elsewhere.bars().children.length, 1);
});

test('Home is the first small tab, and opened launcher pages follow it until closed', async () => {
  const fresh = harness([session([])]);
  await fresh.settle();
  const pageTabs = (h) => h.nav.rooms.children.filter((c) => c.has('nav-page'));
  assert.deepEqual(pageTabs(fresh).map((t) => fresh.title(t)), ['Home']);
  assert.equal(pageTabs(fresh)[0].getAttribute('aria-current'), 'page');
  assert.equal(pageTabs(fresh)[0].children.length, 1, 'Home has no close button');
  assert.ok(fresh.nav.rooms.children[0].has('nav-page'), 'page tabs come before room tabs');

  // Unknown files, duplicates and Home itself are dropped from the saved list.
  const saved = new Map([['nav.pages', JSON.stringify(['stats.html', 'evil.html', 'index.html', 'stats.html', 'settings.html'])]]);
  const h = harness([session([])], { saved });
  await h.settle();
  assert.deepEqual(pageTabs(h).map((t) => h.title(t)), ['Home', 'Stats', 'Settings']);
  assert.equal(h.close(pageTabs(h)[1]).getAttribute('aria-label'), 'Close Stats');
  h.close(pageTabs(h)[1]).click();
  await h.settle();
  assert.deepEqual(pageTabs(h).map((t) => h.title(t)), ['Home', 'Settings']);
  assert.deepEqual(JSON.parse(saved.get('nav.pages')), ['settings.html']);
  assert.equal(h.location.href, 'index.html');

  // On the Showdown screen no page tab is the open one.
  const play = harness([session([])], { onPlay: true, saved: new Map([['nav.pages', '["stats.html"]']]) });
  await play.settle();
  assert.deepEqual(pageTabs(play).map((t) => t.getAttribute('aria-current')), [null, null]);
});

test('Ctrl+Tab steps through page tabs, client tabs, rooms and conversations, wrapping at the ends', async () => {
  const saved = new Map([['nav.pages', '["stats.html"]']]);
  const state = session([chat('lobby', 'Lobby')], { messages: [convo('misty')] });
  // Strip order: Home, Stats, Community, Lobby, misty.
  const home = harness([state], { saved });
  await home.settle();
  await home.cycle(1);
  assert.equal(home.location.href, 'stats.html');
  assert.deepEqual(home.calls, []);

  const back = harness([state], { saved });
  await back.settle();
  await back.cycle(-1);
  assert.deepEqual(back.calls, [{ action: 'open-pm', args: { user: 'misty' } }], 'backwards from the first tab wraps to the last');
  assert.equal(back.location.href, 'play.html');

  const community = harness([session([chat('lobby', 'Lobby')], { menuTab: 'community' })], { onPlay: true, saved });
  await community.settle();
  await community.cycle(-1);
  assert.equal(community.location.href, 'stats.html', 'Community steps back to the last page tab');

  const last = harness([session([chat('lobby', 'Lobby')], { current: 'lobby' })], { onPlay: true });
  await last.settle();
  await last.cycle(1);
  assert.equal(last.location.href, 'index.html', 'forwards from the last tab wraps to Home');
});

test('Ctrl+Tab on the Showdown screen focuses rooms through the client and queues repeated presses', async () => {
  const rooms = [chat('lobby', 'Lobby'), chat('help', 'Help')];
  // Strip order: Home, Community, Lobby, Help.
  const h = harness([
    session(rooms, { current: '', menuTab: 'community' }),
    // Each step reads the session twice: once after the switch and once more to be sure.
    session(rooms, { current: 'lobby' }),
    session(rooms, { current: 'lobby' }),
    session(rooms, { current: 'help' }),
  ], { onPlay: true });
  await h.settle();
  h.cycle(1);
  await h.cycle(1);
  assert.deepEqual(h.calls, [
    { action: 'focus-room', args: { room: 'lobby' } },
    { action: 'focus-room', args: { room: 'help' } },
  ], 'the second press steps from where the first one landed');
  assert.equal(h.location.href, 'play.html');
  assert.equal(h.row(1).getAttribute('aria-current'), 'page');

  const tb = chat('teambuilder', 'Teambuilder', { kind: 'teambuilder' });
  const team = harness([session([tb])]);
  await team.settle();
  await team.cycle(1);
  assert.deepEqual(team.calls, [{ action: 'join', args: { room: 'teambuilder' } }], 'the Teambuilder tab opens its room');
  assert.equal(team.location.href, 'play.html');
});

test('Ctrl+W closes the open tab and does nothing on tabs that cannot close', async () => {
  // Home cannot close.
  const home = harness([session([chat('lobby', 'Lobby')])], { saved: new Map([['nav.pages', '["stats.html"]']]) });
  await home.settle();
  await home.closeOpen();
  assert.deepEqual(home.calls, []);
  assert.equal(home.location.href, 'index.html');
  assert.equal(home.nav.rooms.children.filter((c) => c.has('nav-page')).length, 2);

  // Community closes like its close button, including while it shows the room list.
  for (const extra of [{ current: '', menuTab: 'community' }, { current: 'rooms' }]) {
    const community = harness([session([chat('lobby', 'Lobby')], extra), session([chat('lobby', 'Lobby')], { current: 'lobby' })], { onPlay: true });
    await community.settle();
    await community.closeOpen();
    assert.deepEqual(community.calls, [{ action: 'focus-room', args: { room: 'lobby' } }], JSON.stringify(extra));
    assert.equal(community.location.href, 'play.html');
  }

  // A room closes through the client, exactly like its close button.
  const inRoom = harness([
    session([chat('lobby', 'Lobby'), chat('help', 'Help')], { current: 'lobby' }),
    session([chat('help', 'Help')], { current: 'help' }),
  ], { onPlay: true });
  await inRoom.settle();
  await inRoom.closeOpen();
  assert.deepEqual(inRoom.calls, [{ action: 'leave-room', args: { room: 'lobby', next: { room: 'help' } } }]);
  assert.equal(inRoom.location.href, 'play.html');
  assert.equal(inRoom.title(inRoom.row(0)), 'Help');

  // A conversation closes with close-pm; the Teambuilder tab leaves its room.
  const pm = harness([session([], { menuTab: 'pm', pmOpen: 'misty', messages: [convo('misty')] })], { onPlay: true });
  await pm.settle();
  await pm.closeOpen();
  assert.deepEqual(pm.calls, [{ action: 'close-pm', args: { user: 'misty' } }]);
  const tb = chat('teambuilder', 'Teambuilder', { kind: 'teambuilder' });
  const team = harness([session([tb, chat('lobby', 'Lobby')], { current: 'teambuilder' })], { onPlay: true });
  await team.settle();
  await team.closeOpen();
  assert.deepEqual(team.calls, [{ action: 'leave-room', args: { room: 'teambuilder', next: { room: 'lobby' } } }]);

  // Off the Showdown screen no room is the open tab, so rooms are never closed from there.
  const off = harness([session([chat('lobby', 'Lobby')], { current: 'lobby' })]);
  await off.settle();
  await off.closeOpen();
  assert.deepEqual(off.calls, []);
});

test('Ctrl+W on the rightmost launcher tab falls back to the tab on its left', async () => {
  const saved = new Map([['nav.pages', '["stats.html","settings.html"]']]);
  const h = harness([session([])], { saved, page: 'settings.html' });
  await h.settle();
  await h.closeOpen();
  assert.deepEqual(JSON.parse(saved.get('nav.pages')), ['stats.html']);
  assert.equal(h.location.href, 'stats.html');
  assert.deepEqual(h.calls, []);
});

test('page closes select the tab on the right for the close button, middle click and Ctrl+W', async () => {
  for (const method of ['button', 'middle', 'shortcut']) {
    const saved = new Map([['nav.pages', '["stats.html","settings.html","replays.html"]']]);
    const h = harness([session([])], { saved, page: 'settings.html' });
    await h.settle();
    if (method === 'button') h.close(h.tab('Settings')).click();
    else if (method === 'middle') h.middleClick(h.tab('Settings'));
    else await h.closeOpen();
    await h.settle();
    assert.deepEqual(h.navigations, ['replays.html'], method);
    assert.deepEqual(JSON.parse(saved.get('nav.pages')), ['stats.html', 'replays.html']);
  }
});

test('the right neighbor can cross from a page into a room or conversation', async () => {
  for (const [state, expected] of [
    [session([chat('lobby', 'Lobby')], { current: 'lobby' }), { action: 'focus-room', args: { room: 'lobby' } }],
    [session([], { menuTab: 'pm', pmOpen: 'misty', messages: [convo('misty')] }), { action: 'open-pm', args: { user: 'misty' } }],
  ]) {
    const h = harness([state], { page: 'stats.html' });
    await h.settle();
    await h.closeOpen();
    assert.deepEqual(h.calls, [expected]);
    assert.deepEqual(h.navigations, ['play.html']);
    assert.equal(JSON.parse(h.saved.get('nav.lastSession')).current, state.current);
  }
});

test('Community closes directly to the native page on its right', async () => {
  const saved = new Map([['nav.pages', '["community","stats.html"]']]);
  const h = harness([session([], { menuTab: 'community' })], { saved, onPlay: true });
  await h.settle();
  await h.closeOpen();
  assert.deepEqual(h.navigations, ['stats.html']);
  assert.deepEqual(h.calls, [], 'no client Battle-menu detour');
  assert.deepEqual(JSON.parse(saved.get('nav.pages')), ['stats.html']);
});

test('stale reads and client-change events cannot render an intermediate tab or redirect during a close', async () => {
  let finishRead, finishClose;
  const h = harness([session([chat('lobby', 'Lobby'), chat('help', 'Help')], { current: 'lobby' })], {
    onPlay: true, act: () => new Promise(resolve => { finishClose = resolve; }),
  });
  await h.settle();
  h.desktop.getSession = () => new Promise(resolve => { finishRead = resolve; });
  h.clientChange();
  await h.settle();
  const pending = h.closeOpen();
  await h.settle();
  h.clientChange();
  const settled = session([chat('help', 'Help')], { current: 'help' });
  h.desktop.getSession = async () => settled;
  finishRead(session([chat('help', 'Help')], { menuTab: 'battle' }));
  await h.settle();
  assert.equal(h.row(0).getAttribute('aria-current'), 'page', 'old selection stays until close finishes');
  finishClose(true);
  await pending;
  await h.settle();
  assert.deepEqual(h.navigations, []);
  assert.equal(h.title(h.row(0)), 'Help');
  assert.equal(h.row(0).getAttribute('aria-current'), 'page');
  assert.equal(h.events.some(e => e.detail?.menuTab === 'battle'), false, 'no transient session reaches the page');
});

test('a late main-menu read cannot override a close that navigated to a native page', async () => {
  let finishRead;
  const tb = chat('teambuilder', 'Teambuilder');
  const saved = new Map([['nav.pages', '["teambuilder","stats.html"]']]);
  const h = harness([session([tb], { current: 'teambuilder' })], { onPlay: true, saved });
  await h.settle();
  h.desktop.getSession = () => new Promise(resolve => { finishRead = resolve; });
  h.clientChange();
  await h.settle();
  const pending = h.closeOpen();
  await h.settle();
  assert.deepEqual(h.navigations, ['stats.html']);
  finishRead(session([], { menuTab: 'battle' }));
  await pending;
  assert.deepEqual(h.navigations, ['stats.html']);
  assert.deepEqual(JSON.parse(saved.get('nav.pages')), ['stats.html']);
  assert.deepEqual(JSON.parse(saved.get('nav.lastSession')).rooms, []);
});

test('closing a bot battle uses the right neighbor only after stopping succeeds', async () => {
  for (const ok of [false, true]) {
    const saved = new Map([['nav.pages', '["practice.html","practice-battle.html","settings.html"]']]);
    const h = harness([session([])], { page: 'practice-battle.html', saved });
    h.desktop.stopPractice = async () => ({ ok });
    await h.settle();
    await h.closeOpen();
    assert.deepEqual(h.navigations, ok ? ['settings.html'] : []);
    assert.equal(JSON.parse(saved.get('nav.pages')).includes('practice-battle.html'), !ok);
  }
});

test('a middle click closes a closable tab and leaves the fixed tabs alone', async () => {
  const saved = new Map([['nav.pages', '["stats.html"]']]);
  const h = harness([session([chat('lobby', 'Lobby')], { messages: [convo('misty')] })], { saved });
  await h.settle();
  const pageTabs = () => h.nav.rooms.children.filter((c) => c.has('nav-page'));
  assert.equal(pageTabs()[0].listeners.auxclick, undefined, 'Home has no middle-click close');

  // Other mouse buttons do nothing.
  assert.equal(h.middleClick(h.row(0), 2).prevented, false);
  await h.settle();
  assert.deepEqual(h.calls, []);

  assert.equal(h.middleClick(h.row(0)).prevented, true);
  await h.settle();
  assert.deepEqual(h.calls, [{ action: 'leave-room', args: { room: 'lobby' } }]);
  h.calls.length = 0;
  const message = h.nav.rooms.children[h.nav.rooms.children.length - 1];
  h.middleClick(message);
  await h.settle();
  assert.deepEqual(h.calls, [{ action: 'close-pm', args: { user: 'misty' } }]);

  h.middleClick(pageTabs()[1]);
  await h.settle();
  assert.deepEqual(pageTabs().map((t) => h.title(t)), ['Home']);
  assert.deepEqual(JSON.parse(saved.get('nav.pages')), []);
  assert.equal(h.location.href, 'index.html', 'closing a page tab that is not open stays put');
});

test('Ctrl+1 to Ctrl+8 open that tab from the left and Ctrl+9 opens the last one', async () => {
  const saved = () => new Map([['nav.pages', '["stats.html","community"]']]);
  const state = session([chat('lobby', 'Lobby')], { messages: [convo('misty')] });
  // Strip order: Home, Stats, Community, Lobby, misty.
  const page = harness([state], { saved: saved() });
  await page.settle();
  await page.jump(1);
  assert.equal(page.location.href, 'index.html', 'the open tab is left alone');
  await page.jump(2);
  assert.equal(page.location.href, 'stats.html');
  assert.deepEqual(page.calls, []);

  const menu = harness([state], { saved: saved() });
  await menu.settle();
  await menu.jump(3);
  assert.deepEqual(menu.calls, [{ action: 'show-menu', args: { tab: 'community' } }]);
  assert.equal(menu.location.href, 'play.html');

  const roomTab = harness([state], { saved: saved() });
  await roomTab.settle();
  await roomTab.jump(4);
  assert.deepEqual(roomTab.calls, [{ action: 'focus-room', args: { room: 'lobby' } }]);

  const last = harness([state], { saved: saved() });
  await last.settle();
  await last.jump(9);
  assert.deepEqual(last.calls, [{ action: 'open-pm', args: { user: 'misty' } }]);

  // A number past the end, and anything malformed, does nothing.
  const none = harness([state], { saved: saved() });
  await none.settle();
  await none.jump(8);
  await none.shortcut({ type: 'jump', index: 0 });
  await none.shortcut({ type: 'jump', index: '2' });
  await none.shortcut({ type: 'unknown' });
  await none.shortcut(null);
  assert.deepEqual(none.calls, []);
  assert.equal(none.location.href, 'index.html');

  const home = harness([session([chat('lobby', 'Lobby')], { current: 'lobby' })], { onPlay: true });
  await home.settle();
  await home.jump(1);
  assert.equal(home.location.href, 'index.html', 'Ctrl+1 is always Home');
});

test('closing the rightmost page falls back to its left neighbor, even a client room', async () => {
  // Community (a client room, not a file) sits left of Stats: closing Stats opens Community
  // through the client instead of loading a file called "community", which left Stats showing.
  const saved = new Map([['nav.pages', '["community","stats.html"]']]);
  const h = harness([session([])], { saved, page: 'stats.html' });
  await h.settle();
  h.close(h.tab('Stats')).click();
  await h.settle();
  assert.deepEqual(h.calls, [{ action: 'show-menu', args: { tab: 'community' } }]);
  assert.equal(h.location.href, 'play.html');
  assert.deepEqual(JSON.parse(saved.get('nav.pages')), ['community']);

  // With only Home to its left, closing Stats goes Home.
  const alone = new Map([['nav.pages', '["stats.html"]']]);
  const home = harness([session([])], { saved: alone, page: 'stats.html' });
  await home.settle();
  home.close(home.tab('Stats')).click();
  await home.settle();
  assert.equal(home.location.href, 'index.html');
  assert.deepEqual(JSON.parse(alone.get('nav.pages')), []);
});
