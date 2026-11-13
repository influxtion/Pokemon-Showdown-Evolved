'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const Module = require('node:module');
const path = require('node:path');
const { MessageAlerts } = require('../app/message-alerts');

const originalLoad = Module._load;
let ShowdownBridge;
try {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { net: { fetch: () => { throw new Error('unexpected network request'); } } };
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ ShowdownBridge } = require(path.join(__dirname, '..', 'app', 'showdown.js')));
} finally {
  Module._load = originalLoad;
}

// A minimal element: enough of the DOM API for readMessages.
function el({ attrs = {}, classes = [], text = '', children = {}, all = {}, value, disabled = false, hidden = false } = {}) {
  return {
    value, disabled, textContent: text,
    style: { display: hidden ? 'none' : '' },
    classList: { contains: (name) => classes.includes(name) },
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    querySelector: (selector) => children[selector] || null,
    querySelectorAll: (selector) => all[selector] || [],
  };
}

function challengeForm(buttons, message) {
  const children = { p: el({ text: message }) };
  for (const [name, button] of Object.entries(buttons)) children[`button[name="${name}"]`] = button;
  return el({ children });
}

function pmWindowEl(userid, name, { challenge = null, unread = false, active = false, hidden = false, lines = [], news = false } = {}) {
  return el({
    attrs: { 'data-userid': userid, 'data-name': name },
    classes: ['pm-window', ...(active ? ['sd-pm-active'] : []), ...(news ? ['news-embed'] : [])],
    hidden,
    children: { h3: el({ classes: unread ? ['pm-notifying'] : [] }), '.challenge': challenge },
    all: { '.inner > .chat': lines.map((t) => el({ children: { em: el({ text: t }) } })) },
  });
}

function fakeDocument(initial = []) {
  const classes = new Set(initial);
  return {
    classes,
    documentElement: { classList: {
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name),
    } },
    getElementById: (id) => (id === 'header' ? {} : null),
  };
}

function runSession(windows, { classes = [] } = {}) {
  const app = {
    user: { get: (key) => (key === 'name' ? 'Player' : true) },
    rooms: { '': { $: () => ({ length: 0 }), $pmBox: [{ querySelectorAll: () => windows }] } },
    curRoom: { id: '' }, singlePanelMode: true,
    focusRoom() {}, updateLayout() {}, leaveRoom() {}, joinRoom() {}, addPopup() {},
  };
  const document = fakeDocument(classes);
  const BattleFormats = { gen9ou: { teambuilderFormat: 'gen9ou' }, gen9randombattle: { team: 'random' } };
  const Storage = { teams: [{ name: 'Rain', format: 'gen9ou' }, { name: 'Other', format: 'gen9uu' }, { name: 'Sun', format: 'gen9ou' }] };
  const context = { app, document, BattleFormats, Storage };
  context.window = context;
  const contents = { isLoading: () => false, executeJavaScript: async (code) => vm.runInNewContext(code, context) };
  return { bridge: new ShowdownBridge(() => contents), document };
}

test('session lists conversations and challenges from the client\'s message windows', async () => {
  const windows = [
    pmWindowEl('ashk', ' Ash_K', { unread: true, lines: ['hey', 'want to battle?'], challenge: challengeForm({
      format: el({ value: 'gen9ou', text: '[Gen 9] OU' }),
      team: el({ value: '2' }),
      acceptChallenge: el(), rejectChallenge: el(),
    }, 'Ash_K wants to battle!') }),
    pmWindowEl('misty', '+Misty', { challenge: challengeForm({ format: el({ value: 'gen9randombattle', text: '[Gen 9] Random Battle' }), cancelChallenge: el() }, 'Waiting for Misty...') }),
    pmWindowEl('brock', ' Brock', { active: true, challenge: challengeForm({ dismissChallenge: el() }, 'The challenge was cancelled.') }),
    pmWindowEl('gone', ' Gone', { hidden: true }),
    pmWindowEl('', ' News', { news: true }),
  ];
  const { bridge } = runSession(windows, { classes: ['sd-menu-pm'] });
  const state = await bridge.session();
  assert.deepEqual(state.messages.map((m) => m.userid), ['ashk', 'misty', 'brock']);
  const [ash, misty, brock] = state.messages;
  assert.equal(ash.name, 'Ash_K');
  assert.equal(misty.name, 'Misty');
  assert.equal(ash.unread, true);
  assert.equal(ash.last, 'want to battle?');
  assert.equal(misty.last, '');
  assert.deepEqual(ash.challenge, {
    dir: 'in', format: 'gen9ou', formatName: '[Gen 9] OU', message: 'Ash_K wants to battle!',
    pending: false, needsTeam: true, team: 2,
    teams: [{ index: 0, name: 'Rain' }, { index: 2, name: 'Sun' }],
  });
  assert.equal(misty.challenge.dir, 'out');
  assert.equal(brock.challenge.dir, 'cancelled');
  assert.equal(state.menuTab, 'pm');
  assert.equal(state.pmOpen, 'brock');
});

