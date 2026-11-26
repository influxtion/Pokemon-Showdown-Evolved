'use strict';

// Reads state from, and sends fixed actions to, the official client page. The functions below
// run inside play.pokemonshowdown.com, so they use only its globals (app, Storage, BattleFormats,
// Dex). Arguments travel as JSON, never spliced into code.

const { net } = require('electron');
const { boundedJson } = require('./bounded-json');
const { installShowdexDock } = require('./showdex-dock');
const { openProfile } = require('./client-profile');

const SHOWDOWN = 'https://play.pokemonshowdown.com/';
const ID = /^[a-z0-9]{1,80}$/;
const ROOM_ID = /^[a-z0-9-]{1,80}$/;
const BATTLE_FORMAT = /^battle-([a-z0-9]{1,60})-\d/;
const ROOM_KINDS = ['battle', 'chat', 'teambuilder', 'ladder', 'battles'];
const SPRITE = /^sprites\/[a-z0-9-]+\/[a-z0-9-]+$/;
const RATINGS_TTL = 2 * 60 * 1000;
const FRIENDS_TTL = 30 * 1000;
const FRIENDS_FAILURE_TTL = 5 * 1000;
const FRIENDS_TIMEOUT = 4500;
// Longest Home's snapshot waits for ratings and friends. Slower answers finish in the background
// and show on the next read; until then Home keeps the last values.
const SNAPSHOT_NETWORK_WAIT = 150;

const isId = (value) => typeof value === 'string' && ID.test(value);

/* eslint-disable no-undef -- these run in the Showdown page */
function readClient() {
  if (!window.app || !app.rooms || !app.rooms[''] || !window.BattleFormats || !window.Storage) {
    return { ready: false };
  }
  const text = (el) => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
  // Showdown's 2D gen 5 sprites, not the 3D Pokémon HOME renders. A gen 5 dex returns
  // sprites/gen5 for every Pokémon, newer ones included.
  const dex2d = typeof Dex !== 'undefined' && Dex && typeof Dex.forGen === 'function' ? Dex.forGen(5) : undefined;
  const sprite = (set) => {
    try {
      const d = Dex.getTeambuilderSpriteData(set, dex2d);
      return d.spriteDir + '/' + d.spriteid;
    } catch (e) {
      return null;
    }
  };
  // Unpacking teams for sprites is costly and runs in the battle page, so sprites are cached by
  // packed text: only new or edited teams are unpacked.
  const known = window.__sdTeamSprites2d instanceof Map ? window.__sdTeamSprites2d : new Map();
  const seen = new Map();
  const teams = (Storage.teams || []).map((t, index) => {
    const key = typeof t.team === 'string' ? t.team : '';
    let sprites = known.get(key) || seen.get(key);
    if (!sprites) {
      let sets = [];
      try {
        sets = Storage.unpackTeam(t.team) || [];
      } catch (e) {}
      sprites = sets.slice(0, 6).map(sprite);
    }
    seen.set(key, sprites);
    return { index, name: t.name, format: t.format, sprites: sprites.slice() };
  });
  window.__sdTeamSprites2d = seen;
  const rd = app.roomsData || {};
  // A paragraph as plain-text runs and links, so Home never inserts the page's HTML.
  const runs = (p) => {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) out.push({ text: child.textContent });
        else if (child.nodeName === 'A') out.push({ text: child.textContent, href: child.href });
        else if (child.nodeName === 'BR') out.push({ text: ' ' });
        else if (child.nodeType === 1) walk(child);
      }
    };
    walk(p);
    return out;
  };
  const news = [...document.querySelectorAll('.newsentry')].slice(0, 3).map((n) => {
    const paras = [...n.querySelectorAll('p')];
    const byline = paras.length > 1 ? paras.pop() : null;
    return {
      id: n.dataset.newsid,
      date: Number(n.dataset.date),
      title: text(n.querySelector('h4')),
      text: paras.map(text).join(' '),
      body: paras.map(runs),
      author: text(byline && byline.querySelector('strong')),
    };
  });
  return {
    ready: true,
    connected: !app.isDisconnected,
    user: { name: app.user.get('name'), userid: app.user.get('userid'), registered: !!app.user.get('registered') },
    counts: { users: rd.userCount, battles: rd.battleCount },
    currentFormat: app.rooms[''].curFormat,
    formats: Object.values(BattleFormats)
      .filter((f) => f.searchShow)
      .map((f) => ({ id: f.id, name: f.name, section: f.section, presetTeam: !!f.team })),
    teams,
    news,
    rooms: (rd.chat || []).map((r) => ({ title: r.title, desc: r.desc, users: r.userCount, section: r.section })),
  };
}

// Open rooms for the rail and Home's "return to battle" banner; cheap enough to poll. Also sets
// "sd-launcher-shell" (client-shell.css) only after a complete read by a client that still has
// the room controls the rail drives; otherwise the client's own navigation returns.
function readSession() {
  const root = window.document && document.documentElement;
  const setShell = (on) => { if (root && root.classList) root.classList.toggle('sd-launcher-shell', on); };
  try {
    if (!window.app || !app.rooms || !app.user) {
      setShell(false);
      return null;
    }
    const capable = Boolean(root && root.classList && app.curRoom && document.getElementById('header') &&
      ['updateLayout', 'focusRoom', 'leaveRoom', 'joinRoom', 'addPopup'].every((name) => typeof app[name] === 'function'));
    const me = app.user.get('name');
    const kinds = ['battle', 'chat', 'teambuilder', 'ladder', 'battles'];
    const rooms = Object.keys(app.rooms)
      .filter((id) => id && id !== 'rooms')
      .map((id) => {
        const room = app.rooms[id];
        const battle = room.battle;
        return {
          id,
          title: room.title || id,
          battle: id.startsWith('battle-'),
          players: battle ? [battle.p1 && battle.p1.name, battle.p2 && battle.p2.name] : [],
          format: battle ? battle.tier : '',
          ended: Boolean(battle && battle.ended),
          kind: kinds.includes(room.type) ? room.type : 'other',
          turn: battle ? battle.turn : null,
          unread: Boolean(room.notifications),
        };
      });
    const menu = app.rooms[''];
    const searching = menu && menu.searching;
    const messages = readMessages(menu);
    const has = (name) => Boolean(root && root.classList && root.classList.contains(name));
    // A conversation view whose window the client has since closed falls back to Battle.
    let pmOpen = has('sd-menu-pm') ? (messages.find((m) => m.active) || (has('sd-home-chat') && messages[0]) || {}).userid || '' : '';
    if (has('sd-menu-pm') && !pmOpen) root.classList.toggle('sd-menu-pm', false);
    const state = {
      me,
      avatar: typeof Dex !== 'undefined' && typeof Dex.resolveAvatar === 'function' && app.user.get('avatar')
        ? Dex.resolveAvatar(app.user.get('avatar')) : '',
      named: Boolean(app.user.get('named')),
      menuUnread: Boolean(menu && menu.notifications),
      menuTab: pmOpen ? 'pm' : has('sd-menu-community') ? 'community' : 'battle',
      pmOpen,
      chatDock: has('sd-home-chat'),
      messages,
      rooms,
      current: app.curRoom ? app.curRoom.id : '',
      connected: !app.isDisconnected,
      // "pending" covers the client's short delay between sending the team and /search.
      search: {
        pending: Boolean(menu && menu.$('.mainmenu p.cancel').length),
        formats: (Array.isArray(searching) ? searching : searching ? [searching] : []).map((s) => s.format || s),
      },
      popups: app.popups ? app.popups.length : 0,
      shell: capable,
    };
    // The rail replaces the client's tabs, so show one room at a time. Runtime flag only; the saved
    // layout preference is untouched.
    if (capable && !app.singlePanelMode) {
      app.singlePanelMode = true;
      app.updateLayout();
    }
    setShell(capable);
    // Showdex opens tools on the right; the client's single-panel layout hides that panel.
    if (capable && typeof app.focusRoomRight === 'function' && !app.focusRoomRight.sdSinglePanel) {
      const original = app.focusRoomRight;
      const focusRight = function (...args) {
        if (this.singlePanelMode && root.classList.contains('sd-launcher-shell')) {
          if (window.__sdShowdexDock?.openPanel(args[0])) return true;
          return this.focusRoom(args[0], true);
        }
        return original.apply(this, args);
      };
      focusRight.sdSinglePanel = true;
      app.focusRoomRight = focusRight;
    }
    return state;
  } catch (error) {
    setShell(false);
    return null;
  }
}

// Each user's PMs and challenges live in a main-menu .pm-window, hidden rather than removed when
// closed. The .challenge form's buttons show which way a challenge goes.
function readMessages(menu) {
  const box = menu && menu.$pmBox && menu.$pmBox[0];
  if (!box || typeof box.querySelectorAll !== 'function') return [];
  const text = (el) => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
  const out = [];
  for (const el of box.querySelectorAll('.pm-window')) {
    const userid = el.getAttribute('data-userid');
    if (!userid || el.classList.contains('news-embed') || el.style.display === 'none') continue;
    // The client stores the name behind a one-character rank prefix (a space for none).
    const name = (el.getAttribute('data-name') || ' ' + userid).slice(1);
    const header = el.querySelector('h3');
    const form = el.querySelector('.challenge');
    let challenge = null;
    if (form) {
      const button = (n) => form.querySelector('button[name="' + n + '"]');
      const format = button('format');
      const base = {
        format: format ? format.value || '' : '',
        formatName: text(format),
        message: text(form.querySelector('p')),
      };
      if (button('acceptChallenge')) {
        const team = button('team');
        const id = base.format.split('@@@')[0];
        const info = window.BattleFormats && BattleFormats[id];
        const teamFormat = info ? info.teambuilderFormat || (info.isTeambuilderFormat ? id : '') : '';
        const all = (Storage.teams || []).map((t, index) => ({ index, name: t.name, format: t.format }));
        const matching = all.filter((t) => t.format === teamFormat);
        challenge = {
          ...base,
          dir: 'in',
          pending: button('acceptChallenge').disabled,
          // A preset-team format renders a disabled team button: nothing to choose.
          needsTeam: Boolean(team && !team.disabled),
          team: team && /^\d+$/.test(team.value) ? Number(team.value) : null,
          teams: (matching.length ? matching : all).slice(0, 100).map(({ index, name: n }) => ({ index, name: n })),
        };
      } else if (button('cancelChallenge')) {
        challenge = { ...base, dir: 'out' };
      } else if (button('dismissChallenge')) {
        challenge = { ...base, dir: 'cancelled' };
      }
    }
    const lines = el.querySelectorAll('.inner > .chat');
    const lastLine = lines.length ? lines[lines.length - 1] : null;
    const unread = Boolean(header && header.classList.contains('pm-notifying'));
    out.push({
      userid,
      name,
      unread,
      active: el.classList.contains('sd-pm-active'),
      // Only for an unread conversation, so a notification can quote it.
      last: unread && lastLine ? text(lastLine.querySelector('em') || lastLine) : '',
      challenge,
    });
  }
  return out;
}

