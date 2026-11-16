'use strict';

// Home hub. Reads state from the hidden Showdown client and sends it actions; the
// battle itself always happens in the client on the Play screen.

const $ = (id) => document.getElementById(id);
const els = {
  account: $('account'),
  heroFormat: $('hero-format'),
  heroSub: $('hero-sub'),
  heroStats: $('hero-stats'),
  format: $('format'),
  team: $('team'),
  battle: $('battle'),
  challengeToggle: $('challenge-toggle'),
  challengeForm: $('challenge-form'),
  challengeUser: $('challenge-user'),
  teamGrid: $('team-grid'),
  teamName: $('team-name'),
  heroRecord: $('hero-record'),
  news: $('news'),
  rooms: $('rooms'),
  friends: $('friends'),
};

let state = { ready: false };
// Session polling is the freshest source for connection state. Until the first
// usable session arrives, show loading rather than claiming the socket is lost.
let sessionReady = false;
let sessionConnected = false;
let formatsKey = '';
let teamsKey = '';
let searching = false;
let searchRequested = false;
let lastPopups = null;
let searchClickedAt = 0;
// When the current search began, for the elapsed timer on the button.
let searchSince = 0;
let friendsKey = '';

function tickSearch() {
  if (!searchSince) return;
  const seconds = Math.floor((Date.now() - searchSince) / 1000);
  els.battle.querySelector('.search-time').textContent =
    `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
setInterval(tickSearch, 1000);

// Per-viewer conveniences only; the page works without them.
const prefs = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const openFriends = el('button', 'btn', 'Open list');
openFriends.type = 'button';
openFriends.addEventListener('click', () => {
  if (sessionReady && sessionConnected) act('friends');
});
$('friends-head').append(openFriends);

function num(n) {
  return n === null || n === undefined ? '–' : n.toLocaleString('en-US');
}

function toPlay() {
  location.href = 'play.html';
}

// Most actions open something in the client, so they switch to it. Background actions
// (search, cancel) only switch when the client needs the user, such as a login prompt.
async function act(action, args, { show = true } = {}) {
  const result = await window.desktop.showdown(action, args);
  if (result === 'needs-client' || (result && show)) toPlay();
  return result;
}

function currentFormat() {
  return state.formats.find((f) => f.id === els.format.value) || null;
}

function teamsFor(formatId) {
  return state.teams.filter((t) => t.format === formatId);
}

function renderFormats() {
  const key = state.formats.map((f) => f.id).join();
  if (key === formatsKey) return;
  formatsKey = key;

  const wanted = els.format.value || prefs.get('hub.format') || state.currentFormat;
  els.format.replaceChildren();
  const groups = new Map();
  for (const f of state.formats) {
    if (!groups.has(f.section)) {
      const group = el('optgroup');
      group.label = f.section || 'Other';
      groups.set(f.section, group);
      els.format.append(group);
    }
    const option = el('option', null, f.name);
    option.value = f.id;
    groups.get(f.section).append(option);
  }
  if (state.formats.some((f) => f.id === wanted)) els.format.value = wanted;
  els.format.disabled = false;
  teamsKey = '';
}

function renderTeams() {
  const format = currentFormat();
  const key = `${format && format.id}|${state.teams.map((t) => `${t.index}:${t.name}:${t.format}`).join()}`;
  if (key === teamsKey) return;
  teamsKey = key;

  els.team.replaceChildren();
  if (!format) return;
  if (format.presetTeam) {
    els.team.append(el('option', null, 'Team is provided'));
    els.team.disabled = true;
    return;
  }
  const matching = teamsFor(format.id);
  const others = state.teams.filter((t) => t.format !== format.id);
  const add = (parent, t) => {
    const option = el('option', null, t.name || 'Untitled team');
    option.value = String(t.index);
    parent.append(option);
  };
  if (!state.teams.length) {
    els.team.append(el('option', null, 'No teams yet'));
    els.team.disabled = true;
    return;
  }
  matching.forEach((t) => add(els.team, t));
  if (others.length) {
    const group = el('optgroup');
    group.label = 'Other formats';
    others.forEach((t) => add(group, t));
    els.team.append(group);
  }
  const saved = prefs.get(`hub.team.${format.id}`);
  if (saved && state.teams.some((t) => String(t.index) === saved)) els.team.value = saved;
  els.team.disabled = false;
}

function selectedTeam() {
  const format = currentFormat();
  if (!format || format.presetTeam || els.team.disabled) return null;
  return state.teams.find((t) => String(t.index) === els.team.value) || null;
}

function renderHero() {
  const format = currentFormat();
  els.heroFormat.textContent = format ? format.name : 'Pokémon Showdown';

  const rating = format && state.ratings && state.ratings[format.id];
  const record = format && state.stats && state.stats[format.id];
  els.heroRecord.hidden = !(state.user.registered && record);
  els.heroSub.hidden = !els.heroRecord.hidden;
  if (!els.heroRecord.hidden) {
    const games = record.wins + record.losses;
    els.heroRecord.replaceChildren(...[
      ['Rating', String(record.elo)],
      ['Win rate', games ? `${Math.round((record.wins / games) * 100)}%` : '–'],
      ['Record', `${num(record.wins)}–${num(record.losses)}`],
      ['GXE', record.gxe === null ? '–' : `${record.gxe}%`],
    ].map(([label, value]) => {
      const cell = el('div');
      cell.append(el('span', null, label), el('strong', null, value));
      return cell;
    }));
  }
  if (!state.user.registered) {
    els.heroSub.textContent = 'Playing as a guest. Sign in on Showdown to keep a ladder rating.';
  } else if (rating) {
    els.heroSub.textContent = `Ladder rating ${rating}`;
  } else {
    els.heroSub.textContent = 'Unrated in this format';
  }

  els.heroStats.replaceChildren(
    el('strong', 'num', num(state.counts.users)), document.createTextNode(' online · '),
    el('strong', 'num', num(state.counts.battles)), document.createTextNode(' battles'),
  );

  const team = selectedTeam();
  // Rebuild only when the team changes, so the searching animation is not restarted.
  const gridKey = format && format.presetTeam ? 'preset' : team ? team.sprites.join() : 'none';
  if (els.teamGrid.dataset.key !== gridKey) {
    els.teamGrid.dataset.key = gridKey;
    els.teamGrid.replaceChildren();
    for (let i = 0; i < 6; i++) {
      const src = team && team.sprites[i];
      if (src) {
        const img = el('img');
        img.src = src;
        img.alt = '';
        els.teamGrid.append(img);
      } else {
        els.teamGrid.append(el('span', 'hero-team-slot', format && format.presetTeam ? '?' : ''));
      }
    }
  }
  els.teamName.textContent = format && format.presetTeam ? 'Random team' : team ? team.name || 'Untitled team' : 'No team selected';

  const needsTeam = format && !format.presetTeam && !team;
  els.battle.disabled = searching || !format || !sessionReady || !sessionConnected;
  if (searching && !searchSince) searchSince = Date.now();
  if (!searching) searchSince = 0;
  els.battle.classList.toggle('is-searching', searching);
  els.battle.querySelector('.battle-label').textContent = searching ? 'Searching' : 'Battle!';
  els.battle.setAttribute('aria-label', searching ? 'Searching for an opponent' : 'Battle!');
  $('hero-kicker').textContent = searching ? 'Searching for an opponent' : 'Ready to battle';
  els.battle.closest('.hero').classList.toggle('is-searching', searching);
  tickSearch();
  els.battle.title = needsTeam ? 'Build or import a team for this format first' : '';
  $('cancel-search').hidden = !searching;
  els.format.disabled = searching || !state.formats.length;
  if (searching) els.challengeForm.hidden = true;
  els.challengeToggle.hidden = searching || !els.challengeForm.hidden;
  els.challengeToggle.disabled = !format || !sessionReady || !sessionConnected;
  els.challengeUser.disabled = !sessionReady || !sessionConnected;
  const challengeSubmit = els.challengeForm.querySelector('[type="submit"]');
  if (challengeSubmit) challengeSubmit.disabled = !sessionReady || !sessionConnected;
}

// News: each post opens in place to its full text. Links inside it, and the post's page on
// the website, open in the system browser. Rebuilt only when the news changes, so an open
// post stays open through Home's regular refreshes.
let newsKey = '';
const openPosts = new Set();

function showdownRoom(href) {
  try {
    const url = new URL(href);
    const match = /^\/([a-z0-9-]{1,80})\/?$/.exec(url.pathname);
    return url.protocol === 'https:' && url.hostname === 'play.pokemonshowdown.com' && match ? match[1] : '';
  } catch {
    return '';
  }
}

function postBody(n) {
  const body = el('div', 'post-body');
  for (const para of n.body && n.body.length ? n.body : [[{ text: n.text }]]) {
    const p = el('p');
    for (const run of para) {
      if (run.href) {
        const link = el('a', null, run.text);
        link.href = run.href;
        // A link to a Showdown room (play.pokemonshowdown.com/thecafe) opens that room here,
        // through the same path as the chat room shortcuts, instead of the website.
        const room = showdownRoom(run.href);
        if (room) link.dataset.room = room;
        p.append(link);
      } else {
        p.append(document.createTextNode(run.text));
      }
    }
    body.append(p);
  }
  const source = el('a', 'post-source', 'Open on pokemonshowdown.com');
  source.href = n.id ? `https://pokemonshowdown.com/news/${n.id}` : 'https://pokemonshowdown.com/news';
  body.append(source);
  return body;
}