test('the conversation view falls back to Battle once its window is gone', async () => {
  const { bridge, document } = runSession([pmWindowEl('ashk', ' Ash_K')], { classes: ['sd-menu-pm'] });
  const state = await bridge.session();
  assert.equal(state.menuTab, 'battle');
  assert.equal(state.pmOpen, '');
  assert.equal(document.classes.has('sd-menu-pm'), false);
});

test('message data from the page is bounded and malformed entries are dropped', async () => {
  const contents = { isLoading: () => false, executeJavaScript: async () => ({
    rooms: [], menuTab: 'pm', pmOpen: 'nobody',
    messages: [
      null, { userid: 'Bad/ID' }, { userid: 'ok', name: 'x\u0000'.repeat(60), last: 'y'.repeat(300),
        challenge: { dir: 'in', format: 'gen9ou@@@Best of = 3', formatName: 'f'.repeat(100), team: 7,
          teams: [{ index: -1, name: 'bad' }, { index: 3, name: '' }, { index: 7, name: 'Team' }] } },
      { userid: 'ok', name: 'duplicate' },
      { userid: 'evil', challenge: { dir: 'sideways' } },
      { userid: 'fmt', challenge: { dir: 'out', format: 'bad format<script>' } },
    ],
  }) };
  const state = await new ShowdownBridge(() => contents).session();
  assert.equal(state.menuTab, 'battle');
  assert.equal(state.pmOpen, '');
  assert.deepEqual(state.messages.map((m) => m.userid), ['ok', 'evil', 'fmt']);
  const [ok, evil, fmt] = state.messages;
  assert.ok(ok.name.length <= 40 && !/\u0000/.test(ok.name));
  assert.equal(ok.last.length, 200);
  assert.equal(ok.challenge.format, 'gen9ou@@@Best of = 3');
  assert.equal(ok.challenge.formatName.length, 80);
  assert.deepEqual(ok.challenge.teams, [{ index: 3, name: 'Untitled team' }, { index: 7, name: 'Team' }]);
  assert.equal(ok.challenge.team, 7);
  assert.equal(evil.challenge, null);
  assert.equal(fmt.challenge.format, '');
});

test('message actions validate their arguments before reaching the client', async () => {
  const codes = [];
  const contents = { isLoading: () => false, executeJavaScript: async (code) => { codes.push(code); return true; } };
  const bridge = new ShowdownBridge(() => contents);
  for (const user of [undefined, '', 'Bad Name', 'a'.repeat(19), 'x");app.send("/forfeit']) {
    assert.equal(await bridge.act('open-pm', { user }), false);
    assert.equal(await bridge.act('close-pm', { user }), false);
    assert.equal(await bridge.act('answer-challenge', { user, answer: 'accept' }), false);
  }
  assert.equal(await bridge.act('answer-challenge', { user: 'ashk', answer: 'send' }), false);
  assert.equal(await bridge.act('answer-challenge', { user: 'ashk', answer: 'reject', team: 1 }), false);
  for (const team of [-1, 1.5, '1', 10000]) {
    assert.equal(await bridge.act('answer-challenge', { user: 'ashk', answer: 'accept', team }), false);
  }
  assert.equal(codes.length, 0);
  assert.equal(await bridge.act('open-pm', { user: 'ashk' }), true);
  assert.equal(await bridge.act('answer-challenge', { user: 'ashk', answer: 'accept', team: 2 }), true);
  assert.match(codes[0], /function pmWindow/);
  assert.match(codes[1], /\("ashk", "accept", 2\);/);
});

// A tiny stand-in for the jQuery objects answerChallenge and openPM use.
function $wrap(nodes) {
  const list = nodes.filter(Boolean);
  const wrapped = {
    length: list.length,
    0: list[0],
    find: (selector) => $wrap(list.flatMap((n) => (n.find ? n.find(selector) : []))),
    val: () => list[0] && list[0].value,
    replaceWith: (html) => { list.forEach((n) => { n.replacedWith = html; }); return wrapped; },
  };
  return wrapped;
}