function pmWindow(userid) {
  const menu = app.rooms[''];
  if (!menu || !menu.$pmBox) return null;
  const $w = menu.$pmBox.find('.pm-window-' + userid);
  return $w.length ? $w : null;
}

// Read-only server lookup; each request owns and removes its response listener.
function findUser(name) {
  if (!window.app || !app.user || app.isDisconnected || typeof app.on !== 'function' ||
      typeof app.off !== 'function' || typeof app.send !== 'function') return { ok: false };
  const userid = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return new Promise(resolve => {
    let timer;
    const finish = result => {
      clearTimeout(timer);
      app.off('response:userdetails', receive);
      resolve(result);
    };
    const receive = data => {
      if (!data || data.userid !== userid) return;
      finish({ ok: true, userid, name: data.name || name, online: data.rooms !== false,
        avatar: typeof Dex !== 'undefined' && typeof Dex.resolveAvatar === 'function'
          ? Dex.resolveAvatar(String(data.avatar || 1)) : '',
        status: typeof data.status === 'string' ? data.status.replace(/^!/, '') : '' });
    };
    app.on('response:userdetails', receive);
    timer = setTimeout(() => finish({ ok: false }), 8000);
    try { app.send('/cmd userdetails ' + userid); } catch { finish({ ok: false }); }
  });
}

function startChat(name, dock) {
  const menu = window.app && app.rooms && app.rooms[''];
  if (!menu || typeof menu.openPM !== 'function' || app.isDisconnected) return false;
  if (!app.user.get('named')) {
    app.addPopup(LoginPopup);
    return 'needs-client';
  }
  menu.openPM(name, true);
  const opened = openPM(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
  if (dock && opened) setChatDock(true, name.toLowerCase().replace(/[^a-z0-9]/g, ''));
  return opened;
}

function setChatDock(enabled, userid) {
  if (!window.app || !app.rooms || !app.rooms['']) return false;
  const root = document.documentElement;
  root.classList.toggle('sd-home-chat', enabled);
  if (enabled) {
    root.classList.toggle('sd-menu-community', false);
    root.classList.toggle('sd-menu-pm', true);
    app.focusRoom('');
    for (const button of document.querySelectorAll('.pm-window[data-userid] > h3 .closebutton')) button.tabIndex = 0;
    if (userid) requestAnimationFrame(() => {
      if (!root.classList.contains('sd-home-chat')) return;
      const el = document.querySelector('.pm-window-' + userid);
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      el?.querySelector('textarea[name=message]')?.focus({ preventScroll: true });
    });
    if (!window.__sdChatDockEvents) {
      window.__sdChatDockEvents = true;
      // Native controls still own sending, closing and challenging.
      document.addEventListener('click', event => {
        if (root.classList.contains('sd-home-chat') && event.target.closest('.pm-challenge, .pm-userOptions')) {
          root.classList.toggle('sd-home-chat', false);
          const el = event.target.closest('.pm-window');
          if (el) openPM(el.getAttribute('data-userid'));
        }
      }, true);
      document.addEventListener('dblclick', event => {
        if (root.classList.contains('sd-home-chat') && event.target.closest('.pm-window > h3')) {
          event.stopImmediatePropagation();
          event.preventDefault();
        }
      }, true);
    }
  }
  return true;
}

// Shows one conversation full size in the main menu (see client-messages.css).
function openPM(userid) {
  const menu = app.rooms[''];
  const $w = pmWindow(userid);
  if (!$w) return false;
  const root = document.documentElement;
  root.classList.toggle('sd-home-chat', false);
  root.classList.toggle('sd-menu-community', false);
  root.classList.toggle('sd-menu-pm', true);
  menu.$pmBox.find('.pm-window.sd-pm-active').removeClass('sd-pm-active');
  $w.addClass('sd-pm-active').show();
  if ($w.data('minimized')) menu.minimizePM($w);
  $w.find('h3').removeClass('pm-notifying');
  app.focusRoom('');
  $w.find('.pm-log').scrollTop($w.find('.inner').height());
  return true;
}

function closePM(userid) {
  const menu = app.rooms[''];
  const $w = pmWindow(userid);
  if (!$w) return true;
  $w.removeClass('sd-pm-active');
  // The client's own close also rejects or cancels a challenge still open in the window.
  menu.closePM(userid);
  return true;
}

// Drives the client's own challenge buttons, so team checks and spectator settings apply.
function answerChallenge(userid, answer, team) {
  const menu = app.rooms[''];
  const $w = pmWindow(userid);
  if (!$w) return false;
  const name = { accept: 'acceptChallenge', reject: 'rejectChallenge', cancel: 'cancelChallenge', dismiss: 'dismissChallenge' }[answer];
  const button = $w.find('.challenge button[name=' + name + ']')[0];
  if (!button || button.disabled) return false;
  if (answer === 'accept' && team !== null && Storage.teams && Storage.teams[team]) {
    const $team = $w.find('.challenge button[name=team]');
    if ($team.length && !$team[0].disabled) {
      $team.replaceWith(menu.renderTeams($w.find('.challenge button[name=format]').val(), team));
    }
  }
  const popups = app.popups.length;
  menu[name](null, button);
  // A popup (such as "build a team first") needs the user to see the client.
  return app.popups.length > popups ? 'needs-client' : true;
}

// The server's /cmd friends response is structured data, unlike the /friends HTML page.
function readFriends(expectedUserid, timeout) {
  if (!window.app || !app.user || !app.user.get('registered') ||
      app.user.get('userid') !== expectedUserid || app.isDisconnected ||
      window.__SD_FRIENDS_TIMED_OUT ||
      typeof app.once !== 'function' || typeof app.off !== 'function' || typeof app.send !== 'function') return null;
  return new Promise((resolve) => {
    let finished = false;
    let timer;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      app.off('response:friends', onResponse);
      resolve(app.user.get('userid') === expectedUserid ? value : null);
    };
    const onResponse = (value) => finish(value);
    app.once('response:friends', onResponse);
    timer = setTimeout(() => {
      // A late untagged reply could otherwise be mistaken for the next account's list.
      window.__SD_FRIENDS_TIMED_OUT = true;
      finish(null);
    }, timeout);
    try { app.send('/cmd friends'); } catch { finish(null); }
  });
}

// Drives the main menu's own search form, so login prompts, team checks and cancel behave as if
// the user clicked Battle! in the client.
function search(format, teamIndex) {
  const menu = app.rooms[''];
  app.focusRoom('');
  const $form = menu.$('.mainmenu button.big[name=search]').closest('form');
  if (!$form.length) return false;
  $form.find('button[name=format]').replaceWith(menu.renderFormats(format));
  $form.find('button[name=team]').replaceWith(menu.renderTeams(format, teamIndex));
  // renderTeams coerces an empty index to 0; keep "no team" so the client shows its missing-team prompt.
  if (teamIndex === null && !BattleFormats[format].team) {
    $form.find('button[name=team]').val('');
  }
  const popups = app.popups.length;
  menu.search(null, $form.find('button.big')[0]);
  // A popup means the client needs the user (login, missing team) before it can search.
  return app.popups.length > popups ? 'needs-client' : true;
}

function cancelSearch() {
  app.rooms[''].cancelSearch();
  return true;
}

// Opens the user's message window with the challenge form, full size rather than the bare main menu.
function challenge(name, format) {
  app.rooms[''].challenge(name, format);
  const userid = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!openPM(userid)) app.focusRoom('');
  return true;
}

function join(roomid) {
  app.joinRoom(roomid);
  app.focusRoom(roomid);
  return true;
}

// Battle and Community are two views of the one main menu room; client-shell.css filters it.
function showMenu(tab) {
  document.documentElement.classList.toggle('sd-menu-community', tab === 'community');
  document.documentElement.classList.toggle('sd-menu-pm', false);
  app.focusRoom('');
  return true;
}

function focusRoom(roomid) {
  if (!app.rooms[roomid]) return false;
  if (window.__sdShowdexDock?.openPanel(roomid)) return true;
  app.focusRoom(roomid);
  return true;
}

// A battle the user is still playing must be forfeited to close. The launcher asks ('needs-forfeit'),
// then forfeit sends the client's own /forfeit and leaves. Other rooms use the client's leave path
// ('needs-client' when it shows a popup).
function leaveRoom(roomid, forfeit) {
  const room = app.rooms[roomid];
  if (!room) return true;
  const live = /^battle-/.test(roomid) && room.battle && (room.side || room.requireForfeit) &&
    !room.battleEnded && !room.expired && !room.battle.forfeitPending;
  if (live) {
    if (!forfeit) return 'needs-forfeit';
    room.send('/forfeit');
    room.battle.forfeitPending = true;
    app.removeRoom(roomid);
    return true;
  }
  return app.leaveRoom(roomid) ? true : 'needs-client';
}

// Closing and selecting happen in one client task, so its fallback room never paints.
function closeClientTab(kind, id, forfeit, next) {
  const result = kind === 'room' ? leaveRoom(id, forfeit) : closePM(id);
  if (result !== true || !next) return result;
  if (next.room) focusRoom(next.room);
  else if (next.user) openPM(next.user);
  else showMenu(next.tab);
  return true;
}

function openSounds() {
  app.addPopup(SoundsPopup);
  return true;
}

function openOptions() {
  app.addPopup(OptionsPopup);
  return true;
}

function editTeam(index, name, format) {
  app.joinRoom('teambuilder');
  app.focusRoom('teambuilder');
  const room = app.rooms.teambuilder;
  // Keep unfinished set/import edits intact; the user can return to the list normally.
  if (!room || room.curTeam || room.exportMode || typeof room.edit !== 'function' || index === null) return true;
  const team = Storage.teams && Storage.teams[index];
  // Home is polled: a deletion or reorder may have changed what this index refers to.
  if (team && typeof team.name === 'string' && team.name.slice(0, 80) === name && team.format === format) room.edit(index);
  return true;
}

function login() {
  app.addPopup(LoginPopup);
  return true;
}

// Opens the friends page at once: joining its room creates and focuses it while the server
// fills it in. An open friends page is just focused.
function friends() {
  const open = Object.keys(app.rooms).find((id) => /^view-friends(-|$)/.test(id));
  if (open) {
    app.focusRoom(open);
    return true;
  }
  app.joinRoom('view-friends-all');
  const room = app.rooms['view-friends-all'];
  // The client shows "Page unavailable" until the page arrives, which replaces this.
  if (room && room.$el) room.$el.html('<div class="pad"><p class="sd-page-loading">Loading…</p></div>');
  return true;
}