function renderNews() {
  const key = JSON.stringify(state.news);
  if (key === newsKey) return;
  newsKey = key;
  if (!state.news.length) {
    els.news.replaceChildren(el('div', 'empty', 'No news loaded yet.'));
    return;
  }
  els.news.replaceChildren(...state.news.map((n, i) => {
    const id = n.id || `post-${i}`;
    const open = openPosts.has(id);
    const post = el('article', `post${open ? ' is-open' : ''}`);
    const toggle = el('button', 'post-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-controls', `post-body-${i}`);
    const date = n.date ? new Date(n.date * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    toggle.append(
      el('span', 'post-title', n.title),
      el('span', 'post-meta', [n.author, date].filter(Boolean).join(' · ')),
      el('span', 'post-text', n.text),
    );
    const body = postBody(n);
    body.id = `post-body-${i}`;
    body.hidden = !open;
    toggle.addEventListener('click', () => {
      const opening = !openPosts.has(id);
      if (opening) openPosts.add(id);
      else openPosts.delete(id);
      post.classList.toggle('is-open', opening);
      toggle.setAttribute('aria-expanded', String(opening));
      body.hidden = !opening;
    });
    post.append(toggle, body);
    return post;
  }));
}

// Chat room shortcuts. Until the player edits them they follow the busiest rooms; the
// first edit pins that list, and from then on it is theirs (a convenience, kept locally).
const MAX_PINNED_ROOMS = 12;
const ROOM_ID = /^[a-z0-9-]{1,80}$/;
let editingRooms = false;
let roomsKey = '';

function roomIdFor(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 80);
}

