'use strict';

// Tab strip: small tabs for launcher pages, then one per room open in the Showdown client, so
// the launcher owns navigation. Other pages can listen for "showdown-session" instead of polling.
(() => {
  // Following the current page's link reloads it and resets its UI. (The practice battle page
  // highlights Bots too, but that link goes back to setup.)
  const currentPage = document.querySelector('.rail a.nav-item[aria-current="page"]');
  const ownFile = (/([a-z-]+\.html)(?:[?#].*)?$/.exec(String(location.href)) || [])[1] || '';
  const currentHref = currentPage && currentPage.getAttribute('href');
  if (currentPage && (!currentHref || currentHref === ownFile)) currentPage.addEventListener('click', (event) => event.preventDefault());

  const $ = (name) => document.querySelector(`[data-nav="${name}"]`);
  const list = $('rooms');
  if (!list || !window.desktop) return;
  const onPlay = !!document.body && document.body.dataset.page === 'play';
  const desktop = window.desktop;

  const svg = (d, extra = '') => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"${extra}>${d}</svg>`;
  const round = ' stroke-linejoin="round"';
  const ICONS = {
    battle: svg('<path d="M5 3.5v9l7-4.5z"/>', round),
    chat: svg('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>', round),
    teambuilder: svg('<path d="M3 13l.5-3L10.5 3l2.5 2.5L6 12.5z"/>', round),
    community: svg('<circle cx="6" cy="6" r="2.5"/><path d="M1.5 13c0-2.2 2-3.5 4.5-3.5s4.5 1.3 4.5 3.5M10.5 3.8a2.5 2.5 0 0 1 0 4.4M12.5 9.9c1.2.6 2 1.6 2 3.1"/>', ' stroke-linecap="round"'),
    ladder: svg('<path d="M3 13V9M8 13V3M13 13V6"/>', ' stroke-linecap="round"'),
    battles: svg('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>', round),
    message: svg('<path d="M2 4h12v8H2zM2 4l6 5 6-5"/>', round),
    // Two crossed swords: blades, crossguards and grips.
    swords: svg('<path d="M2.5 2.5h2.5l6 6M11 11l2.5 2.5M9.5 12.5l3-3M13.5 2.5H11l-6 6M5 11l-2.5 2.5M3.5 9.5l3 3"/>', ' stroke-linecap="round" stroke-linejoin="round"'),
    other: svg('<rect x="3" y="3" width="10" height="10" rx="1.5"/>'),
    resources: svg('<path d="M3 3.5h3.5A1.5 1.5 0 0 1 8 5v8a1.5 1.5 0 0 0-1.5-1.5H3zM13 3.5H9.5A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5H13z"/>', round),
    home: svg('<path d="M2.5 7.5 8 3l5.5 4.5V13H10V9.5H6V13H2.5z"/>', round),
    stats: svg('<path d="M3 13V9M8 13V3M13 13V6"/>', ' stroke-linecap="round"'),
    replays: svg('<path d="M4 2.5h8v11l-4-3-4 3z"/>', round),
    practice: svg('<rect x="2.5" y="5" width="11" height="8" rx="2"/><path d="M8 5V2.5M6 9v.5M10 9v.5"/>', ' stroke-linejoin="round" stroke-linecap="round"'),
    settings: svg('<path d="M2.5 4.5h3M8.5 4.5h5M2.5 11.5h7M12.5 11.5h1"/><circle cx="7" cy="4.5" r="1.5"/><circle cx="11" cy="11.5" r="1.5"/>', ' stroke-linecap="round"'),
    x: svg('<path d="M4 4l8 8M12 4l-8 8"/>', ' stroke-linecap="round"'),
  };

  function matchup(room, me) {
    const [p1, p2] = room.players;
    if (me && p1 === me && p2) return `vs. ${p2}`;
    if (me && p2 === me && p1) return `vs. ${p1}`;
    return p1 && p2 ? `${p1} vs. ${p2}` : room.title;
  }

  function roomSub(room) {
    if (!room.battle) return '';
    const state = room.ended ? 'Finished' : Number.isInteger(room.turn) ? `Turn ${room.turn}` : '';
    return [room.format, state].filter(Boolean).join(' · ');
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(html, className) {
    const node = make('span', className);
    node.innerHTML = html; // fixed markup above, never session data
    return node;
  }

  function go(page) {
    if (!(onPlay && page === 'play.html')) location.href = page;
  }

  // focus-room and leave-room answer 'needs-client' when the client shows a popup (such as a
  // forfeit prompt), so the user is taken to play.html to see it.
  async function act(action, args) {
    try {
      return await desktop.showdown(action, args);
    } catch {
      return false;
    }
  }

  async function focusRoom(id) {
    await act('focus-room', { room: id });
    if (onPlay) pollNow();
    else go('play.html');
  }

  // Closing an unfinished battle asks first in a small popup under the tab, as Showdown does. It
  // stays in the strip and top bar, the only area no battle view covers. Resolves true for Forfeit.
  let forfeitAsk = null;
  function confirmForfeit(tabId) {
    if (forfeitAsk) forfeitAsk.finish(false);
    return new Promise((resolve) => {
      if (typeof document.createElement !== 'function' || !document.body) return resolve(false);
      const anchor = [...list.querySelectorAll('[data-tab-id]')].find((node) => node.getAttribute('data-tab-id') === tabId) || null;
      const box = make('div', 'forfeit-ask');
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-label', 'Forfeit this battle?');
      const text = make('span', 'forfeit-ask-text');
      text.append(make('strong', '', 'Forfeit this battle?'), make('span', '', ' You lose the battle.'));
      const yes = make('button', 'btn forfeit-ask-yes', 'Forfeit');
      const no = make('button', 'btn forfeit-ask-no', 'Cancel');
      yes.type = no.type = 'button';
      box.append(text, yes, no);
      document.body.append(box);
      // Under the tab's close button, kept inside the window.
      const target = anchor && anchor.querySelector('.nav-close') ? anchor.querySelector('.nav-close') : anchor;
      const rect = target ? target.getBoundingClientRect() : { left: innerWidth / 2, width: 0, bottom: 40 };
      const width = box.offsetWidth;
      const center = rect.left + rect.width / 2;
      const left = Math.max(8, Math.min(center - width / 2, innerWidth - width - 8));
      box.style.left = `${left}px`;
      box.style.top = `${Math.round(rect.bottom) + 6}px`;
      box.style.setProperty('--arrow-x', `${Math.round(center - left)}px`);
      const onKey = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      };
      const onDown = (event) => { if (!box.contains(event.target)) finish(false); };
      function finish(answer) {
        if (forfeitAsk !== handle) return;
        forfeitAsk = null;
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mousedown', onDown, true);
        box.remove();
        resolve(answer);
      }
      const handle = { finish };
      forfeitAsk = handle;
      yes.addEventListener('click', () => finish(true));
      no.addEventListener('click', () => finish(false));
      document.addEventListener('keydown', onKey, true);
      setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
      no.focus();
    });
  }

  async function closeRoom(id) {
    let result = await act('leave-room', { room: id });
    if (result === 'needs-forfeit') {
      if (!(await confirmForfeit(id))) return false;
      result = await act('leave-room', { room: id, forfeit: true });
    }
    if (result === 'needs-client') {
      go('play.html');
    } else if (result === true) {
      const session = await pollNow();
      // With nothing left to show, or only the client's main menu, Home takes over.
      if (onPlay && session && session.ready && (session.rooms.length === 0 || onMainMenu(session))) location.href = 'index.html';
    }
    return result;
  }

  // Fixed tabs and how to reach their view in the client. The client's main menu has no tab; Home
  // replaces it (see onMainMenu).
  const TABS = {
    teambuilder: { title: 'Teambuilder', kind: 'teambuilder', action: 'join', args: { room: 'teambuilder' } },
    community: { title: 'Community', kind: 'community', action: 'show-menu', args: { tab: 'community' } },
  };

  // The client's Community view, or its room list, which belongs to Community.
  const communityShown = (session) => Boolean(session && session.ready &&
    ((session.current === '' && session.menuTab === 'community') || session.current === 'rooms'));

  // The client is showing its own main menu, which has no tab: Home stands in for it.
  const onMainMenu = (session) => Boolean(session && session.ready && session.current === '' && session.menuTab === 'battle');

  async function openConversation(user) {
    await act('open-pm', { user });
    if (onPlay) pollNow();
    else go('play.html');
  }

  // Closing goes through the client, which also declines a challenge still waiting there.
  async function closeConversation(user) {
    await act('close-pm', { user });
    pollNow();
  }

  function messageSub(m) {
    const c = m.challenge;
    if (!c) return '';
    // The rail is narrow; the challenge bar and the row's tooltip carry the format.
    if (c.dir === 'in') return 'Challenge';
    if (c.dir === 'out') return 'Waiting for reply';
    return 'Challenge cancelled';
  }

  async function openTab(name) {
    await act(TABS[name].action, TABS[name].args);
    if (onPlay) pollNow();
    else go('play.html');
  }

  // How a tab closes, or null if it can't (Home). Close buttons, middle clicks and Ctrl+W use these.
  const rowCloser = ({ closable, pm, id }) => (!closable ? null : pm ? () => closeConversation(pm) : () => closeRoom(id));
  const pageCloser = (file) => (file === 'index.html' ? null : file === 'community' ? closeCommunity
    : PAGES[file].room ? () => closeRoom(file) : file === BATTLE_PAGE ? closePracticeBattle : () => closePage(file));

  // A middle click anywhere on a closable tab closes it, as in a browser.
  function closeOnMiddleClick(node, close) {
    if (!close) return;
    // Stops the middle button's scroll cursor from appearing over the strip.
    node.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault(); });
    node.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      close();
    });
  }

  function row({ title, sub, tip, kind, live, unread, current, id, closable, tab, pm, challenge }) {
    const shut = rowCloser({ closable, pm, id });
    const node = make('div', `nav-item ${tab ? 'nav-tab' : 'nav-room'}${live ? ' nav-item--live' : ''}${challenge ? ' nav-item--challenge' : ''}`);
    if (id && !pm) node.setAttribute('data-tab-id', id);
    closeOnMiddleClick(node, shut);
    node.title = tip || (sub ? `${title} · ${sub}` : title);
    if (current) node.setAttribute('aria-current', 'page');
    const main = make('button', 'nav-room-main');
    main.type = 'button';
    main.append(icon(ICONS[kind] || ICONS.other, 'nav-room-icon'));
    const text = make('span', 'nav-room-text');
    text.append(make('span', 'nav-room-title nav-label', title));
    if (sub) text.append(make('span', 'nav-room-sub', sub));
    main.append(text);
    if (unread) {
      const dot = make('span', 'nav-unread');
      dot.title = 'New activity';
      main.append(dot);
    }
    main.addEventListener('click', () => {
      if (current) return;
      return pm ? openConversation(pm) : tab ? openTab(tab) : focusRoom(id);
    });
    node.append(main);
    if (shut) {
      const close = make('button', 'rail-icon-btn nav-close');
      close.type = 'button';
      close.setAttribute('aria-label', `Close ${title}`);
      close.title = `Close ${title}`;
      close.append(icon(ICONS.x));
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        shut();
      });
      node.append(close);
    }
    return node;
  }

  let lastKey = null;
  let lastSession = null;
  // Every tab in strip order, with how to open it; Ctrl+Tab steps through this.
  let strip = [];

  // Launcher pages are small tabs ahead of the rooms. Home is always first; others appear when
  // opened and stay until closed or restart. Teambuilder follows its client room being open;
  // Community (the client's main menu in its Community view) stays until closed.
  const PAGES = {
    'index.html': { title: 'Home', kind: 'home' },
    'stats.html': { title: 'Stats', kind: 'stats' },
    'replays.html': { title: 'Replays', kind: 'replays' },
    'practice.html': { title: 'Bots', kind: 'practice' },
    'practice-battle.html': { title: 'Bot battle', kind: 'battle' },
    'settings.html': { title: 'Settings', kind: 'settings' },
    'resources.html': { title: 'Info & Resources', kind: 'resources' },
    teambuilder: { title: 'Teambuilder', kind: 'teambuilder', room: true },
    community: { title: 'Community', kind: 'community', room: true },
  };
  const isPage = (file) => Object.prototype.hasOwnProperty.call(PAGES, file);
  const pagesKey = 'nav.pages';
  const thisPage = ownFile;
  // The practice battle tab exists while a session does; closing it ends the session (confirmed
  // first if the battle is still on).
  const BATTLE_PAGE = 'practice-battle.html';
  const RESOURCES_ROOM = 'resources';

  function savedPages() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(pagesKey));
      if (Array.isArray(saved)) {
        return saved.filter((file, i) => file !== 'index.html' && isPage(file) && saved.indexOf(file) === i);
      }
    } catch {}
    return [];
  }

  function savePages() {
    try {
      sessionStorage.setItem(pagesKey, JSON.stringify(pages));
    } catch {}
  }

  const pages = savedPages();
  if (thisPage !== 'index.html' && isPage(thisPage) && !pages.includes(thisPage)) {
    pages.push(thisPage);
    savePages();
  }

  // Closing the page being shown moves to the tab on its left.
  function closePage(file) {
    const at = pages.indexOf(file);
    if (at < 0) return;
    pages.splice(at, 1);
    savePages();
    if (file === thisPage) {
      // Community and Teambuilder are client rooms, not files: open them the way their tab does.
      const left = pages[at - 1] || 'index.html';
      if (PAGES[left].room) openTab(left).catch(() => { location.href = 'index.html'; });
      else location.href = left;
      return;
    }
    lastKey = null;
    if (lastSession) render(lastSession);
  }

  // Closing Community while shown returns the client to its Battle view, so Home opens.
  async function closeCommunity() {
    const at = pages.indexOf('community');
    if (at >= 0) {
      pages.splice(at, 1);
      savePages();
    }
    const shown = onPlay && lastSession && communityShown(lastSession);
    if (shown) {
      await act('show-menu', { tab: 'battle' });
      location.href = 'index.html';
      return true;
    }
    lastKey = null;
    if (lastSession) render(lastSession);
    return true;
  }

  async function closePracticeBattle() {
    let result = null;
    try {
      result = await desktop.stopPractice();
      if (result && result.needsConfirm) {
        if (!(await confirmForfeit(BATTLE_PAGE))) return false;
        result = await desktop.stopPractice(true);
      }
    } catch {}
    if (result && result.cancelled) return false;
    closePage(BATTLE_PAGE);
    return true;
  }

  // Elsewhere, drop the battle tab once its session has ended (stopped, or the app restarted).
  let pruned = false;
  async function pruneBattleTab() {
    if (pruned) return;
    pruned = true;
    if (thisPage === BATTLE_PAGE || !pages.includes(BATTLE_PAGE) || typeof desktop.getPractice !== 'function') return;
    let state = null;
    try {
      state = (await desktop.getPractice())?.state;
    } catch {}
    if (state !== 'idle' || !pages.includes(BATTLE_PAGE)) return;
    pages.splice(pages.indexOf(BATTLE_PAGE), 1);
    savePages();
    lastKey = null;
    if (lastSession) render(lastSession);
  }

  function pageTab({ file, current }) {
    const { title, kind, room } = PAGES[file];
    const node = make('div', 'nav-item nav-page');
    node.setAttribute('data-tab-id', file);
    node.title = title;
    if (current) node.setAttribute('aria-current', 'page');
    const main = make('button', 'nav-room-main');
    main.type = 'button';
    main.append(icon(ICONS[kind], 'nav-room-icon'));
    const text = make('span', 'nav-room-text');
    text.append(make('span', 'nav-room-title nav-label', title));
    main.append(text);
    main.addEventListener('click', () => {
      if (current) return;
      if (room) openTab(file);
      else location.href = file;
    });
    node.append(main);
    const shut = pageCloser(file);
    closeOnMiddleClick(node, shut);
    if (shut) {
      const close = make('button', 'rail-icon-btn nav-close');
      close.type = 'button';
      close.setAttribute('aria-label', `Close ${title}`);
      close.title = `Close ${title}`;
      close.append(icon(ICONS.x));
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        shut();
      });
      node.append(close);
    }
    return node;
  }

  // Challenge bars sit under the top bar on every page, so a challenge can be answered anywhere.
  // Answers go through the client's own buttons.
  let barsKey = null;
  let barsBox = null;
  const chosenTeams = new Map();

  // The team Home last used for this format, if any.
  function savedTeam(format) {
    try {
      const raw = localStorage.getItem(`hub.team.${format.split('@@@')[0]}`);
      const n = raw === null || raw === '' ? NaN : Number(raw);
      return Number.isInteger(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  async function answer(user, reply, team) {
    const result = await act('answer-challenge', team === null ? { user, answer: reply } : { user, answer: reply, team });
    // The client needs the user, for example to build a team first: show its conversation.
    if (result === 'needs-client') await openConversation(user);
    barsKey = null;
    pollNow();
  }

  function challengeBar(m) {
    const c = m.challenge;
    const bar = make('section', `banner banner--bar banner--challenge banner--challenge-${c.dir}`);
    bar.setAttribute('aria-label', c.dir === 'out' ? `Your challenge to ${m.name}` : `Challenge from ${m.name}`);
    bar.append(icon(ICONS.swords, 'challenge-icon'));
    const text = make('div', 'challenge-text');
    const format = c.formatName || 'a battle';
    if (c.dir === 'in') {
      text.append(make('strong', '', `${m.name} challenges you to ${format}`));
      if (c.message && c.message !== `${m.name} wants to battle!`) text.append(make('span', 'challenge-note', c.message));
    } else if (c.dir === 'out') {
      text.append(make('strong', '', `Waiting for ${m.name} to accept`), make('span', 'challenge-note', format));
    } else {
      text.append(make('strong', '', `${m.name} cancelled the challenge`));
    }
    bar.append(text, make('span', 'spacer'));

    const button = (label, className, handler, lock = true) => {
      const node = make('button', `btn${className}`, label);
      node.type = 'button';
      node.addEventListener('click', () => {
        if (lock) for (const control of bar.querySelectorAll('button, select')) control.disabled = true;
        handler();
      });
      return node;
    };
    const chat = () => button('Open chat', ' btn-quiet', () => openConversation(m.userid), false);

    if (c.dir === 'in' && c.pending) {
      bar.append(make('span', 'challenge-note', 'Starting the battle…'));
    } else if (c.dir === 'in') {
      let select = null;
      if (c.needsTeam && c.teams.length) {
        const id = `challenge-team-${m.userid}`;
        const label = make('label', 'challenge-label', 'Team');
        label.htmlFor = id;
        select = make('select', 'select challenge-team');
        select.id = id;
        for (const t of c.teams) {
          const option = make('option', '', t.name);
          option.value = String(t.index);
          select.append(option);
        }
        const pick = [chosenTeams.get(m.userid), savedTeam(c.format), c.team]
          .find((v) => Number.isInteger(v) && c.teams.some((t) => t.index === v));
        if (pick !== undefined) select.value = String(pick);
        select.addEventListener('change', () => chosenTeams.set(m.userid, Number(select.value)));
        bar.append(label, select);
      } else if (c.needsTeam) {
        bar.append(make('span', 'challenge-note', 'No team for this format'));
      }
      bar.append(chat(),
        button('Decline', '', () => answer(m.userid, 'reject', null)),
        button('Accept', ' btn-primary', () => answer(m.userid, 'accept', select ? Number(select.value) : null)));
    } else if (c.dir === 'out') {
      bar.append(chat(), button('Cancel challenge', '', () => answer(m.userid, 'cancel', null)));
    } else {
      bar.append(button('OK', '', () => answer(m.userid, 'dismiss', null)));
    }
    return bar;
  }

  function renderChallenges(session) {
    const topbar = document.querySelector('.main > .topbar');
    if (!topbar) return;
    // The conversation open on the Showdown screen already shows its challenge form.
    const shown = onPlay && session.current === '' && session.menuTab === 'pm' ? session.pmOpen : '';
    const items = (session.ready && Array.isArray(session.messages) ? session.messages : [])
      .filter((m) => m.challenge && m.userid !== shown)
      .slice(0, 3);
    const key = JSON.stringify(items.map((m) => [m.userid, m.name, m.challenge]));
    if (key === barsKey) return;
    barsKey = key;
    if (!barsBox) {
      barsBox = make('div', 'challenge-bars');
      topbar.after(barsBox);
    }
    for (const user of chosenTeams.keys()) {
      if (!items.some((m) => m.userid === user)) chosenTeams.delete(user);
    }
    barsBox.replaceChildren(...items.map(challengeBar));
    barsBox.hidden = !items.length;
  }

  function render(session) {
    const rooms = session.rooms;
    const current = typeof session.current === 'string' ? session.current : '';
    const me = session.me || '';
    // The friends pages are one place however the server titles them ("[Friends] Sent").
    const friendsPage = (r) => /^view-friends(-|$)/.test(r.id);
    const roomRow = (r) => ({
      title: r.battle ? matchup(r, me) : friendsPage(r) ? 'Friends' : r.title, sub: roomSub(r),
      kind: r.battle ? 'battle' : friendsPage(r) ? 'community' : r.kind,
      live: !!r.battle && !r.ended, unread: !!r.unread, id: r.id, closable: true,
      current: onPlay && r.id === current,
    });
    // Open rooms in the client's order. Teambuilder is a page tab, not a row, and the client's
    // resources room gives way to the Info & Resources page (see update).
    const rows = rooms.filter((r) => r.id !== 'teambuilder' && r.id !== RESOURCES_ROOM).map(roomRow);
    // Conversations and challenges, from the client's private message windows.
    const messages = (Array.isArray(session.messages) ? session.messages : []).map((m) => ({
      title: m.name, sub: messageSub(m), kind: 'message',
      tip: [m.name, messageSub(m), m.challenge && m.challenge.formatName].filter(Boolean).join(' · '), id: m.userid, pm: m.userid, closable: true,
      unread: !!m.unread || !!(m.challenge && m.challenge.dir === 'in'),
      challenge: !!(m.challenge && m.challenge.dir === 'in'),
      current: onPlay && current === '' && session.menuTab === 'pm' && session.pmOpen === m.userid,
    }));
    // Rebuild only on change so hover and focus survive each poll. The Teambuilder tab exists exactly
    // while its room is open.
    const teambuilding = onPlay && current === 'teambuilder';
    if (session.ready) {
      const open = rooms.some((r) => r.id === 'teambuilder');
      const at = pages.indexOf('teambuilder');
      if (open && at < 0) pages.push('teambuilder');
      else if (!open && at >= 0) pages.splice(at, 1);
      if (open !== at >= 0) savePages();
    }
    // The Community tab appears whenever its view shows, however the client got there.
    const inCommunity = onPlay && communityShown(session);
    if (inCommunity && !pages.includes('community')) {
      pages.push('community');
      savePages();
    }
    for (const [name, on] of [['teambuilder', teambuilding], ['community', inCommunity]]) {
      const button = $(name);
      if (!button) continue;
      if (on) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    const pageRows = ['index.html', ...pages].map((file) => ({
      file, current: file === 'teambuilder' ? teambuilding : file === 'community' ? inCommunity : !onPlay && file === thisPage,
    }));
    lastSession = session;
    strip = [
      ...pageRows.map(({ file, current: open }) => ({
        current: open, open: () => (PAGES[file].room ? openTab(file) : void (location.href = file)),
        close: pageCloser(file),
      })),
      ...rows.map((r) => ({
        current: r.current, open: () => (r.tab ? openTab(r.tab) : focusRoom(r.id)), close: rowCloser(r),
      })),
      ...messages.map((m) => ({ current: m.current, open: () => openConversation(m.pm), close: rowCloser(m) })),
    ];
    const key = JSON.stringify([pageRows, rows, messages, !!session.ready, me, !!session.named]);
    renderChallenges(session);
    if (key === lastKey) return;
    lastKey = key;
    const nodes = [...pageRows.map(pageTab), ...rows.map(row)];
    if (messages.length) {
      const label = make('div', 'rail-section rail-section--messages');
      label.append(make('span', '', 'Messages'));
      nodes.push(label, ...messages.map(row));
    }
    list.replaceChildren(...nodes);
    // Keep the open tab visible when the strip has scrolled.
    const open = typeof list.querySelector === 'function' && list.querySelector('[aria-current="page"]');
    if (open && typeof open.scrollIntoView === 'function') open.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const box = $('account');
    if (box) {
      box.hidden = !session.ready || !me;
      $('me').textContent = me;
      box.title = me;
      const avatar = $('avatar');
      if (avatar) avatar.textContent = (/[a-z0-9]/i.exec(me) || ['?'])[0].toUpperCase();
      $('sign-in').hidden = !!session.named;
    }
  }

  // A vertical wheel scrolls the tab strip sideways.
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('wheel', (event) => {
      if (!event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      list.scrollLeft += event.deltaY;
      event.preventDefault();
    }, { passive: false });
  }

  // The icon bar's Teambuilder and Community entries open those views in the client.
  if ($('teambuilder')) {
    $('teambuilder').addEventListener('click', (event) => {
      event.preventDefault();
      if (!(onPlay && lastSession && lastSession.current === 'teambuilder')) openTab('teambuilder');
    });
  }
  if ($('community')) {
    $('community').addEventListener('click', (event) => {
      event.preventDefault();
      if (!(onPlay && communityShown(lastSession))) openTab('community');
    });
  }

  $('sign-in').addEventListener('click', async (event) => {
    event.preventDefault();
    await act('login', {});
    go('play.html');
  });

  // Keep the baseline across launcher pages; a battle can start during navigation.
  let known = null;
  let knownMe = '';
  const knownKey = 'showdown.knownRooms';
  const lastSessionKey = 'nav.lastSession';

  function savedRooms(me) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(knownKey));
      if (saved && saved.me === me && Array.isArray(saved.ids)) {
        return new Set(saved.ids.filter((id) => typeof id === 'string'));
      }
    } catch {}
    return null;
  }

  function saveRooms(me) {
    try {
      sessionStorage.setItem(knownKey, JSON.stringify({ me, ids: [...known].slice(-100) }));
    } catch {}
  }

  function battleStarted(session) {
    const mine = session.rooms.filter((r) => r.battle && !r.ended && session.me && r.players.includes(session.me));
    if (known === null || knownMe !== session.me) {
      knownMe = session.me;
      known = savedRooms(knownMe);
      if (known === null) {
        // An unresolved battle can have been created just before this first poll.
        known = new Set(session.rooms
          .filter((r) => !r.battle || r.ended || (r.players.length === 2 && r.players.every(Boolean)))
          .map((r) => r.id));
        saveRooms(knownMe);
        return false;
      }
    }
    const started = mine.some((r) => !known.has(r.id));
    // A battle room appears before its player names; wait to classify it so an early poll can't
    // suppress the later match.
    session.rooms.forEach((r) => {
      if (!r.battle || r.ended || (r.players.length === 2 && r.players.every(Boolean))) known.add(r.id);
    });
    saveRooms(knownMe);
    return started;
  }

  let timer = null;
  let inflight = null;
  let menuReads = 0;

  // Resolves with the session just read; overlapping calls share one read.
  function pollNow() {
    clearTimeout(timer);
    if (!inflight) inflight = update().finally(() => { inflight = null; });
    return inflight;
  }

  async function update() {
    let session;
    try {
      session = await desktop.getSession();
    } catch {
      session = null;
    }
    if (!session || !Array.isArray(session.rooms)) session = { ready: false, rooms: [] };
    render(session);
    pruneBattleTab();
    if (session.ready) {
      try { sessionStorage.setItem(lastSessionKey, JSON.stringify(session)); } catch {}
    }
    // The launcher has its own Info & Resources page, so the client's room is closed and that opens.
    if (session.ready && session.rooms.some((r) => r.id === RESOURCES_ROOM)) {
      await act('leave-room', { room: RESOURCES_ROOM });
      if (thisPage !== 'resources.html') {
        location.href = 'resources.html';
        return session;
      }
    }
    if (session.ready && battleStarted(session) && !onPlay) {
      location.href = 'play.html';
      return session;
    }
    // The Showdown screen never shows the client's main menu; Home replaces it. Two reads must agree,
    // so a room still opening doesn't bounce to Home, and client popups stay on screen.
    menuReads = onPlay && onMainMenu(session) && !session.popups ? menuReads + 1 : 0;
    if (menuReads >= 2) {
      location.href = 'index.html';
      return session;
    }
    document.dispatchEvent(new CustomEvent('showdown-session', { detail: session }));
    const searching = session.search && (session.search.pending || session.search.formats.length > 0);
    timer = setTimeout(pollNow, onPlay || searching ? 1000 : 3000);
    return session;
  }

  // Ctrl+Tab opens the next tab and Ctrl+Shift+Tab the previous, wrapping. Presses queue, so each
  // steps from where the last landed.
  let cycling = Promise.resolve();

  // A step answers false when it changed nothing.
  function queued(step) {
    cycling = cycling.then(async () => {
      if ((await step()) === false || !onPlay) return;
      // A read that began before the change can still say the old tab is open.
      await inflight;
      await pollNow();
    }).catch(() => {});
    return cycling;
  }

  function cycleTab(direction) {
    return queued(() => {
      if (!strip.length) return false;
      const at = strip.findIndex((tab) => tab.current);
      const next = at < 0 ? (direction < 0 ? strip.length - 1 : 0) : (at + direction + strip.length) % strip.length;
      return next === at ? false : strip[next].open();
    });
  }

  // Ctrl+1 to Ctrl+8 open that tab counted from the left; Ctrl+9 opens the last one.
  function jumpTab(index) {
    return queued(() => {
      const tab = index === 9 ? strip[strip.length - 1] : strip[index - 1];
      return !tab || tab.current ? false : tab.open();
    });
  }

  // Ctrl+W closes the open tab like its close button; nothing happens on Home.
  function closeTab() {
    return queued(() => {
      const tab = strip.find((t) => t.current);
      return tab && tab.close ? tab.close() : false;
    });
  }

  function tabShortcut(shortcut) {
    if (!shortcut || typeof shortcut !== 'object') return undefined;
    if (shortcut.type === 'cycle') return cycleTab(shortcut.direction === -1 ? -1 : 1);
    if (shortcut.type === 'close') return closeTab();
    if (shortcut.type === 'jump' && Number.isInteger(shortcut.index) && shortcut.index >= 1 && shortcut.index <= 9) {
      return jumpTab(shortcut.index);
    }
    return undefined;
  }

  if (typeof desktop.onTabShortcut === 'function') desktop.onTabShortcut(tabShortcut);

  // A room opened or switched inside the client: read the session now, not at the next poll. A read
  // in progress may predate the change, so one more follows, and another shortly after to pick up
  // the room's title (a new room is named by its ID until the server sends it).
  let changeQueued = false;
  let titleTimer = null;
  function clientChanged() {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(pollNow, 350);
    if (changeQueued) return;
    changeQueued = true;
    Promise.resolve(inflight).then(() => {
      changeQueued = false;
      return pollNow();
    }).catch(() => { changeQueued = false; });
  }
  if (typeof desktop.onClientChange === 'function') desktop.onClientChange(clientChanged);

  window.showdownNav = { matchup, closeRoom, pollNow, tabShortcut, closePracticeBattle };
  // Each page is a fresh document. Draw the strip from this window's last session read at once so
  // it never flashes empty; the first read replaces it. Nothing navigates on stale data.
  try {
    const last = JSON.parse(sessionStorage.getItem(lastSessionKey));
    if (last && last.ready && Array.isArray(last.rooms)) render(last);
  } catch {}
  const updateLink = document.querySelector('a[href="settings.html"] .nav-text');
  function updateStatus(state) {
    if (updateLink) {
      updateLink.textContent = state?.phase === 'ready' ? 'Update ready' : 'Settings';
      updateLink.closest('a').title = state?.phase === 'ready' ? 'Settings: update ready to install' : 'Settings';
    }
    if (state?.currentVersion) {
      for (const node of document.querySelectorAll('.rail-version, .rail-user-text > span')) {
        node.textContent = `v${state.currentVersion}${state.mode === 'development' ? '-dev' : ''}`;
      }
    }
  }
  desktop.onUpdateChange?.(updateStatus);
  desktop.getUpdates?.().then(updateStatus).catch(() => {});
  pollNow();
})();