function loadShowdex(entry) {
  if (window.__SHOWDOWN_DESKTOP_SHOWDEX || window.__SD_SHOWDEX_REQUESTED) return true;
  window.__SD_SHOWDEX_REQUESTED = true;
  window.__SHOWDOWN_DESKTOP_SHOWDEX = { state: 'loading', version: '1.4.2' };
  let attempts = 0;
  const fail = () => { window.__SHOWDOWN_DESKTOP_SHOWDEX = { state: 'failed', version: '1.4.2' }; };
  const start = () => {
    if (!window.Dex || typeof Dex.gen !== 'number' || typeof Dex.forGen !== 'function' ||
        !window.app || typeof app.receive !== 'function') {
      if (++attempts >= 60) { fail(); return; }
      setTimeout(start, 1000);
      return;
    }
    const script = document.createElement('script');
    script.crossOrigin = 'anonymous';
    script.src = entry;
    script.onerror = fail;
    document.head.append(script);
    setTimeout(() => {
      if (window.__SHOWDOWN_DESKTOP_SHOWDEX.state === 'loading') fail();
    }, 60000);
  };
  start();
  return true;
}

// Shows the client's format picker as a centered modal (client-battle.css). The popup stays the
// client's own; this adds a header and a backdrop, so a click beside it can't press the Battle
// button behind.
function installFormatModal() {
  if (window.__SD_FORMAT_MODAL || !document.body) return true;
  window.__SD_FORMAT_MODAL = true;
  const enhance = (popup) => {
    if (popup.classList.contains('sd-format-modal') || !popup.querySelector('span[name="formats"]')) return;
    if (!document.documentElement.classList.contains('sd-launcher-shell')) return;
    popup.classList.add('sd-format-modal');
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-modal', 'true');
    popup.setAttribute('aria-label', 'Choose a format');
    const head = document.createElement('div');
    head.className = 'sd-modal-head';
    const title = document.createElement('h2');
    title.textContent = 'Choose a format';
    const close = document.createElement('button');
    close.type = 'button';
    close.name = 'close'; // the popup's own button dispatch calls its close()
    close.className = 'sd-modal-close';
    close.setAttribute('aria-label', 'Close');
    head.append(title, close);
    popup.prepend(head);
    // The client re-renders only span[name=formats] (found with find()), so wrapping it is safe.
    const formats = popup.querySelector('span[name="formats"]');
    const body = document.createElement('div');
    body.className = 'sd-modal-body';
    formats.before(body);
    body.append(formats);
    const backdrop = document.createElement('div');
    backdrop.className = 'sd-modal-backdrop';
    backdrop.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (window.app && typeof app.closePopup === 'function') app.closePopup();
    });
    popup.before(backdrop);
    popup.__sdBackdrop = backdrop;
  };
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1 && node.classList.contains('ps-popup')) enhance(node);
      }
      for (const node of record.removedNodes) {
        if (node.__sdBackdrop) node.__sdBackdrop.remove();
      }
    }
  }).observe(document.body, { childList: true });
  return true;
}

// Rebuilds the Teambuilder's team list in the launcher's layout (client-teambuilder.css): header,
// folder chips, cards by format and a storage notice. It only moves, labels and adds elements
// after each render; buttons keep their name and value, so the client's handlers still work.
function installTeamsView() {
  if (window.__SD_TEAMS_VIEW || !document.body) return true;
  window.__SD_TEAMS_VIEW = true;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (name) => el('i', `fa ${name}`);
  const relabel = (button, faIcon, text) => {
    if (!button) return null;
    button.replaceChildren(icon(faIcon), document.createTextNode(` ${text}`));
    return button;
  };
  // "[Gen 9] OU" -> ["Gen 9", "OU"]; unknown IDs fall back to "gen9foo" -> ["Gen 9", "FOO"].
  const formatParts = (id) => {
    const name = (window.BattleFormats && BattleFormats[id] && BattleFormats[id].name) || '';
    let m = /^\[Gen (\d+)\]\s*(.*)$/.exec(name);
    if (m) return [`Gen ${m[1]}`, m[2]];
    m = /^gen(\d+)(.*)$/.exec(id || '');
    if (m) return [`Gen ${m[1]}`, m[2].toUpperCase()];
    return [name || id || 'Other', ''];
  };
  const formatOf = (team) => (team && team.format) || 'gen9';
  const teamCount = (value) => {
    const teams = (window.Storage && Storage.teams) || [];
    if (value === 'all') return teams.length;
    if (value.endsWith('/')) return teams.filter((t) => (t.folder || '') === value.slice(0, -1)).length;
    return teams.filter((t) => formatOf(t) === value).length;
  };

  function newTeamIn(format) {
    const room = window.app && app.rooms && app.rooms.teambuilder;
    if (!room || typeof room.newTop !== 'function') return;
    const previous = room.curFolder;
    room.curFolder = format; // createTeam reads the format from the current folder
    try {
      room.newTop('team');
    } finally {
      room.curFolder = previous;
    }
  }

  function decorateCard(li, team) {
    const card = li.querySelector(':scope > .team');
    const parts = formatParts(formatOf(team));
    card.prepend(el('span', 'sd-tb-badge', parts.filter(Boolean).join(' ')));
    const capacity = (team && team.capacity) || 6;
    const icons = card.querySelector(':scope > small');
    if (icons && capacity <= 6) {
      const have = icons.querySelectorAll(':scope > .picon').length;
      for (let i = have; i < capacity; i++) icons.append(el('span', 'sd-tb-slot'));
    }
    const mons = team && team.team ? team.team.split(']').length : 0;
    const foot = el('span', 'sd-tb-foot');
    foot.append(el('span', 'sd-tb-saved', 'Saved locally'), el('span', 'sd-tb-size', `${mons} / ${capacity} Pokémon`));
    card.append(foot);
    const del = li.querySelector(':scope > button[name="delete"]');
    if (del) {
      del.title = 'Delete';
      del.setAttribute('aria-label', 'Delete');
    }
  }

  function buildHead(room, pane) {
    const head = el('div', 'sd-tb-head');
    const titles = el('div', 'sd-tb-titles');
    const headings = pane.querySelectorAll(':scope > h2');
    const h2 = headings[headings.length - 1];
    let title = 'Your teams';
    if (room.curFolder && h2) {
      const copy = h2.cloneNode(true);
      copy.querySelectorAll('button, small').forEach((n) => n.remove());
      title = copy.textContent.trim();
      if (!room.curFolder.endsWith('/')) title = formatParts(room.curFolder).filter(Boolean).join(' ');
    }
    titles.append(el('h1', '', title), el('p', '', 'Build, organize and back up teams for every format.'));
    const actions = el('div', 'sd-tb-actions');
    if (h2) h2.querySelectorAll('button').forEach((b) => actions.append(b));
    if (!room.curFolder) {
      const importButton = el('button', 'button');
      importButton.name = 'import';
      actions.append(relabel(importButton, 'fa-upload', 'Import'));
    }
    const box = relabel(pane.querySelector('button[name="newTop"][value="box"]'), 'fa-archive', 'New box');
    const team = relabel(pane.querySelector('button[name="newTop"][value="team"]'), 'fa-plus', 'New team');
    if (box) actions.append(box);
    if (team) actions.append(team);
    const search = el('label', 'sd-tb-search');
    const input = pane.querySelector('#teamSearchBar');
    if (input) {
      input.placeholder = 'Search teams or Pokémon';
      search.append(input, el('kbd', '', 'Ctrl K'));
    }
    head.append(titles, actions, search);
    return head;
  }

  function buildBanner(room, pane) {
    const banner = el('div', 'sd-tb-banner');
    const text = el('div', 'sd-tb-banner-text');
    text.append(el('strong', '', 'Your teams live in this app\'s local storage'),
      el('span', '', 'Clearing cookies or localStorage deletes them. Back up first, or sign in to sync to the server.'));
    const actions = el('div', 'sd-tb-banner-actions');
    const uploaded = pane.querySelector('button[name="send"][value="/teams"]');
    if (uploaded) {
      uploaded.className = 'sd-tb-link';
      uploaded.textContent = 'View uploaded teams';
      actions.append(uploaded);
    }
    const backup = relabel(pane.querySelector('button[name="backup"]'), 'fa-download',
      room.curFolder ? 'Back up this folder' : 'Backup / Restore');
    if (backup) actions.append(backup);
    banner.append(el('span', 'sd-tb-banner-icon'), text, actions);
    return banner;
  }

  function renderList(root, pane) {
    const list = pane.querySelector(':scope > ul.teamlist');
    if (!list || list.dataset.sd) return;
    list.dataset.sd = '1';
    const room = window.app && app.rooms && app.rooms.teambuilder;
    if (!room || !window.Storage) return;
    // The old head still holds the focused search box, which the client's re-render would find
    // first by ID; take the focus from it.
    const active = document.activeElement;
    const typing = active && active.id === 'teamSearchBar' && !pane.contains(active);
    const caret = typing ? active.selectionStart : 0;
    root.querySelectorAll(':scope > .sd-tb-head').forEach((n) => n.remove());
    root.prepend(buildHead(room, pane));
    const input = root.querySelector(':scope > .sd-tb-head #teamSearchBar');
    if (typing && input) {
      input.focus();
      input.setSelectionRange(caret, caret);
    }

    const groups = new Map();
    for (const li of [...list.children]) {
      const card = li.querySelector(':scope > .team');
      if (!card) continue;
      const team = Storage.teams[Number(card.dataset.value)];
      const format = formatOf(team);
      if (!groups.has(format)) {
        const section = el('section', 'sd-tb-group');
        section.append(el('h3', '', formatParts(format).filter(Boolean).join(' · ')));
        const grid = el('ul', 'teamlist sd-tb-grid');
        grid.dataset.sd = '1';
        section.append(grid);
        groups.set(format, { section, grid });
      }
      decorateCard(li, team);
      groups.get(format).grid.append(li);
    }
    const wrap = el('div', 'sd-tb-groups');
    for (const [format, { section, grid }] of groups) {
      if (room.curFolder && room.curFolder !== format) {
        wrap.append(section);
        continue;
      }
      const li = el('li', 'sd-tb-new');
      const add = el('button', 'sd-tb-new-btn');
      add.type = 'button';
      add.append(el('span', 'sd-tb-new-plus'), el('span', '', `New ${formatParts(format).filter(Boolean).join(' ')} team`));
      add.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        newTeamIn(format);
      });
      li.append(add);
      grid.append(li);
      wrap.append(section);
    }
    list.after(wrap);
    pane.append(buildBanner(room, pane));
  }

  function renderFolders(pane) {
    const list = pane.querySelector('.folderlist');
    if (!list || list.dataset.sd) return;
    list.dataset.sd = '1';
    for (const chip of list.querySelectorAll('.selectFolder')) {
      const value = chip.dataset.value || '';
      if (value === '+' || value === '++') continue;
      if (value === '/') chip.replaceChildren(document.createTextNode('No folder'));
      if (value !== 'all' && !value.endsWith('/')) {
        // Folder chips drop the generation that hidden group headings gave; spell it out.
        chip.querySelectorAll(':scope > i').forEach((n) => n.remove());
        chip.replaceChildren(document.createTextNode(formatParts(value).filter(Boolean).join(' ')));
      }
      chip.append(el('span', 'sd-tb-count', String(teamCount(value))));
    }
  }

  const update = () => {
    if (!document.documentElement.classList.contains('sd-launcher-shell')) return;
    const root = document.getElementById('room-teambuilder');
    if (!root) return;
    const folders = root.querySelector(':scope > .folderpane');
    const pane = root.querySelector(':scope > .teampane');
    if (!folders || !pane) return;
    try {
      renderFolders(folders);
      renderList(root, pane);
    } catch (e) {} // the client's own list stays usable if this ever fails
  };
  new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
    const input = document.querySelector('#room-teambuilder .sd-tb-head #teamSearchBar');
    if (!input || !input.offsetParent) return;
    event.preventDefault();
    input.focus();
    input.select();
  }, true);
  update();
  return true;
}

