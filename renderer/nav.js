'use strict';

// Tab strip: small tabs for launcher pages, then one tab per room open in the Showdown
// client, so the launcher owns navigation.
// Other pages can listen for the "showdown-session" event instead of polling again.
(() => {
  // Following the current page's link reloads the renderer and resets its UI.
  const currentPage = document.querySelector('.rail a.nav-item[aria-current="page"]');
  if (currentPage) currentPage.addEventListener('click', (event) => event.preventDefault());

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
    plus: svg('<path d="M8 3v10M3 8h10"/>', ' stroke-linecap="round"'),
    message: svg('<path d="M2 4h12v8H2zM2 4l6 5 6-5"/>', round),
    // Two crossed swords: blades, crossguards and grips.
    swords: svg('<path d="M2.5 2.5h2.5l6 6M11 11l2.5 2.5M9.5 12.5l3-3M13.5 2.5H11l-6 6M5 11l-2.5 2.5M3.5 9.5l3 3"/>', ' stroke-linecap="round" stroke-linejoin="round"'),
    other: svg('<rect x="3" y="3" width="10" height="10" rx="1.5"/>'),
    home: svg('<path d="M2.5 7.5 8 3l5.5 4.5V13H10V9.5H6V13H2.5z"/>', round),
    stats: svg('<path d="M3 13V9M8 13V3M13 13V6"/>', ' stroke-linecap="round"'),
    replays: svg('<path d="M4 2.5h8v11l-4-3-4 3z"/>', round),
    practice: svg('<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/>'),
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

  // focus-room and leave-room answer 'needs-client' when the client shows its own popup
  // (such as a forfeit confirmation); the user has to see it, so we go to play.html.
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

  async function closeRoom(id) {
    const result = await act('leave-room', { room: id });
    if (result === 'needs-client') {
      go('play.html');
    } else if (result === true) {
      const session = await pollNow();
      if (onPlay && session && session.ready && session.rooms.length === 0) location.href = 'index.html';
    }
    return result;
  }

  // Fixed rail tabs. Each one says how to reach its view in the client.
  const TABS = {
    battle: { title: 'Battle', kind: 'battle', action: 'show-menu', args: { tab: 'battle' } },
    teambuilder: { title: 'Teambuilder', kind: 'teambuilder', action: 'join', args: { room: 'teambuilder' } },
    community: { title: 'Community', kind: 'community', action: 'show-menu', args: { tab: 'community' } },
  };

  // Rooms reached from the Battle tab's links nest under it; the rest are Community's.
  const BATTLE_ROOMS = new Set(['ladder', 'battles', 'tournaments', 'smogtours']);
  const inBattle = (room) => room.battle || BATTLE_ROOMS.has(room.id);

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

  async function joinRooms() {
    await act('join', { room: 'rooms' });
    if (onPlay) pollNow();
    else go('play.html');
  }

  async function openTab(name) {
    await act(TABS[name].action, TABS[name].args);
    if (onPlay) pollNow();
    else go('play.html');
  }

  function row({ title, sub, tip, kind, live, unread, current, id, closable, tab, pm, challenge }) {
    const node = make('div', `nav-item ${tab ? 'nav-tab' : 'nav-room'}${live ? ' nav-item--live' : ''}${challenge ? ' nav-item--challenge' : ''}`);
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
    if (closable) {
      const close = make('button', 'rail-icon-btn nav-close');
      close.type = 'button';
      close.setAttribute('aria-label', `Close ${title}`);
      close.title = `Close ${title}`;
      close.append(icon(ICONS.x));
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        if (pm) closeConversation(pm);
        else closeRoom(id);
      });
      node.append(close);
    }
    if (tab === 'community') {
      const join = make('button', 'rail-icon-btn');
      join.type = 'button';
      join.setAttribute('aria-label', 'Join a room');
      join.title = 'Join a room';
      join.append(icon(ICONS.plus));
      join.addEventListener('click', joinRooms);
      node.append(join);
    }
    return node;
  }

  let lastKey = null;
  let lastSession = null;

  // Launcher pages are small tabs ahead of the room tabs. Home is always first; the others
  // appear once opened from the icon bar and stay until closed or the app restarts.
  // Teambuilder is the client's own room, so its tab follows that room being open.
  const PAGES = {
    'index.html': { title: 'Home', kind: 'home' },
    'stats.html': { title: 'Stats', kind: 'stats' },
    'replays.html': { title: 'Replays', kind: 'replays' },
    'practice.html': { title: 'Practice', kind: 'practice' },
    'settings.html': { title: 'Settings', kind: 'settings' },
    teambuilder: { title: 'Teambuilder', kind: 'teambuilder', room: true },
  };
  const isPage = (file) => Object.prototype.hasOwnProperty.call(PAGES, file);
  const pagesKey = 'nav.pages';
  const thisPage = (/([a-z]+\.html)(?:[?#].*)?$/.exec(String(location.href)) || [])[1] || '';

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
      location.href = pages[at - 1] || 'index.html';
      return;
    }
    lastKey = null;
    if (lastSession) render(lastSession);
  }

  function pageTab({ file, current }) {
    const { title, kind, room } = PAGES[file];
    const node = make('div', 'nav-item nav-page');
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
    if (file !== 'index.html') {
      const close = make('button', 'rail-icon-btn nav-close');
      close.type = 'button';
      close.setAttribute('aria-label', `Close ${title}`);
      close.title = `Close ${title}`;
      close.append(icon(ICONS.x));
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        if (room) closeRoom(file);
        else closePage(file);
      });
      node.append(close);
    }
    return node;
  }

  // Challenge bars sit under the top bar on every page, so a challenge can be answered
  // without leaving the current screen. Answers go through the client's own buttons.
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
    const community = session.menuTab === 'community';
    const tabRow = (tab, isCurrent, unread) => ({
      title: TABS[tab].title, kind: TABS[tab].kind, tab, unread, current: onPlay && isCurrent,
    });
    const roomRow = (r) => ({
      title: r.battle ? matchup(r, me) : r.title, sub: roomSub(r), kind: r.battle ? 'battle' : r.kind,
      live: !!r.battle && !r.ended, unread: !!r.unread, id: r.id, closable: true,
      current: onPlay && r.id === current,
    });
    // The Teambuilder room is a small page tab, so it never gets a row of its own.
    const rows = [
      tabRow('battle', current === '' && !community && session.menuTab !== 'pm', !!session.menuUnread),
      ...rooms.filter(inBattle).map(roomRow),
      tabRow('community', (current === '' && community) || current === 'rooms', false),
      ...rooms.filter((r) => !inBattle(r) && r.id !== 'teambuilder').map(roomRow),
    ];
    // Conversations and challenges, from the client's private message windows.
    const messages = (Array.isArray(session.messages) ? session.messages : []).map((m) => ({
      title: m.name, sub: messageSub(m), kind: 'message',
      tip: [m.name, messageSub(m), m.challenge && m.challenge.formatName].filter(Boolean).join(' · '), id: m.userid, pm: m.userid, closable: true,
      unread: !!m.unread || !!(m.challenge && m.challenge.dir === 'in'),
      challenge: !!(m.challenge && m.challenge.dir === 'in'),
      current: onPlay && current === '' && session.menuTab === 'pm' && session.pmOpen === m.userid,
    }));
    // Rebuild only on change so hover and focus survive each poll.
    // The Teambuilder page tab exists exactly while its room is open in the client.
    const teambuilding = onPlay && current === 'teambuilder';
    if (session.ready) {
      const open = rooms.some((r) => r.id === 'teambuilder');
      const at = pages.indexOf('teambuilder');
      if (open && at < 0) pages.push('teambuilder');
      else if (!open && at >= 0) pages.splice(at, 1);
      if (open !== at >= 0) savePages();
    }
    const railTeambuilder = $('teambuilder');
    if (railTeambuilder) {
      if (teambuilding) railTeambuilder.setAttribute('aria-current', 'page');
      else railTeambuilder.removeAttribute('aria-current');
    }
    const pageRows = ['index.html', ...pages].map((file) => ({
      file, current: PAGES[file].room ? teambuilding : !onPlay && file === thisPage,
    }));
    lastSession = session;
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

  // The icon bar's Teambuilder entry opens the client's Teambuilder room.
  if ($('teambuilder')) {
    $('teambuilder').addEventListener('click', (event) => {
      event.preventDefault();
      if (!(onPlay && lastSession && lastSession.current === 'teambuilder')) openTab('teambuilder');
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
    // A battle room is created before its player names arrive. Wait to classify it
    // so an early poll cannot suppress the later player match.
    session.rooms.forEach((r) => {
      if (!r.battle || r.ended || (r.players.length === 2 && r.players.every(Boolean))) known.add(r.id);
    });
    saveRooms(knownMe);
    return started;
  }

  let timer = null;
  let inflight = null;

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
    if (session.ready && battleStarted(session) && !onPlay) {
      location.href = 'play.html';
      return session;
    }
    document.dispatchEvent(new CustomEvent('showdown-session', { detail: session }));
    const searching = session.search && (session.search.pending || session.search.formats.length > 0);
    timer = setTimeout(pollNow, onPlay || searching ? 1000 : 3000);
    return session;
  }

  window.showdownNav = { matchup, closeRoom, pollNow };
  pollNow();
})();