test('answering a challenge drives the client\'s own buttons, with the chosen team', async () => {
  const calls = [];
  const buttons = {
    acceptChallenge: { disabled: false, name: 'acceptChallenge' },
    rejectChallenge: { disabled: false, name: 'rejectChallenge' },
    team: { disabled: false, value: '0' },
    format: { value: 'gen9ou' },
  };
  const pm = { find: (selector) => {
    const m = /button\[name=(\w+)\]/.exec(selector);
    return m && buttons[m[1]] ? [buttons[m[1]]] : [];
  } };
  const app = {
    popups: [],
    rooms: { '': {
      $pmBox: { find: (selector) => (selector === '.pm-window-ashk' ? $wrap([pm]) : $wrap([])) },
      renderTeams: (format, team) => `team:${format}:${team}`,
      acceptChallenge: (_i, target) => calls.push(['accept', target.name]),
      rejectChallenge: (_i, target) => { calls.push(['reject', target.name]); app.popups.push({}); },
    } },
  };
  const context = { app, Storage: { teams: [{}, {}, {}] } };
  context.window = context;
  const contents = { isLoading: () => false, executeJavaScript: async (code) => vm.runInNewContext(code, context) };
  const bridge = new ShowdownBridge(() => contents);

  assert.equal(await bridge.act('answer-challenge', { user: 'ashk', answer: 'accept', team: 2 }), true);
  assert.equal(buttons.team.replacedWith, 'team:gen9ou:2');
  assert.deepEqual(calls, [['accept', 'acceptChallenge']]);
  // A popup from the client means the user has to see it.
  assert.equal(await bridge.act('answer-challenge', { user: 'ashk', answer: 'reject' }), 'needs-client');
  // Teams that no longer exist and missing windows are refused, not guessed.
  delete buttons.team.replacedWith;
  assert.equal(await bridge.act('answer-challenge', { user: 'ashk', answer: 'accept', team: 9 }), true);
  assert.equal(buttons.team.replacedWith, undefined);
  assert.equal(await bridge.act('answer-challenge', { user: 'nobody', answer: 'accept' }), false);
  buttons.acceptChallenge.disabled = true;
  assert.equal(await bridge.act('answer-challenge', { user: 'ashk', answer: 'accept' }), false);
});

function sessionWith(messages, me = 'Player') {
  return { ready: true, me, messages };
}

const incoming = (userid, format = 'gen9ou') => ({ userid, name: userid, unread: false, last: '',
  challenge: { dir: 'in', format, formatName: '[Gen 9] OU' } });

test('alerts announce new challenges and messages once, after a baseline read', () => {
  const alerts = new MessageAlerts();
  // Already waiting at the first read: not announced again.
  assert.deepEqual(alerts.observe(sessionWith([incoming('old')])), []);
  const added = alerts.observe(sessionWith([incoming('old'), incoming('ashk')]));
  assert.deepEqual(added.map((a) => [a.kind, a.user, a.title]), [['challenge', 'ashk', 'Challenge from ashk']]);
  assert.deepEqual(alerts.observe(sessionWith([incoming('old'), incoming('ashk')])), []);
  // A new format from the same user is a new challenge.
  assert.equal(alerts.observe(sessionWith([incoming('old'), incoming('ashk', 'gen9uu')])).length, 1);

  const pm = (last) => ({ userid: 'misty', name: 'Misty', unread: true, last, challenge: null });
  const first = alerts.observe(sessionWith([pm('hi')]));
  assert.deepEqual(first.map((a) => [a.kind, a.body]), [['pm', 'hi']]);
  assert.deepEqual(alerts.observe(sessionWith([pm('hi')])), []);
  assert.deepEqual(alerts.observe(sessionWith([pm('gg')])).map((a) => a.body), ['gg']);
  // Read, then a new message: announced again.
  alerts.observe(sessionWith([{ ...pm(''), unread: false }]));
  assert.equal(alerts.observe(sessionWith([pm('again')])).length, 1);
});

test('alerts start a fresh baseline for another account and ignore unready reads', () => {
  const alerts = new MessageAlerts();
  alerts.observe(sessionWith([]));
  assert.deepEqual(alerts.observe({ ready: false, rooms: [] }), []);
  assert.deepEqual(alerts.observe(sessionWith([incoming('ashk')], 'Other')), []);
  assert.equal(alerts.observe(sessionWith([incoming('ashk'), incoming('brock')], 'Other')).length, 1);
});