// Lays out the team editor in the launcher's design (client-teambuilder.css): a header with the
// team's actions, a vertical roster, inline native forms and a persistent selection pane.
// Editor modes, read from the markup: "team" (overview), "set" and "export".
function installTeamEditor() {
  if (window.__SD_TEAM_EDITOR || !document.body) return true;
  window.__SD_TEAM_EDITOR = true;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (name) => el('i', `fa ${name}`);
  const getRoom = () => window.app && app.rooms && app.rooms.teambuilder;
  const statName = (id) => (window.BattleStatNames && BattleStatNames[id]) || id;
  const guardedRooms = new WeakSet();
  const queries = new WeakMap();
  // Writes only on change, so the observer that called us settles instead of looping.
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  function buildHead(wrapper, room, mode) {
    const pad = wrapper.querySelector(':scope > .pad');
    if (!pad || pad.querySelector(':scope > .sd-te-head')) return;
    const head = el('div', 'sd-te-head');
    const back = pad.querySelector(':scope > button[name="back"]');
    if (back) {
      back.replaceChildren(icon('fa-chevron-left'));
      back.title = mode === 'set' ? 'Team overview' : 'Back to teams';
      if (mode === 'set') back.addEventListener('click', () => tabs.set(room.curTeam, 'full'));
      back.setAttribute('aria-label', back.title);
      head.append(back);
    }
    let name = pad.querySelector(':scope > input.teamnameedit');
    if (!name && mode === 'set') {
      name = el('input', 'textbox teamnameedit');
      name.type = 'text';
      name.value = room.curTeam.name || 'Untitled';
      name.setAttribute('aria-label', 'Team name');
    }
    if (name) {
      const label = el('label', 'sd-te-name');
      label.append(name, icon('fa-pencil'));
      head.append(label);
    } else {
      head.append(el('h1', 'sd-te-title', room.curTeam.name || 'Untitled'));
    }
    const actions = el('div', 'sd-te-actions');
    let format = pad.querySelector('button.teambuilderformatselect');
    if (!format && mode === 'set') {
      format = el('button', 'button teambuilderformatselect');
      format.type = 'button';
      format.name = 'format';
      format.value = room.curTeam.format;
      const info = window.BattleFormats && BattleFormats[room.curTeam.format];
      format.textContent = info ? info.name : room.curTeam.format || 'Select a format';
    }
    const validate = pad.querySelector('button[name="validate"]');
    if (format) actions.append(format);
    if (validate) actions.append(validate);
    for (const button of pad.querySelectorAll(':scope > button[name="import"], :scope > button[name="saveImport"]')) {
      actions.append(button);
    }
    const primary = actions.querySelector('button[name="import"]');
    if (primary) primary.classList.add('sd-te-primary');
    head.append(actions);
    pad.prepend(head);
  }

  // Which tab the team view shows, per team: a set index or "full" for the whole team.
  const tabs = new WeakMap();
  const speciesName = (room, set) => set.name || room.curTeam.dex.species.get(set.species).baseSpecies || set.species;

  function tabBody(room, set, index) {
    const box = el('span', 'sd-te-tab-icon');
    const picon = el('span', `picon pokemonicon-${index}`);
    picon.setAttribute('style', Dex.getPokemonIcon(set));
    box.append(picon);
    const text = el('span', 'sd-te-tab-text');
    text.append(el('strong', '', speciesName(room, set)), el('small', '', set.item || 'No item'));
    return [box, text];
  }

  function selectedTab(room) {
    const count = room.curSetList.filter((set) => set.species).length;
    let tab = tabs.has(room.curTeam) ? tabs.get(room.curTeam) : 0;
    if (typeof tab === 'number' && tab >= count) tab = count ? count - 1 : 'full';
    return tab;
  }

  function showTab(wrapper, room) {
    const tab = selectedTab(room);
    for (const button of wrapper.querySelectorAll('.sd-te-tabs > .sd-te-tab[data-tab]')) {
      const on = button.dataset.tab === String(tab);
      button.classList.toggle('cur', on);
      button.setAttribute('aria-selected', String(on));
    }
    for (const li of wrapper.querySelectorAll('.teamchart > li[value]')) {
      li.classList.toggle('sd-te-cur', li.getAttribute('value') === String(tab));
    }
    const paste = wrapper.querySelector('.sd-te-paste');
    if (paste) paste.hidden = tab !== 'full';
  }

  // The whole team as text, like a PokePaste: the client's export of each set, with species, Tera
  // type and moves coloured by type. Text nodes only, never HTML.
  function buildPaste(wrapper, room) {
    const box = wrapper.querySelector('.teamchartbox');
    if (!box || box.querySelector(':scope > .sd-te-paste')) return;
    if (!room.curSetList.some((set) => set.species)) return;
    const team = room.curTeam;
    const paste = el('section', 'sd-te-paste');
    const head = el('div', 'sd-paste-head');
    head.append(el('h3', '', team.name || 'Untitled'), el('span', '', `Format: ${team.format || 'gen9'}`));
    paste.append(head);
    const typeOf = (kind, name) => {
      try {
        const data = team.dex[kind].get(name);
        return (data.types ? data.types[0] : data.type) || '';
      } catch (e) {
        return '';
      }
    };
    const colored = (text, type) => el('span', type ? `sd-t-${type}` : '', text);
    room.curSetList.forEach((set, index) => {
      if (!set.species) return;
      const entry = el('article', 'sd-paste-set');
      entry.title = 'Edit this Pokémon';
      entry.addEventListener('click', () => {
        room.selectPokemon(index);
      });
      entry.tabIndex = 0;
      entry.setAttribute('role', 'button');
      entry.setAttribute('aria-label', `Edit ${speciesName(room, set)}`);
      entry.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          room.selectPokemon(index);
        }
      });
      const art = el('div', 'sd-paste-art');
      const sprite = el('span', 'sd-paste-sprite');
      sprite.setAttribute('style', Dex.getTeambuilderSprite(set, team.dex));
      art.append(sprite);
      if (set.item) {
        const item = el('span', 'sd-paste-item');
        item.setAttribute('style', Dex.getItemIcon(set.item));
        art.append(item);
      }
      const text = el('pre', 'sd-paste-text');
      const lines = Storage.exportTeam([set]).replace(/\s+$/, '').split('\n');
      lines.forEach((line, i) => {
        const row = el('span', 'sd-paste-line');
        let m;
        if (i === 0) {
          const at = line.lastIndexOf(' @ ');
          const name = at >= 0 ? line.slice(0, at) : line;
          row.append(colored(name, typeOf('species', set.species)));
          if (at >= 0) row.append(el('span', 'sd-paste-at', ' @ '), document.createTextNode(line.slice(at + 3)));
        } else if ((m = /^- (.*)$/.exec(line))) {
          row.append(colored('- ', typeOf('moves', m[1])), document.createTextNode(m[1]));
        } else if ((m = /^(Tera Type): (.*)$/.exec(line))) {
          row.append(el('span', 'sd-paste-label', `${m[1]}: `), colored(m[2], m[2]));
        } else if ((m = /^([A-Za-z ]+): (.*)$/.exec(line))) {
          row.append(el('span', 'sd-paste-label', `${m[1]}: `), document.createTextNode(m[2]));
        } else {
          row.textContent = line;
        }
        text.append(row, document.createTextNode('\n'));
      });
      entry.append(art, text);
      paste.append(entry);
    });
    box.append(paste);
  }

  // The native teambar is rebuilt by Showdown after species changes. Keep our roster
  // separate so search and inline edits never depend on that markup's lifetime.
  function buildRoster(wrapper, room, mode) {
    let roster = wrapper.querySelector(':scope > .sd-te-roster');
    if (!roster) {
      roster = el('nav', 'sd-te-roster');
      roster.setAttribute('aria-label', 'Team Pokémon');
      wrapper.append(roster);
    }
    const sets = room.curSetList;
    const capacity = Math.max(6, room.curTeam.capacity || 6, sets.length);
    const key = JSON.stringify([mode, room.curSetLoc, capacity, !!room.deletedSet,
      sets.map(set => [set.species, set.name, set.item, set.shiny, set.gender])]);
    if (roster.dataset.key === key) return;
    roster.dataset.key = key;
    const heading = el('div', 'sd-te-roster-head');
    heading.append(el('strong', '', 'Your team'), el('span', '', `${sets.filter(set => set.species).length} / ${capacity}`));
    roster.replaceChildren(heading);
    for (let index = 0; index < capacity; index++) {
      const set = sets[index];
      const button = el('button', 'sd-te-tab sd-te-slot');
      button.type = 'button';
      button.dataset.slot = String(index);
      const selected = mode === 'set' && index === room.curSetLoc;
      button.classList.toggle('cur', selected);
      if (selected) button.setAttribute('aria-current', 'true');
      if (set && set.species) {
        button.append(...tabBody(room, set, index));
        button.setAttribute('aria-label', `Slot ${index + 1}: ${speciesName(room, set)}`);
      } else {
        const box = el('span', 'sd-te-tab-icon');
        box.append(icon('fa-plus'));
        const text = el('span', 'sd-te-tab-text');
        text.append(el('strong', '', 'Add Pokémon'), el('small', '', `Empty slot ${index + 1}`));
        button.append(box, text);
        button.classList.add('sd-te-empty-slot');
        button.setAttribute('aria-label', `Add Pokémon, empty slot ${index + 1}`);
      }
      button.addEventListener('click', () => {
        commitSearch(wrapper, room);
        if (set && set.species) room.selectPokemon(index);
        else room.addPokemon();
      });
      roster.append(button);
    }
    const full = el('button', 'sd-te-tab sd-te-full');
    full.type = 'button';
    full.append(icon('fa-list'), el('span', '', 'Team overview'));
    if (mode === 'team') full.setAttribute('aria-current', 'true');
    full.addEventListener('click', () => {
      commitSearch(wrapper, room);
      tabs.set(room.curTeam, 'full');
      if (room.curSet) room.back();
    });
    roster.append(full);
    if (room.deletedSet) {
      const undo = el('button', 'button sd-te-undo', 'Undo delete');
      undo.type = 'button';
      undo.addEventListener('click', () => {
        // Native undo clears the chart name before refreshing it. A form refresh
        // avoids its empty input selector while restoring the same native set.
        room.curChartType = 'details';
        room.undeleteSet();
      });
      roster.append(undo);
    }
  }

  // Team view side panel: the client's upload form and tier resource links (loaded from Smogon,
  // which re-renders the editor).
  function buildAside(wrapper, room) {
    const box = wrapper.querySelector('.teamchartbox');
    if (!box || box.querySelector(':scope > .sd-te-aside')) return;
    const aside = el('aside', 'sd-te-aside');
    const form = box.querySelector('#pokepasteForm');
    if (form) {
      const card = el('section', 'sd-te-card');
      card.append(el('h3', '', 'Save & share'));
      const label = (button, faIcon, title, note) => {
        const text = el('span', 'sd-te-btext');
        text.append(el('strong', '', title));
        if (note) text.append(el('small', '', note));
        button.replaceChildren(icon(faIcon), text);
      };
      for (const button of form.querySelectorAll('button')) {
        if (button.name === 'psExport') label(button, 'fa-cloud-upload', 'Upload to Showdown', 'Saves across devices');
        else if (button.value === 'openteamsheet') label(button, 'fa-link', 'Upload to PokePaste', 'Open Team Sheet');
        else label(button, 'fa-link', 'Upload to PokePaste');
      }
      card.append(form);
      aside.append(card);
    }
    const links = [...box.querySelectorAll(':scope > ul a[href]')];
    if (links.length) {
      const card = el('section', 'sd-te-card sd-te-resources');
      const format = window.BattleFormats && BattleFormats[room.curTeam.format];
      const tier = format ? format.name.replace(/^\[Gen \d+\]\s*/, '') : 'Tier';
      card.append(el('h3', '', `${tier} resources`));
      const list = el('ul');
      for (const link of links) {
        const copy = link.cloneNode(true);
        copy.append(icon('fa-external-link'));
        const item = el('li');
        item.append(copy);
        list.append(item);
      }
      card.append(list);
      const dex = box.querySelector(':scope > div > a[href*="smogon.com"]');
      if (dex) {
        const more = el('p', 'sd-te-more', 'More for this tier on ');
        more.append(dex.cloneNode(true));
        card.append(more);
      }
      aside.append(card);
    }
    box.append(aside);
  }

  const PICKER_TITLES = { pokemon: 'Choose a Pokémon', item: 'Choose an item', ability: 'Choose an ability' };
  const searching = (room) => ['pokemon', 'item', 'ability', 'move'].includes(room.curChartType);
  const chartInput = (wrapper, room) => wrapper.querySelector(`.teamchart input[name="${room.curChartName}"]`);

  function commitSearch(wrapper, room) {
    const proxy = wrapper.querySelector('.sd-te-picker-search input');
    const real = searching(room) && chartInput(wrapper, room);
    if (real && proxy && proxy.dataset.for === room.curChartName) {
      real.value = proxy.value;
      room.chartChange({ currentTarget: real });
    }
    if (room.curSet) queries.delete(room.curSet);
  }

  function buildPicker(wrapper, room) {
    let frame = wrapper.querySelector(':scope > .sd-te-picker');
    if (!frame) {
      frame = el('section', 'sd-te-picker');
      frame.setAttribute('aria-label', 'Selection');
      const head = el('div', 'sd-te-picker-head');
      const title = el('h2');
      title.id = 'sd-te-picker-title';
      const search = el('label', 'sd-te-picker-search');
      const proxy = el('input', 'textbox');
      proxy.type = 'search';
      proxy.autocomplete = 'off';
      proxy.spellcheck = false;
      proxy.setAttribute('aria-labelledby', title.id);
      proxy.addEventListener('input', () => {
        const real = chartInput(wrapper, room);
        if (!real) return;
        real.value = proxy.value;
        queries.set(room.curSet, { name: room.curChartName, format: room.curTeam.format,
          value: proxy.value, focused: document.activeElement === proxy, caret: proxy.selectionStart });
        room.updateChart();
        // updateChart initializes a new field with its default roster; an explicit
        // query must also be applied when this is the first input after a rebuild.
        if (room.search.find(proxy.value) && room.search.q) room.$chart.find('a').first().addClass('hover');
      });
      proxy.addEventListener('keydown', event => {
        const real = chartInput(wrapper, room);
        if (!real) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          proxy.value = real.value = '';
          queries.set(room.curSet, { name: room.curChartName, format: room.curTeam.format, value: '' });
          room.updateChart();
          return;
        }
        real.value = proxy.value;
        room.chartKeydown({
          keyCode: event.keyCode, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
          altKey: event.altKey, metaKey: event.metaKey, currentTarget: real,
          preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(),
        });
        if (real.isConnected && proxy.dataset.for === real.name) proxy.value = real.value;
      });
      search.append(proxy);
      head.append(title, search);
      frame.append(head, el('p', 'sd-te-picker-empty', 'Select a Pokémon, item, ability or move to browse the available choices.'));
      const results = wrapper.querySelector(':scope > .teambuilder-results');
      if (results) frame.append(results);
      wrapper.append(frame);
      // Tier-resource responses rebuild the native view asynchronously. Preserve
      // an in-progress query for this set/field across that rebuild.
      const query = queries.get(room.curSet);
      if (query && query.name === room.curChartName && query.format === room.curTeam.format) {
        const real = chartInput(wrapper, room);
        if (real) {
          real.value = query.value;
          room.updateChart(true);
          if (room.search.find(query.value) && room.search.q) room.$chart.find('a').first().addClass('hover');
          if (query.focused) {
            proxy.value = query.value;
            proxy.focus({ preventScroll: true });
            proxy.setSelectionRange(query.caret ?? query.value.length, query.caret ?? query.value.length);
          }
        }
      }
    }
    // The native client focuses the next field after a choice. Follow that field without
    // replacing the BattleSearch result element, whose scroll listener loads more rows.
    const active = document.activeElement;
    if (active && active.classList.contains('chartinput') && wrapper.contains(active) &&
        active.name !== room.curChartName) room.chartFocus({ currentTarget: active });
    const isSearch = searching(room);
    if (isSearch && room.curChartName && room.$chart && !room.$chart[0].childElementCount) room.updateChart(true);
    // Keep the native one-row column order. Truncated text remains available on hover.
    for (const column of frame.querySelectorAll('.result > a > :is(.namecol, .pokemonnamecol, .shortpokemonnamecol, .movenamecol, .shortmovenamecol, .itemdesccol, .abilitydesccol, .movedesccol):not([title])')) {
      column.title = column.textContent;
    }
    frame.classList.toggle('sd-te-picker-idle', !isSearch);
    const move = /^move(\d)$/.exec(room.curChartName || '');
    setText(frame.querySelector('h2'), move ? `Choose move ${move[1]}` : PICKER_TITLES[room.curChartType] || 'Selection');
    const proxy = frame.querySelector('input');
    const real = isSearch && chartInput(wrapper, room);
    for (const input of wrapper.querySelectorAll('.chartinput')) {
      const selected = input === real;
      if (input.dataset.active !== String(selected)) input.dataset.active = String(selected);
      input.setAttribute('aria-label', /^move\d$/.test(input.name) ? `Move ${input.name.slice(4)}` : input.name === 'pokemon' ? 'Pokémon' : input.name);
    }
    if (!real) return;
    if (proxy.dataset.for !== room.curChartName || document.activeElement === real) {
      proxy.dataset.for = room.curChartName;
      proxy.value = real.value;
      proxy.placeholder = `Search ${room.curChartType === 'pokemon' ? 'Pokémon' : room.curChartType === 'ability' ? 'abilities' : `${room.curChartType}s`}`;
    }
  }

  // Native form handlers read and update this.$chart. Redirect it only for the synchronous
  // inline operation, restoring search state even if upstream throws.
  function inForm(room, node, type, action) {
    const chart = room.$chart, chartType = room.curChartType, chartName = room.curChartName;
    try {
      room.$chart = room.$(node);
      room.curChartType = room.curChartName = type;
      return action();
    } finally {
      room.$chart = chart;
      room.curChartType = chartType;
      room.curChartName = chartName;
    }
  }

  function buildForms(wrapper, room) {
    const box = wrapper.querySelector('.teamchartbox.individual');
    if (!box || !room.curSet || !room.curSet.species) return;
    for (const type of ['details', 'stats']) {
      let section = box.querySelector(`.sd-te-form[data-form="${type}"]`);
      if (!section) {
        section = el('section', 'sd-te-form');
        section.dataset.form = type;
        section.setAttribute('aria-label', type === 'stats' ? 'Stats, EVs, IVs and nature' : 'Pokémon details');
        box.append(section);
        section.addEventListener('toggle', event => {
          if (event.target.matches('.sd-te-extra') && section.contains(event.target)) section.dataset.expanded = String(event.target.open);
        }, true);
        // Capture native delegated events here so each handler sees the correct form.
        for (const eventName of ['input', 'keyup', 'change', 'submit', 'click']) {
          section.addEventListener(eventName, event => {
            const target = event.target;
            let method;
            if (type === 'details' && ((eventName === 'change' && target.matches('input, select')) || eventName === 'submit')) method = 'detailsChange';
            if (type === 'stats') {
              if ((eventName === 'keyup' || eventName === 'input' || eventName === 'change') && target.matches('input.numform')) method = 'statChange';
              if (target.matches('.evslider') && eventName === 'input') method = 'statSlide';
              if (target.matches('.evslider') && eventName === 'change') method = 'statSlided';
              if (eventName === 'change' && target.name === 'nature') method = 'natureChange';
              if (eventName === 'change' && target.name === 'ivspread') method = 'ivSpreadChange';
              const button = eventName === 'click' && target.closest('button[name]');
              if (button && ['setStatFormGuesses', 'setStatFormOptimization'].includes(button.name)) method = button.name;
            }
            if (!method || typeof room[method] !== 'function') return;
            event.stopPropagation();
            if (eventName === 'click' || eventName === 'submit') event.preventDefault();
            inForm(room, section, type, () => room[method]({ currentTarget: target, target,
              preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() }));
            section.dataset.key = formKey(room);
          }, true);
        }
      }
      // Move a native form opened by automatic keyboard progression into its inline home.
      const native = room.$chart && room.$chart[0];
      if (native && native !== section && native.querySelector(type === 'stats' ? '.statform' : '.detailsform')) {
        section.replaceChildren(...native.childNodes);
        section.dataset.key = '';
      }
      const key = formKey(room);
      if (section.dataset.key !== key && !section.contains(document.activeElement)) {
        const expanded = section.querySelector('.sd-te-extra')?.open ?? (section.dataset.expanded === 'true');
        inForm(room, section, type, () => type === 'stats' ? room.updateStatForm() : room.updateDetailsForm());
        section.dataset.expanded = String(expanded);
        // Show happiness consistently. Upstream already accepts and persists this field.
        if (type === 'details' && room.curTeam.gen > 1 && !section.querySelector('[name="happiness"]')) {
          const row = el('div', 'formrow');
          const label = el('label', 'formlabel', 'Happiness:');
          const input = el('input', 'textbox inputform numform');
          input.type = 'number'; input.name = 'happiness'; input.min = '0'; input.max = '255';
          input.value = String(room.curSet.happiness ?? 255);
          label.htmlFor = input.id = 'sd-te-happiness';
          const field = el('div'); field.append(input); row.append(label, field);
          section.querySelector('.detailsform').append(row);
        }
        for (const input of section.querySelectorAll('input[name], select[name]')) {
          if (!input.getAttribute('aria-label')) input.setAttribute('aria-label',
            input.name.startsWith('stat-') ? `${statName(input.name.slice(5))} EVs` :
              input.name.startsWith('iv-') ? `${statName(input.name.slice(3))} ${room.curTeam.gen <= 2 ? 'DVs' : 'IVs'}` : input.name);
        }
        const title = section.querySelector('h3');
        if (title && type === 'stats') title.textContent = 'Stats & training';
        section.dataset.key = formKey(room);
      }
      if (type === 'stats') {
        const statForm = section.querySelector('.statform');
        if (statForm && !statForm.querySelector('.sd-te-stat-table')) {
          const table = el('div', 'sd-te-stat-table');
          const columns = statForm.querySelectorAll(':scope > .col');
          if (columns.length) {
            columns[0].before(table);
            table.append(...columns);
          }
        }
        const total = section.querySelector('.statscol > div');
        if (total) setText(total, 'Stat');
        const remaining = section.querySelector('.totalev');
        if (remaining) remaining.setAttribute('aria-label', `Remaining EVs: ${remaining.textContent}`);
        const spread = section.querySelector('[name="ivspread"]');
        if (spread && !spread.closest('.sd-te-ivspread')) {
          const previous = spread.parentElement;
          const row = el('p', 'sd-te-ivspread');
          row.append(spread);
          previous.remove();
          section.querySelector('.statform').append(row);
        }
      }
      // Keep the everyday controls in view. Less-used native controls stay in their
      // original form (and use the same handlers) behind an inline disclosure.
      const form = section.querySelector(type === 'stats' ? '.statform' : '.detailsform');
      if (form && !form.querySelector('.sd-te-extra')) {
        const extra = el('details', 'sd-te-extra');
        extra.open = section.dataset.expanded === 'true';
        extra.append(el('summary', '', type === 'stats' ? 'Spread tools & tips' : 'More details'));
        if (type === 'details') {
          for (const row of form.querySelectorAll(':scope > .formrow')) {
            if (!row.querySelector('[name="level"], [name="happiness"], [name="teratype"], [name="dynamaxlevel"]')) extra.append(row);
          }
          const sprite = section.querySelector(':scope > .altform');
          if (sprite) extra.append(sprite);
        } else {
          for (const row of form.querySelectorAll(':scope > p')) {
            if (!row.querySelector('[name="nature"]')) extra.append(row);
          }
        }
        if (extra.children.length > 1) form.append(extra);
      }
    }
    box.classList.add('sd-te-inline-ready');
  }

  function formKey(room) {
    return JSON.stringify([room.curTeam.format, room.curSet]);
  }

  function natureText(set) {
    const nature = set.nature || 'Serious';
    const data = window.BattleNatures && BattleNatures[nature];
    const effect = data && data.plus ? `+${statName(data.plus)} −${statName(data.minus)}` : 'Neutral';
    return [nature, effect];
  }

  function decorateSet(li, room) {
    const set = room.curSetList && room.curSetList[Number(li.getAttribute('value'))];
    const chart = li.querySelector(':scope > .setchart');
    if (!set || !chart) return;
    const team = room.curTeam;
    const format = team.format || '';
    const usesEVs = team.gen > 2 && !format.includes('letsgo') && !format.includes('champions');

    if (!li.dataset.sd) {
      li.dataset.sd = '1';
      for (const button of li.querySelectorAll('.setmenu button')) {
        button.title = button.textContent.trim();
        button.setAttribute('aria-label', button.title);
      }
      if (set.species) {
        const meta = el('div', 'sd-te-meta');
        meta.append(el('span', 'sd-te-chips'));
        const menu = li.querySelector('.setmenu');
        if (menu) meta.append(menu);
        const nickname = li.querySelector(':scope > .setchart-nickname');
        if (nickname) meta.append(nickname);
        li.append(meta, el('div', 'sd-te-rule'));
      }
      const itemIcon = li.querySelector('.setrow-icons .itemicon');
      const itemCell = li.querySelector('.setcell-item');
      if (itemIcon && itemCell) itemCell.prepend(itemIcon);
      const stats = li.querySelector('.setcol-stats');
      if (stats) {
        stats.append(el('span', 'sd-te-evleft'));
        if (usesEVs) {
          // Not name="stats": the client rewrites every such button with the stat graph.
          const nature = el('button', 'sd-te-nature');
          nature.type = 'button';
          nature.addEventListener('click', () => room.stats(undefined, nature));
          stats.append(nature);
        }
      }
    }

    // The client draws the sprite as the chart's background; the card shows it in its box.
    const sprite = li.querySelector('.setcell-sprite');
    if (sprite && sprite.style.backgroundImage !== chart.style.backgroundImage) {
      sprite.style.backgroundImage = chart.style.backgroundImage;
      sprite.style.backgroundSize = chart.style.backgroundSize;
    }
    if (sprite) sprite.classList.toggle('pixelated', chart.classList.contains('pixelated'));

    const chips = li.querySelector('.sd-te-chips');
    if (chips) {
      const species = team.dex.species.get(set.species);
      const types = species.types || [];
      const tera = team.gen === 9 && !format.includes('champions') ?
        (set.teraType || species.requiredTeraType || types[0] || '') : '';
      const key = `${types.join(',')}|${tera}`;
      if (chips.dataset.key !== key) {
        chips.dataset.key = key;
        chips.replaceChildren(...types.map((type) => el('span', `sd-te-type sd-t-${type}`, type)));
        if (tera) chips.append(el('span', `sd-te-tera sd-t-${tera}`, `Tera ${tera}`));
      }
    }

    const left = li.querySelector('.sd-te-evleft');
    if (left) {
      let text = '';
      if (usesEVs && !room.ignoreEVLimits) {
        const total = Object.values(set.evs || {}).reduce((sum, ev) => sum + (Number(ev) || 0), 0);
        text = total > 510 ? `${total - 510} over` : `${Math.max(508 - total, 0)} left`;
      }
      setText(left, text);
    }
    const nature = li.querySelector('.sd-te-nature');
    if (nature) {
      const [name, effect] = natureText(set);
      if (nature.dataset.key !== `${name}|${effect}`) {
        nature.dataset.key = `${name}|${effect}`;
        nature.replaceChildren(el('span', '', 'Nature'), el('strong', '', name), el('span', 'sd-te-effect', effect));
      }
    }

    // Stat rows are re-rendered as markup on each change; restyle the fresh ones.
    for (const row of li.querySelectorAll('.setstats .statrow:not(.statrow-head):not([data-sd])')) {
      row.dataset.sd = '1';
      const bar = row.querySelector('.statgraph span');
      if (bar) bar.style.width = `${Math.min(100, (parseFloat(bar.style.width) || 0) / 75 * 100)}%`;
      const mark = row.querySelector('small');
      if (mark) row.classList.add(mark.textContent === '+' ? 'sd-plus' : 'sd-minus');
      const ev = row.querySelector('em');
      if (ev && !ev.textContent) {
        ev.textContent = '0';
        row.classList.add('sd-zero');
      }
    }
  }

  let watched = null;
  const update = () => {
    if (!document.documentElement.classList.contains('sd-launcher-shell')) return;
    const root = document.getElementById('room-teambuilder');
    if (!root) return;
    if (watched !== root) {
      // Sprite and stat updates change inline styles only; watch those inside the room.
      watched = root;
      new MutationObserver(update).observe(root, { attributes: true, attributeFilter: ['style'], subtree: true });
    }
    const room = getRoom();
    const wrapper = root.querySelector(':scope > .teamwrapper');
    if (!room || !room.curTeam || !wrapper) return;
    if (!guardedRooms.has(room) && typeof room.importSetButtons === 'function') {
      const original = room.importSetButtons;
      room.importSetButtons = function (...args) {
        // Sample-set requests can finish after leaving the Pokémon or team.
        if (!this.curTeam || !this.curSet || !this.el.querySelector('.teambuilder-pokemon-import')) return;
        return original.apply(this, args);
      };
      guardedRooms.add(room);
    }
    const mode = wrapper.querySelector(':scope > .teambar') ? 'set' :
      wrapper.querySelector(':scope > .teamedit') ? 'export' : 'team';
    if (wrapper.dataset.sdMode !== mode) wrapper.dataset.sdMode = mode;
    try {
      buildHead(wrapper, room, mode);
      if (mode === 'team') {
        if (!tabs.has(room.curTeam)) {
          if (room.curSetList.length) room.selectPokemon(0);
          else room.addPokemon();
          return;
        }
        tabs.set(room.curTeam, 'full');
        buildPaste(wrapper, room);
        buildAside(wrapper, room);
        showTab(wrapper, room);
      }
      if (mode !== 'export') buildRoster(wrapper, room, mode);
      if (mode === 'set') {
        tabs.set(room.curTeam, room.curSetLoc);
        buildPicker(wrapper, room);
        buildForms(wrapper, room);
      }
      for (const li of wrapper.querySelectorAll('.teamchart > li[value]')) decorateSet(li, room);
    } catch (e) {} // the client's own editor stays usable if this ever fails
  };
  new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  // Focusing the same native chart again need not mutate its DOM. Input values are
  // properties too, so keep the roster/forms in sync after those delegated events.
  for (const eventName of ['focusin', 'input', 'change']) {
    document.addEventListener(eventName, event => {
      if (!event.target.closest('#room-teambuilder')) return;
      const room = getRoom();
      if (eventName === 'focusin' && room && room.curSet && !event.target.matches('.chartinput, .sd-te-picker-search input')) {
        const query = queries.get(room.curSet);
        if (query) query.focused = false;
      }
      if (eventName === 'input' && event.target.matches('.chartinput') && room && room.curSet) {
        queries.set(room.curSet, { name: event.target.name, format: room.curTeam.format,
          value: event.target.value, focused: document.activeElement === event.target, caret: event.target.selectionStart });
        room.updateChart();
      }
      queueMicrotask(update);
    });
  }
  document.addEventListener('click', event => {
    const input = event.target.closest('#room-teambuilder .chartinput');
    const room = getRoom();
    if (input && room) {
      room.chartFocus({ currentTarget: input });
      queueMicrotask(update);
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) ||
        !event.target.matches('#room-teambuilder .chartinput, #room-teambuilder .sd-te-picker-search input')) return;
    queueMicrotask(() => document.querySelector('#room-teambuilder .sd-te-picker a.hover')?.scrollIntoView({ block: 'nearest' }));
  }, true);
  update();
  return true;
}