function pinnedRooms() {
  let raw = null;
  try {
    raw = JSON.parse(prefs.get('hub.rooms'));
  } catch {}
  if (!Array.isArray(raw)) return null;
  return raw.filter((r) => r && typeof r.id === 'string' && ROOM_ID.test(r.id) && typeof r.title === 'string')
    .slice(0, MAX_PINNED_ROOMS)
    .map((r) => ({ id: r.id, title: r.title.slice(0, 40) || r.id }));
}

function liveRoom(id) {
  return (state.rooms || []).find((r) => roomIdFor(r.title) === id) || null;
}

function shownRooms() {
  return pinnedRooms() || [...(state.rooms || [])]
    .sort((a, b) => (b.users || 0) - (a.users || 0)).slice(0, 5)
    .map((r) => ({ id: roomIdFor(r.title), title: r.title }))
    .filter((r) => ROOM_ID.test(r.id));
}

function renderRooms() {
  const rooms = shownRooms();
  const live = rooms.map((r) => liveRoom(r.id));
  const key = JSON.stringify([editingRooms, state.ready, rooms, live.map((r) => r && [r.users, r.desc])]);
  if (key === roomsKey) return;
  roomsKey = key;

  const toggle = $('rooms-edit');
  toggle.textContent = editingRooms ? 'Done' : 'Edit';
  toggle.setAttribute('aria-pressed', String(editingRooms));
  toggle.setAttribute('aria-label', editingRooms ? 'Done editing chat rooms' : 'Edit chat rooms');
  $('rooms-add').hidden = !editingRooms;
  $('rooms-all').hidden = editingRooms;

  if (!rooms.length) {
    const text = editingRooms ? 'No rooms yet. Add one below.'
      : pinnedRooms() ? 'No rooms pinned. Choose Edit to add some.'
        : state.ready ? 'Room list not loaded yet.' : 'Loading rooms…';
    els.rooms.replaceChildren(el('div', 'empty', text));
    return;
  }
  els.rooms.replaceChildren(...rooms.map((r, i) => {
    const info = live[i];
    if (editingRooms) {
      const row = el('div', 'room-row room-row--edit');
      const remove = el('button', 'room-remove');
      remove.type = 'button';
      remove.dataset.remove = r.id;
      remove.setAttribute('aria-label', `Remove ${r.title}`);
      remove.title = 'Remove';
      row.append(el('span', 'room-row-title', r.title), remove);
      return row;
    }
    const link = el('a', 'room-row');
    link.href = '#';
    link.dataset.room = r.id;
    const head = el('span', 'room-row-head');
    head.append(el('span', 'room-row-title', r.title));
    if (info) head.append(el('span', 'room-row-users num', `${num(info.users)} users`));
    link.append(head);
    if (info && info.desc) link.append(el('span', 'room-row-desc', info.desc));
    return link;
  }));
}