// Packed Teambuilder teams of one format, for practice. Main checks and uses them; only names
// reach the Bots page.
function readTeams(format) {
  if (!window.Storage || !Array.isArray(Storage.teams)) return null;
  return Storage.teams.map((t, index) => ({ index, name: t.name, format: t.format, team: t.team }))
    .filter((t) => t.format === format);
}

function readShowdex() {
  const state = window.__SHOWDOWN_DESKTOP_SHOWDEX;
  // The pinned bootstrap sets this only after render; closing its room does not unload it.
  if (state && state.version === '1.4.2' && state.state === 'loaded') return 'loaded';
  return state && state.state === 'failed' ? 'failed' : 'loading';
}
/* eslint-enable no-undef */

function call(fn, ...args) {
  return `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`;
}

// Like call, with page-side helper functions declared in scope first.
function callWith(helpers, fn, ...args) {
  return `(() => {\n${helpers.map(String).join('\n')}\nreturn ${call(fn, ...args)};\n})()`;
}

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function count(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function spriteUrl(path) {
  return typeof path === 'string' && SPRITE.test(path) ? `${SHOWDOWN}${path}.png` : null;
}

// A news post's full text for Home: paragraphs of plain-text runs and links (http(s) only, opened
// in the browser). Bounded in size; whitespace collapsed as a browser would.
function newsBody(value) {
  if (!Array.isArray(value)) return [];
  let budget = 6000;
  const out = [];
  for (const para of value.slice(0, 20)) {
    if (!Array.isArray(para) || budget <= 0) continue;
    const runs = [];
    for (const run of para.slice(0, 80)) {
      if (!run || typeof run.text !== 'string' || budget <= 0) continue;
      const text = run.text.replace(/\s+/g, ' ').slice(0, Math.min(1000, budget));
      if (!text) continue;
      budget -= text.length;
      let href = '';
      if (typeof run.href === 'string' && run.href.length <= 500) {
        try {
          const url = new URL(run.href);
          if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) href = url.href;
        } catch {}
      }
      const last = runs[runs.length - 1];
      // Neighbouring plain text joins up, so the paragraph is a few runs rather than many.
      if (!href && last && !last.href) last.text += text;
      else runs.push(href ? { text, href } : { text });
    }
    if (runs.length) {
      runs[0].text = runs[0].text.replace(/^ /, '');
      const end = runs[runs.length - 1];
      end.text = end.text.replace(/ $/, '');
      if (runs.some((r) => r.text)) out.push(runs.filter((r) => r.text));
    }
  }
  return out;
}

// Everything from the page is treated as untrusted and reduced to plain, bounded values.
function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || !raw.ready) return { ready: false };
  const list = (value) => (Array.isArray(value) ? value : []);
  const user = raw.user || {};
  return {
    ready: true,
    connected: Boolean(raw.connected),
    user: {
      name: str(user.name, 40),
      userid: isId(user.userid) ? user.userid : '',
      registered: Boolean(user.registered),
    },
    counts: { users: count(raw.counts && raw.counts.users), battles: count(raw.counts && raw.counts.battles) },
    currentFormat: isId(raw.currentFormat) ? raw.currentFormat : '',
    formats: list(raw.formats)
      .filter((f) => f && isId(f.id))
      .slice(0, 600)
      .map((f) => ({ id: f.id, name: str(f.name, 80), section: str(f.section, 60), presetTeam: Boolean(f.presetTeam) })),
    teams: list(raw.teams)
      .slice(0, 1000)
      .map((t) => ({
        index: count(t && t.index),
        name: str(t && t.name, 80),
        format: isId(t && t.format) ? t.format : '',
        sprites: list(t && t.sprites).slice(0, 6).map(spriteUrl),
      }))
      .filter((t) => t.index !== null),
    news: list(raw.news).slice(0, 3).map((n) => ({
      id: /^\d{1,8}$/.test(n && n.id) ? n.id : '',
      date: count(n && n.date),
      title: str(n && n.title, 120),
      text: str(n && n.text, 400),
      body: newsBody(n && n.body),
      author: str(n && n.author, 40),
    })),
    rooms: list(raw.rooms).slice(0, 300).map((r) => ({
      title: str(r && r.title, 60),
      desc: str(r && r.desc, 200),
      users: count(r && r.users),
      section: str(r && r.section, 40),
    })),
  };
}