function savePinnedRooms(list) {
  prefs.set('hub.rooms', JSON.stringify(list));
  roomsKey = '';
  renderRooms();
}

$('rooms-edit').addEventListener('click', () => {
  // The first edit turns the suggested list into the player's own.
  if (!editingRooms && !pinnedRooms()) prefs.set('hub.rooms', JSON.stringify(shownRooms()));
  editingRooms = !editingRooms;
  roomsKey = '';
  renderRooms();
  if (editingRooms) $('rooms-add-name').focus();
});

els.rooms.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove]');
  if (!button) return;
  const rooms = pinnedRooms() || [];
  const index = rooms.findIndex((r) => r.id === button.dataset.remove);
  if (index < 0) return;
  rooms.splice(index, 1);
  savePinnedRooms(rooms);
  // Keep the keyboard where it was: the next remove button, else the add field.
  const next = els.rooms.querySelectorAll('[data-remove]')[Math.min(index, rooms.length - 1)];
  (next || $('rooms-add-name')).focus();
});

$('rooms-add').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('rooms-add-name');
  const name = input.value.trim();
  const id = roomIdFor(name);
  const rooms = pinnedRooms() || [];
  if (!ROOM_ID.test(id) || rooms.length >= MAX_PINNED_ROOMS) {
    input.select();
    return;
  }
  if (!rooms.some((r) => r.id === id)) {
    rooms.push({ id, title: (liveRoom(id) && liveRoom(id).title) || name });
    savePinnedRooms(rooms);
  }
  input.value = '';
  input.focus();
});

function renderAccount() {
  if (!sessionReady) {
    els.account.className = 'status status--warn';
    els.account.textContent = 'Connecting to Showdown…';
  } else if (!sessionConnected) {
    els.account.className = 'status status--warn';
    els.account.textContent = 'Connection lost. Reconnecting…';
  } else if (state.user.registered) {
    els.account.className = 'status status--ok';
    els.account.textContent = `Signed in as ${state.user.name}`;
  } else {
    els.account.className = 'status status--off';
    els.account.textContent = 'Guest';
  }
}