const USER_ID = /^[a-z0-9]{1,18}$/;
const CHALLENGE_DIRS = ['in', 'out', 'cancelled'];

function plain(value, max) {
  return str(value, max * 2).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Conversations and challenges as bounded plain values. Formats may carry custom rules after
// "@@@", so they stay bounded text, not IDs.
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const m of raw.slice(0, 50)) {
    if (!m || typeof m !== 'object' || typeof m.userid !== 'string' || !USER_ID.test(m.userid) || seen.has(m.userid)) continue;
    seen.add(m.userid);
    const c = m.challenge;
    let challenge = null;
    if (c && typeof c === 'object' && CHALLENGE_DIRS.includes(c.dir)) {
      const format = plain(c.format, 300);
      challenge = {
        dir: c.dir,
        format: /^[a-z0-9]{1,60}(@@@.*)?$/.test(format) ? format : '',
        formatName: plain(c.formatName, 80),
        message: plain(c.message, 200),
      };
      if (c.dir === 'in') {
        const teams = (Array.isArray(c.teams) ? c.teams : [])
          .filter((t) => t && Number.isSafeInteger(t.index) && t.index >= 0 && t.index < 10000)
          .slice(0, 100)
          .map((t) => ({ index: t.index, name: plain(t.name, 80) || 'Untitled team' }));
        challenge.pending = Boolean(c.pending);
        challenge.needsTeam = Boolean(c.needsTeam);
        challenge.teams = teams;
        challenge.team = Number.isSafeInteger(c.team) && teams.some((t) => t.index === c.team) ? c.team : null;
      }
    }
    out.push({
      userid: m.userid,
      name: plain(m.name, 40) || m.userid,
      unread: Boolean(m.unread),
      active: Boolean(m.active),
      last: plain(m.last, 200),
      challenge,
    });
  }
  return out;
}

function sanitizeAvatar(value) {
  try {
    const url = new URL(typeof value === 'string' && value.length <= 300 ? value : '', SHOWDOWN);
    if (url.origin === new URL(SHOWDOWN).origin && !url.username && !url.password && !url.search && !url.hash &&
        /^\/sprites\/trainers(?:-custom)?\/[a-z0-9_-]+\.png$/i.test(url.pathname)) return url.href;
  } catch {}
  return '';
}

function sanitizeSession(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rooms)) return { ready: false, rooms: [] };
  const messages = sanitizeMessages(raw.messages);
  const pmOpen = typeof raw.pmOpen === 'string' && messages.some((m) => m.userid === raw.pmOpen) ? raw.pmOpen : '';
  const avatar = sanitizeAvatar(raw.avatar);
  return {
    ready: true,
    me: str(raw.me, 40),
    ...(avatar ? { avatar } : {}),
    named: Boolean(raw.named),
    menuUnread: Boolean(raw.menuUnread),
    menuTab: raw.menuTab === 'pm' && pmOpen ? 'pm' : raw.menuTab === 'community' ? 'community' : 'battle',
    pmOpen,
    messages,
    ...(raw.chatDock === true ? { chatDock: true } : {}),
    shell: Boolean(raw.shell),
    connected: Boolean(raw.connected),
    current: typeof raw.current === 'string' && ROOM_ID.test(raw.current) ? raw.current : '',
    search: {
      pending: Boolean(raw.search && raw.search.pending),
      formats: (raw.search && Array.isArray(raw.search.formats) ? raw.search.formats : []).filter(isId).slice(0, 10),
    },
    popups: count(raw.popups) || 0,
    rooms: raw.rooms
      .filter((r) => r && typeof r.id === 'string' && ROOM_ID.test(r.id))
      .slice(0, 50)
      .map((r) => ({
        id: r.id,
        title: str(r.title, 80),
        battle: Boolean(r.battle),
        players: (Array.isArray(r.players) ? r.players : []).slice(0, 2).map((p) => str(p, 40)),
        format: str(r.format, 80),
        formatId: (BATTLE_FORMAT.exec(r.id) || [])[1] || '',
        ended: Boolean(r.ended),
        kind: ROOM_KINDS.includes(r.kind) ? r.kind : 'other',
        turn: r.battle && Number.isSafeInteger(r.turn) && r.turn >= 0 && r.turn < 10000 ? r.turn : null,
        unread: Boolean(r.unread),
      })),
  };
}

function sanitizeFriends(raw) {
  if (!Array.isArray(raw) || raw.length > 1000) return { available: false, items: [] };
  const seen = new Set();
  const items = [];
  for (const friend of raw) {
    if (!friend || typeof friend !== 'object' ||
        typeof friend.userid !== 'string' || !/^[a-z0-9]{1,18}$/.test(friend.userid) ||
        typeof friend.online !== 'boolean' ||
        !(friend.online ? ['online', 'idle', 'busy'].includes(friend.status) : friend.status === 'offline') ||
        seen.has(friend.userid)) continue;
    const name = str(friend.name, 40).replace(/[\u0000-\u001f\u007f]/g, '').trim() || friend.userid;
    seen.add(friend.userid);
    items.push({ userid: friend.userid, name, online: friend.online, status: friend.status });
  }
  return { available: raw.length === 0 || items.length > 0, items };
}

// The promise's value if it settles within the snapshot's budget, else the fallback. It keeps
// running and fills its cache for the next read.
function within(promise, fallback) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), SNAPSHOT_NETWORK_WAIT); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function copyFriends(value) {
  return { available: value.available, items: value.items.map((item) => ({ ...item })) };
}

class ShowdownBridge {
  constructor(getContents) {
    this.getContents = getContents;
    this.ratings = new Map();
    this.ratingsInFlight = new Map();
    this.friendsCache = new Map();
    this.friendsInFlight = new Map();
    this.friendsRequest = null;
  }

  // Internal integration entry points; never accept arbitrary script URLs via IPC.
  async loadShowdex() {
    const contents = this.getContents();
    if (!contents) return false;
    try {
      await contents.executeJavaScript(call(installShowdexDock));
      return await contents.executeJavaScript(call(loadShowdex, 'showdex://assets/main.js')) === true;
    } catch { return false; }
  }

  async installFormatModal() {
    const contents = this.getContents();
    if (!contents) return false;
    try {
      return await contents.executeJavaScript(call(installFormatModal)) === true;
    } catch { return false; }
  }

  async installTeamEditor() {
    const contents = this.getContents();
    if (!contents) return false;
    try {
      return await contents.executeJavaScript(call(installTeamEditor)) === true;
    } catch { return false; }
  }

  async installTeamsView() {
    const contents = this.getContents();
    if (!contents) return false;
    try {
      return await contents.executeJavaScript(call(installTeamsView)) === true;
    } catch { return false; }
  }

  // Teambuilder teams for `format` as [{ index, name, team }] (packed), or null if the client isn't loaded.
  async teams(format) {
    const contents = this.getContents();
    if (!isId(format) || !contents || contents.isLoading()) return null;
    let raw;
    try { raw = await contents.executeJavaScript(call(readTeams, format)); } catch { return null; }
    if (!Array.isArray(raw)) return null;
    return raw.slice(0, 500).filter((t) => t && Number.isSafeInteger(t.index) && t.index >= 0 && t.index <= 9999 &&
      typeof t.team === 'string' && t.team.length <= 8192 && !/[\r\n]/.test(t.team))
      .map((t) => ({ index: t.index, name: str(t.name, 80) || 'Untitled', team: t.team }));
  }

  async showdexStatus() {
    const contents = this.getContents();
    if (!contents || contents.isLoading()) return 'loading';
    try {
      const status = await contents.executeJavaScript(call(readShowdex));
      return ['loaded', 'loading', 'failed'].includes(status) ? status : 'failed';
    } catch { return 'failed'; }
  }

  async snapshot() {
    const contents = this.getContents();
    if (!contents || contents.isLoading()) return { ready: false };
    let state;
    try {
      state = sanitize(await contents.executeJavaScript(call(readClient)));
    } catch {
      return { ready: false };
    }
    if (!state.ready) return state;
    state.friends = { available: false, items: [] };
    if (state.user.registered && state.user.userid) {
      const userid = state.user.userid;
      // Last known values, however old, so a slow refresh never blanks what Home shows.
      const knownRatings = this.ratings.get(userid);
      const knownFriends = this.friendsCache.get(userid);
      const unavailable = { available: false, items: [] };
      const [ratings, friends] = await Promise.all([
        within(this.fetchRatings(userid), knownRatings ? knownRatings.value : null),
        state.connected
          ? within(this.fetchFriends(userid), knownFriends ? copyFriends(knownFriends.value) : null)
          : Promise.resolve(unavailable),
      ]);
      state.ratings = ratings || {};
      state.stats = (this.ratings.get(userid) || {}).stats || {};
      state.friends = friends || { ...unavailable, loading: true };
      // Something is still on its way: Home asks again soon rather than at its idle pace.
      state.pending = !ratings || !friends;
    }
    return state;
  }

  async fetchFriends(userid) {
    if (!isId(userid)) return { available: false, items: [] };
    // The response event has no request ID, so never overlap queries for different users.
    while (this.friendsRequest && this.friendsRequest.userid !== userid) await this.friendsRequest.promise;
    const cached = this.friendsCache.get(userid);
    const ttl = cached && cached.value.available ? FRIENDS_TTL : FRIENDS_FAILURE_TTL;
    if (cached && Date.now() - cached.at < ttl) return copyFriends(cached.value);
    let pending = this.friendsInFlight.get(userid);
    if (!pending) {
      pending = (async () => {
        const contents = this.getContents();
        if (!contents || contents.isLoading()) return { available: false, items: [] };
        let raw;
        try { raw = await contents.executeJavaScript(call(readFriends, userid, FRIENDS_TIMEOUT)); } catch { raw = null; }
        const value = sanitizeFriends(raw);
        this.friendsCache.set(userid, { at: Date.now(), value });
        return value;
      })();
      this.friendsInFlight.set(userid, pending);
      this.friendsRequest = { userid, promise: pending };
      pending.finally(() => {
        if (this.friendsInFlight.get(userid) === pending) this.friendsInFlight.delete(userid);
        if (this.friendsRequest?.promise === pending) this.friendsRequest = null;
      });
    }
    return copyFriends(await pending);
  }

  async session() {
    const contents = this.getContents();
    if (!contents || contents.isLoading()) return { ready: false, rooms: [] };
    try {
      return sanitizeSession(await contents.executeJavaScript(callWith([readMessages], readSession)));
    } catch {
      return { ready: false, rooms: [] };
    }
  }

  // Public profile endpoint; no credentials are sent. Overlapping reads share one fetch.
  fetchRatings(userid) {
    const cached = this.ratings.get(userid);
    if (cached && Date.now() - cached.at < RATINGS_TTL) return Promise.resolve(cached.value);
    let pending = this.ratingsInFlight.get(userid);
    if (!pending) {
      pending = this.loadRatings(userid).finally(() => this.ratingsInFlight.delete(userid));
      this.ratingsInFlight.set(userid, pending);
    }
    return pending;
  }

  async loadRatings(userid) {
    const value = {};
    const stats = {};
    try {
      const res = await net.fetch(`https://pokemonshowdown.com/users/${userid}.json`, {
        credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await boundedJson(res, 1024 * 1024);
        for (const [format, r] of Object.entries((data && data.ratings) || {})) {
          const elo = count(r && r.elo);
          if (!isId(format) || elo === null) continue;
          value[format] = Math.round(elo);
          const gxe = Number(r.gxe);
          stats[format] = {
            elo: Math.round(elo),
            gxe: Number.isFinite(gxe) && gxe >= 0 && gxe <= 100 ? Math.round(gxe * 10) / 10 : null,
            wins: count(r.w) || 0,
            losses: count(r.l) || 0,
          };
        }
      }
    } catch {}
    this.ratings.set(userid, { at: Date.now(), value, stats });
    return value;
  }

  async act(action, args) {
    const contents = this.getContents();
    if (!contents || !args || typeof args !== 'object') return false;
    // Optional successor for a close: one existing room, conversation, or Community.
    const next = args.next;
    if ((action === 'leave-room' || action === 'close-pm') && next !== undefined &&
        (!next || typeof next !== 'object' || Object.keys(next).length !== 1 ||
          !(typeof next.room === 'string' && ROOM_ID.test(next.room) ||
            typeof next.user === 'string' && USER_ID.test(next.user) || next.tab === 'community'))) return false;
    let code;
    switch (action) {
      case 'find-user':
      case 'start-chat': {
        if (typeof args.user !== 'string' || args.user.length > 18 || /[\u0000-\u001f]/.test(args.user) ||
            !args.user.toLowerCase().replace(/[^a-z0-9]/g, '')) return false;
        if (action === 'start-chat' && args.dock !== undefined && typeof args.dock !== 'boolean') return false;
        code = action === 'find-user' ? call(findUser, args.user.trim())
          : callWith([pmWindow, openPM, setChatDock], startChat, args.user.trim(), args.dock === true);
        break;
      }
      case 'chat-dock':
        if (typeof args.enabled !== 'boolean') return false;
        code = callWith([pmWindow, openPM], setChatDock, args.enabled);
        break;
      case 'search': {
        const team = args.team === null ? null : args.team;
        if (!isId(args.format) || (team !== null && (!Number.isSafeInteger(team) || team < 0 || team > 9999))) return false;
        code = call(search, args.format, team);
        break;
      }
      case 'challenge': {
        const name = str(args.user, 18).trim();
        if (!name || /[\u0000-\u001f]/.test(name) || !isId(args.format)) return false;
        code = callWith([pmWindow, openPM], challenge, name, args.format);
        break;
      }
      case 'join':
        if (!(typeof args.room === 'string' && ROOM_ID.test(args.room))) return false;
        code = call(join, args.room);
        break;
      case 'edit-team':
        if (args.team !== null && (!Number.isSafeInteger(args.team) || args.team < 0 || args.team > 9999 ||
            typeof args.name !== 'string' || args.name.length > 80 || !(args.format === '' || isId(args.format)))) return false;
        code = args.team === null ? call(editTeam, null, '', '') : call(editTeam, args.team, args.name, args.format);
        break;
      case 'focus-room':
        if (!(args.room === '' || (typeof args.room === 'string' && ROOM_ID.test(args.room)))) return false;
        code = call(focusRoom, args.room);
        break;
      case 'show-menu':
        if (args.tab !== 'battle' && args.tab !== 'community') return false;
        code = call(showMenu, args.tab);
        break;
      case 'leave-room':
        if (!(typeof args.room === 'string' && ROOM_ID.test(args.room)) || args.room === 'rooms') return false;
        code = callWith([leaveRoom, closePM, pmWindow, openPM, focusRoom, showMenu], closeClientTab, 'room', args.room, args.forfeit === true, next);
        break;
      case 'open-pm':
      case 'close-pm':
        if (typeof args.user !== 'string' || !USER_ID.test(args.user)) return false;
        code = action === 'open-pm' ? callWith([pmWindow], openPM, args.user)
          : callWith([leaveRoom, closePM, pmWindow, openPM, focusRoom, showMenu], closeClientTab, 'pm', args.user, false, next);
        break;
      case 'answer-challenge': {
        const team = args.team === undefined ? null : args.team;
        if (typeof args.user !== 'string' || !USER_ID.test(args.user) ||
            !['accept', 'reject', 'cancel', 'dismiss'].includes(args.answer) ||
            (team !== null && (args.answer !== 'accept' || !Number.isSafeInteger(team) || team < 0 || team > 9999))) return false;
        code = callWith([pmWindow], answerChallenge, args.user, args.answer, team);
        break;
      }
      case 'sounds':
        code = call(openSounds);
        break;
      case 'options':
        code = call(openOptions);
        break;
      case 'profile':
        code = call(openProfile);
        break;
      case 'cancel-search':
        code = call(cancelSearch);
        break;
      case 'login':
        code = call(login);
        break;
      case 'friends':
        code = call(friends);
        break;
      default:
        return false;
    }
    try {
      const result = await contents.executeJavaScript(code);
      if (action === 'find-user') {
        if (!result || result.ok !== true || result.userid !== args.user.toLowerCase().replace(/[^a-z0-9]/g, '')) return { ok: false };
        return { ok: true, userid: result.userid, name: str(result.name, 40), online: result.online === true,
          avatar: sanitizeAvatar(result.avatar), status: str(result.status, 140) };
      }
      // true: done in the background. 'needs-client': show the client so the user can respond.
      return result === true || result === 'needs-client' || result === 'needs-forfeit' ? result : false;
    } catch {
      return false;
    }
  }
}

module.exports = { ShowdownBridge };