function renderFriends() {
  openFriends.hidden = !state.user.registered;
  openFriends.disabled = !sessionReady || !sessionConnected;
  const friends = state.friends;
  const disconnected = !state.connected || (sessionReady && !sessionConnected);
  const key = JSON.stringify([state.user.registered, disconnected, friends?.available, friends?.loading, friends?.items]);
  if (friendsKey !== key) {
    friendsKey = key;
    const children = [];
    if (!state.user.registered) {
      const box = el('div', 'friends-note');
      box.append(el('p', null, 'Sign in to Showdown to see your friends and who is online.'));
      const button = el('button', 'btn btn-primary', 'Sign in');
      button.type = 'button';
      button.addEventListener('click', () => act('login'));
      box.append(button);
      children.push(box);
    } else if (disconnected) {
      children.push(el('div', 'friends-note', 'Friends are unavailable while Showdown reconnects.'));
    } else if (friends?.loading) {
      children.push(el('div', 'friends-note', 'Loading friends…'));
    } else if (!friends?.available) {
      children.push(el('div', 'friends-note', 'Friends are unavailable here. Open the list in Showdown.'));
    } else if (!friends.items.length) {
      children.push(el('div', 'friends-note', 'No friends added on Showdown.'));
    } else {
      for (const [status, label] of [
        ['online', 'Online'], ['idle', 'Idle'], ['busy', 'Busy'], ['offline', 'Offline'],
      ]) {
        const group = friends.items.filter((friend) => friend.status === status)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!group.length) continue;
        children.push(el('div', 'friends-group num', `${label} (${group.length})`));
        for (const friend of group) {
          const row = el('div', `friend ${friend.online ? 'friend--online' : 'friend--offline'}`);
          const details = el('div', 'friend-text');
          details.append(el('span', 'friend-name', friend.name), el('span', 'friend-status', label));
          row.append(details);
          if (friend.online) {
            const challenge = el('button', 'btn', 'Challenge');
            challenge.type = 'button';
            challenge.dataset.friendChallenge = friend.userid;
            challenge.setAttribute('aria-label', `Challenge ${friend.name}`);
            row.append(challenge);
          }
          children.push(row);
        }
      }
    }
    els.friends.replaceChildren(...children);
    const online = state.user.registered && !disconnected && friends?.available
      ? friends.items.filter((friend) => friend.online).length : 0;
    $('count-friends').hidden = !online;
    $('count-friends').textContent = `${online} online`;
  }
  for (const button of els.friends.querySelectorAll('[data-friend-challenge]')) {
    button.disabled = !sessionReady || !sessionConnected || !currentFormat();
  }
}

els.friends.addEventListener('click', (event) => {
  const button = event.target.closest('[data-friend-challenge]');
  if (!button || !sessionReady || !sessionConnected) return;
  const format = currentFormat();
  if (format) act('challenge', { user: button.dataset.friendChallenge, format: format.id });
});

function render() {
  if (!state.ready) return;
  renderAccount();
  renderFormats();
  renderTeams();
  renderHero();
  renderNews();
  renderRooms();
  renderFriends();
}

async function refresh() {
  try {
    state = await window.desktop.getShowdown();
  } catch {
    state = { ready: false };
  }
  render();
  // Ratings or friends still loading in the background: look again shortly.
  setTimeout(refresh, !state.ready ? 2000 : state.pending ? 1000 : 10000);
}

els.format.addEventListener('change', () => {
  prefs.set('hub.format', els.format.value);
  teamsKey = '';
  renderTeams();
  renderHero();
});

els.team.addEventListener('change', () => {
  const format = currentFormat();
  if (format) prefs.set(`hub.team.${format.id}`, els.team.value);
  renderHero();
});

els.battle.addEventListener('click', () => {
  if (!sessionReady || !sessionConnected) return;
  const format = currentFormat();
  if (!format) return;
  const team = selectedTeam();
  // An empty team still goes through: the client explains what is missing.
  searching = true;
  searchRequested = true;
  searchClickedAt = Date.now();
  renderHero();
  act('search', { format: format.id, team: team ? team.index : null }, { show: false }).then((result) => {
    if (!result || result === 'needs-client') {
      searching = false;
      searchRequested = false;
      renderHero();
    }
  });
});

els.challengeToggle.addEventListener('click', () => {
  if (!sessionReady || !sessionConnected) return;
  els.challengeToggle.hidden = true;
  els.challengeForm.hidden = false;
  els.challengeUser.focus();
});

$('challenge-cancel').addEventListener('click', () => {
  els.challengeForm.hidden = true;
  els.challengeToggle.hidden = false;
});

els.challengeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!sessionReady || !sessionConnected) return;
  const user = els.challengeUser.value.trim();
  const format = currentFormat();
  if (user && format) act('challenge', { user, format: format.id });
});

$('edit-team').addEventListener('click', (event) => {
  event.preventDefault();
  const team = selectedTeam();
  act('edit-team', team ? { team: team.index, name: team.name, format: team.format } : { team: null });
});

document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-room]');
  if (!link) return;
  event.preventDefault();
  act('join', { room: link.dataset.room });
});

// Fed by nav.js, which already polls the client's open rooms.
let liveBattle = null;
document.addEventListener('showdown-session', (event) => {
  const session = event.detail;
  sessionReady = Boolean(session.ready);
  sessionConnected = Boolean(session.ready && session.connected);
  if (state.ready) {
    renderAccount();
    renderHero();
    renderFriends();
  }
  // Search state comes from the client, so it stays right across pages and restarts.
  const active = Boolean(session.search && (session.search.pending || session.search.formats.length > 0));
  if (session.ready) {
    // A popup during a search is the server or client asking the user something.
    if (searchRequested && lastPopups !== null && session.popups > lastPopups) toPlay();
    lastPopups = session.popups;
    // A poll that left before the click reached the client would wrongly end the search.
    const settling = Date.now() - searchClickedAt < 2000;
    if (active !== searching && !(searching && settling)) {
      searching = active;
      if (!searching) searchRequested = false;
      if (state.ready) renderHero();
    }
  }
  liveBattle = session.rooms.find((r) => r.battle && !r.ended) || null;
  $('live-battle').hidden = !liveBattle;
  if (!liveBattle) return;
  const [p1, p2] = liveBattle.players;
  const opponent = session.me === p1 ? p2 : session.me === p2 ? p1 : null;
  const who = opponent ? `vs. ${opponent}` : `${p1} vs. ${p2}`;
  $('live-battle-text').textContent = `Battle in progress ${who}` + (liveBattle.format ? ` · ${liveBattle.format}` : '');
});
$('cancel-search').addEventListener('click', () => {
  act('cancel-search', {}, { show: false });
  searching = false;
  searchRequested = false;
  renderHero();
});

$('live-battle-return').addEventListener('click', () => {
  if (liveBattle) act('join', { room: liveBattle.id });
});

// Home layout. The choice lives in launcher settings (homeLayout): 'classic' or 'modern'.
// While none has been made, the welcome asks once; after that it never shows again unless
// the launcher is reset. The hub stays hidden until a layout is applied, so it never flashes.
const LAYOUTS = new Set(['classic', 'modern']);
const welcome = $('welcome');

function applyLayout(layout) {
  const hub = $('hub');
  hub.classList.toggle('hub--classic', layout === 'classic');
  hub.classList.toggle('hub--modern', layout !== 'classic');
}

// Older Chromium may still let Escape close the dialog; there is nothing to fall back to.
welcome.addEventListener('cancel', (event) => event.preventDefault());

welcome.addEventListener('click', async (event) => {
  const option = event.target.closest('[data-layout]');
  if (!option || !LAYOUTS.has(option.dataset.layout)) return;
  const options = welcome.querySelectorAll('[data-layout]');
  for (const button of options) button.disabled = true;
  try {
    await window.desktop.setSetting('homeLayout', option.dataset.layout);
  } catch {}
  // Applied even if saving failed; the welcome then simply returns on the next launch.
  applyLayout(option.dataset.layout);
  welcome.close();
});

async function loadLayout() {
  let settings = null;
  try {
    const result = await window.desktop.getSettings();
    if (result && result.ok) settings = result.settings;
  } catch {}
  const chosen = settings && LAYOUTS.has(settings.homeLayout) ? settings.homeLayout : null;
  applyLayout(chosen || 'modern');
  // Unreadable settings could not keep the answer, so only ask when they loaded.
  if (settings && !chosen && !welcome.open) welcome.showModal();
}

loadLayout();
refresh();
