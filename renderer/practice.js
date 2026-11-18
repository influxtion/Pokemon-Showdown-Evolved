'use strict';

// The Bots page: format tabs, then one collapsible group of cards per difficulty, hardest first.
// Each card starts a practice battle against its bot. The simple bots run on this computer; the
// Foul Play levels play on the cloud server unless the player opts in: the "Foul Play on this
// computer" panel downloads Foul Play and then lets them choose where it runs. In OU the player
// also picks both teams, each from the Teambuilder or pasted; Play waits until both are legal.
(() => {
  const $ = id => document.getElementById(id);
  const status = $('practice-status');
  const message = $('practice-message');
  const running = $('practice-running');
  const go = $('practice-go');
  const groups = $('practice-bots');
  const teamsSection = $('practice-teams');
  let busy = false;
  let polling = false;
  let actionError = '';
  let built = '';

  const GROUPS = [['hard', 'Hard'], ['medium', 'Medium'], ['easy', 'Easy']];
  const FORMATS = { gen9randombattle: 'Random Battle', gen9ou: 'OU' };
  // Formats where the player brings both teams.
  const TEAM_FORMATS = ['gen9ou'];
  const COLLAPSED = 'bots.collapsed';
  const FORMAT_KEY = 'bots.format';
  // The last Teambuilder team picked for each side, by index and name. Pasted teams are never saved.
  const PICKS_KEY = 'bots.ouTeams';
  const SIDES = ['player', 'bot'];
  // Line icons, 24 × 24, drawn in the card's accent color. Static markup, never built from data.
  // The Foul Play levels share one search tree, with fewer branches the weaker the level.
  const ICONS = {
    foulplay: '<circle cx="12" cy="4.5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 6.5v10.5M12 10l-7 7M12 10l7 7"/>',
    'foulplay-medium': '<circle cx="12" cy="4.5" r="2"/><circle cx="7" cy="19" r="2"/><circle cx="17" cy="19" r="2"/><path d="M12 6.5V10M12 10l-5 7M12 10l5 7"/>',
    'foulplay-casual': '<circle cx="12" cy="4.5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M12 6.5v10.5"/>',
    heuristic: '<path d="M4 6.5l1.5 1.5L8.5 5M4 12.5l1.5 1.5 3-3M4 18.5l1.5 1.5 3-3M11.5 6.5H20M11.5 12.5H20M11.5 18.5H20"/>',
    greedy: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6l1-8z"/>',
    random: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
    bot: '<rect x="3.5" y="7.5" width="17" height="12" rx="3"/><path d="M12 7.5V4M9 13v1M15 13v1"/>',
  };
  const CLOUD = '<path d="M4.5 12.5h7a2.75 2.75 0 0 0 .4-5.47A4 4 0 0 0 4.2 6.4 3.05 3.05 0 0 0 4.5 12.5z"/>';
  const COMPUTER = '<rect x="2" y="3" width="12" height="8" rx="1"/><path d="M6 13.5h4M8 11v2.5"/>';
  const CHEVRON = '<path d="M3 4.5l3 3 3-3"/>';

  const remembered = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  const remember = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Remembering is optional. */ } };
  const collapsed = new Set((() => { const value = remembered(COLLAPSED); return Array.isArray(value) ? value : []; })());
  const saveCollapsed = () => remember(COLLAPSED, [...collapsed]);
  let format = Object.hasOwn(FORMATS, remembered(FORMAT_KEY)) ? remembered(FORMAT_KEY) : 'gen9randombattle';

  function svg(paths, viewBox, extra = {}) {
    const template = document.createElement('template');
    template.innerHTML = `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const node = template.content.firstElementChild;
    for (const [key, value] of Object.entries(extra)) node.setAttribute(key, value);
    return node;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---- Teams (OU) -------------------------------------------------------------------------

  // One side's choice. `result` is the last check: { ok, species } or { ok: false, error }.
  const picks = remembered(PICKS_KEY) || {};
  const sides = Object.fromEntries(SIDES.map(side => {
    const slot = teamsSection.querySelector(`.team-slot[data-side="${side}"]`);
    const saved = picks[side] && Number.isSafeInteger(picks[side].index) && typeof picks[side].name === 'string' ? picks[side] : null;
    return [side, { slot, source: 'teambuilder', pick: saved, text: '', result: null, checking: false, ticket: 0, timer: null,
      select: slot.querySelector('.team-pick'), paste: slot.querySelector('.team-paste'), note: slot.querySelector('.team-slot-note') }];
  }));
  let teambuilder = { ready: false, teams: [] };
  let teamsKey = '';

  function teamSpec(side) {
    const state = sides[side];
    if (state.source === 'paste') return state.text.trim() ? { source: 'paste', text: state.text } : null;
    return state.pick ? { source: 'teambuilder', index: state.pick.index, name: state.pick.name } : null;
  }

  const teamsReady = () => SIDES.every(side => sides[side].result?.ok && !sides[side].checking);

  function showSide(side) {
    const state = sides[side];
    for (const button of state.slot.querySelectorAll('.team-source button')) {
      button.setAttribute('aria-selected', String(button.dataset.source === state.source));
    }
    state.select.hidden = state.source !== 'teambuilder';
    state.paste.hidden = state.source !== 'paste';
    const failed = state.result && !state.result.ok;
    (state.source === 'paste' ? state.paste : state.select).setAttribute('aria-invalid', String(Boolean(failed)));
    let text = '';
    let tone = '';
    if (state.checking) { text = 'Checking the team…'; tone = 'quiet'; }
    else if (state.result?.ok) text = `${state.result.species.join(' · ')}. Legal for OU.`;
    else if (failed) { text = state.result.error || 'This team cannot be used.'; tone = 'err'; }
    else if (state.source === 'paste') { text = 'Paste the text from the Teambuilder’s Import/Export.'; tone = 'quiet'; }
    else if (!teambuilder.ready) { text = 'Loading your Teambuilder teams…'; tone = 'quiet'; }
    else if (!teambuilder.teams.length) { text = 'No OU teams in your Teambuilder yet. Build one there, or paste a team.'; tone = 'quiet'; }
    else { text = 'Choose one of your OU teams.'; tone = 'quiet'; }
    state.note.textContent = text;
    state.note.className = `team-slot-note${tone ? ` team-slot-note--${tone}` : ''}`;
  }

  async function check(side) {
    const state = sides[side];
    clearTimeout(state.timer);
    const spec = teamSpec(side);
    const ticket = ++state.ticket;
    state.checking = Boolean(spec);
    if (!spec) {
      state.result = null;
      showSide(side);
      updatePlay();
      return;
    }
    showSide(side);
    updatePlay();
    let result;
    try { result = await window.desktop.checkPracticeTeam(format, spec); } catch { result = null; }
    if (ticket !== state.ticket) return;
    state.checking = false;
    state.result = result && typeof result.ok === 'boolean' ? result : { ok: false, error: 'The team could not be checked.' };
    showSide(side);
    updatePlay();
  }

  // Fills the Teambuilder list, keeping the remembered pick if that team is still there.
  function fillTeams() {
    const key = JSON.stringify(teambuilder);
    if (key === teamsKey) return;
    teamsKey = key;
    for (const side of SIDES) {
      const state = sides[side];
      const options = [];
      const blank = element('option', '', teambuilder.teams.length ? 'Choose a team' : teambuilder.ready ? 'No OU teams' : 'Loading…');
      blank.value = '';
      options.push(blank);
      for (const team of teambuilder.teams) {
        const option = element('option', '', team.name);
        option.value = String(team.index);
        options.push(option);
      }
      state.select.replaceChildren(...options);
      state.select.disabled = !teambuilder.teams.length;
      const kept = state.pick && (teambuilder.teams.find(team => team.index === state.pick.index && team.name === state.pick.name) ||
        teambuilder.teams.filter(team => team.name === state.pick.name).length === 1 && teambuilder.teams.find(team => team.name === state.pick.name));
      const before = state.pick;
      if (teambuilder.ready) state.pick = kept ? { index: kept.index, name: kept.name } : null;
      state.select.value = state.pick ? String(state.pick.index) : '';
      const moved = JSON.stringify(before) !== JSON.stringify(state.pick);
      if (state.source === 'teambuilder' && (moved || (state.pick && !state.result && !state.checking))) check(side);
      else showSide(side);
    }
    if (teambuilder.ready) savePicks();
  }

  function savePicks() {
    remember(PICKS_KEY, Object.fromEntries(SIDES.filter(side => sides[side].pick).map(side => [side, sides[side].pick])));
  }

  async function loadTeams() {
    if (!TEAM_FORMATS.includes(format)) return;
    const value = await window.desktop.getPracticeTeams(format).catch(() => null);
    if (!value) return;
    teambuilder = { ready: Boolean(value.ready), teams: Array.isArray(value.teams) ? value.teams : [] };
    fillTeams();
  }

  for (const side of SIDES) {
    const state = sides[side];
    for (const button of state.slot.querySelectorAll('.team-source button')) {
      button.addEventListener('click', () => {
        if (state.source === button.dataset.source) return;
        state.source = button.dataset.source;
        state.result = null;
        showSide(side);
        if (state.source === 'paste') state.paste.focus();
        check(side);
      });
    }
    state.select.addEventListener('change', () => {
      const team = teambuilder.teams.find(value => String(value.index) === state.select.value);
      state.pick = team ? { index: team.index, name: team.name } : null;
      savePicks();
      check(side);
    });
    state.paste.addEventListener('input', () => {
      state.text = state.paste.value;
      state.result = null;
      clearTimeout(state.timer);
      state.ticket++;
      state.checking = false;
      showSide(side);
      updatePlay();
      state.timer = setTimeout(() => check(side), 400);
    });
  }

  {
    const toggle = $('bots-group-teams');
    const grid = $('bots-teams');
    const show = open => { toggle.setAttribute('aria-expanded', String(open)); grid.hidden = !open; };
    show(!collapsed.has('teams'));
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      show(open);
      if (open) collapsed.delete('teams'); else collapsed.add('teams');
      saveCollapsed();
    });
  }

  // ---- Format tabs and cards ----------------------------------------------------------------

  function showFormat() {
    for (const tab of document.querySelectorAll('.bots-format')) tab.setAttribute('aria-selected', String(tab.dataset.format === format));
    teamsSection.hidden = !TEAM_FORMATS.includes(format);
    if (TEAM_FORMATS.includes(format)) { for (const side of SIDES) showSide(side); loadTeams(); }
  }

  for (const tab of document.querySelectorAll('.bots-format')) {
    tab.addEventListener('click', () => {
      if (tab.dataset.format === format) return;
      format = tab.dataset.format;
      remember(FORMAT_KEY, format);
      actionError = '';
      showFormat();
      refresh();
    });
  }

  // What a Foul Play card says about the cloud server, and whether it can start.
  function cloudState(cloud) {
    if (!cloud?.configured) return { ready: false, text: 'Cloud server not set up in this build', tone: 'warn' };
    if (!cloud.checked) return { ready: true, text: 'Checking the cloud server…' };
    if (!cloud.online) return { ready: true, text: "Can't reach the cloud server", tone: 'warn' };
    if (!cloud.available) return { ready: false, text: 'Unavailable on the cloud server', tone: 'warn' };
    // Busy is still playable: the battle waits in line for the next free engine.
    if (cloud.busy) {
      const waiting = cloud.waiting > 0 ? ` · ${cloud.waiting} waiting` : '';
      return { ready: true, text: cloud.queue ? `Cloud server busy${waiting}. You'll wait in line` : 'Cloud server busy, try again shortly', tone: 'warn' };
    }
    return { ready: true, text: 'Cloud server, online' };
  }

  function card(bot) {
    const article = element('article', 'bot-card');
    article.dataset.bot = bot.id;
    const body = element('div', 'bot-card-body');
    const name = element('div', 'bot-card-name');
    name.append(svg(ICONS[bot.id] || ICONS.bot, '0 0 24 24'), element('h4', '', bot.name));
    const formats = (bot.formats || []).map(value => FORMATS[value] || value).join(', ');
    body.append(name, element('p', 'bot-card-meta', [bot.kind, formats].filter(Boolean).join(' · ')),
      element('p', 'bot-card-text', bot.description || ''));
    const foot = element('div', 'bot-card-foot');
    if (!bot.local) {
      const cloud = element('span', 'bot-card-cloud');
      cloud.dataset.icon = 'cloud';
      cloud.append(svg(CLOUD, '0 0 16 16', { 'stroke-width': '1.4' }), element('span', 'bot-card-cloud-text'));
      foot.append(cloud);
    }
    const play = element('button', 'btn btn-primary bot-play', 'Play');
    play.type = 'button';
    play.setAttribute('aria-label', `Play against ${bot.name}`);
    play.addEventListener('click', () => begin(bot.id));
    foot.append(play);
    article.append(body, foot);
    return article;
  }

  // Builds the groups once per bot list and format; refresh() then only updates their state.
  function build(list) {
    const shown = list.filter(bot => (bot.formats || []).includes(format));
    const key = `${format}|${shown.map(bot => `${bot.id}:${bot.difficulty}`).join(',')}`;
    if (key === built) return;
    built = key;
    const sections = [];
    for (const [id, label] of GROUPS) {
      const members = shown.filter(bot => (bot.difficulty || 'easy') === id);
      if (!members.length) continue;
      const section = element('section', 'bots-group');
      const heading = element('h3');
      const toggle = element('button', 'bots-group-toggle');
      toggle.type = 'button';
      toggle.id = `bots-group-${id}`;
      toggle.setAttribute('aria-controls', `bots-grid-${id}`);
      toggle.append(svg(CHEVRON, '0 0 12 12', { 'stroke-width': '1.6' }), label, element('span', 'bots-group-count', String(members.length)));
      const grid = element('div', 'bots-grid');
      grid.id = `bots-grid-${id}`;
      grid.append(...members.map(card));
      const show = open => {
        toggle.setAttribute('aria-expanded', String(open));
        grid.hidden = !open;
      };
      show(!collapsed.has(id));
      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        show(open);
        if (open) collapsed.delete(id); else collapsed.add(id);
        saveCollapsed();
      });
      heading.append(toggle);
      section.append(heading, grid);
      sections.push(section);
    }
    groups.replaceChildren(...sections);
  }

  let last = null;

  // ---- Foul Play on this computer (opt-in) --------------------------------------------------

  const local = {
    panel: $('practice-local'), note: $('bots-local-note'), progress: $('bots-local-progress'), fill: $('bots-local-fill'),
    bar: document.querySelector('.bots-local-bar'), step: $('bots-local-step'), where: $('bots-local-where'),
    download: $('bots-local-download'), cancel: $('bots-local-cancel'), remove: $('bots-local-remove'),
  };
  let localBusy = false;
  let localError = '';
  const ABOUT = 'Want to skip the queue or have a strong PC? Download Foul Play and play locally without our cloud servers.';

  function showLocal(value) {
    const state = value.local;
    // Only shown next to the Foul Play cards, and only where Foul Play can run.
    const foulPlayShown = Boolean(groups.querySelector('.bot-card[data-bot^="foulplay"]'));
    local.panel.hidden = !state || !state.supported || !foulPlayShown;
    if (local.panel.hidden) return;
    const active = value.state === 'ready' || value.state === 'starting';
    const localBattle = active && value.engine === 'local';
    let note = ABOUT;
    let tone = '';
    if (state.installing) {
      note = 'Downloading Foul Play. You can keep using the app; the cloud server stays available meanwhile.';
    } else if (localError || state.error) {
      note = `The download did not finish: ${localError || state.error}`;
      tone = 'err';
    } else if (state.installed && !state.current) {
      note = 'An update for Foul Play on this computer is available.';
    } else if (state.installed) {
      note = `Downloaded${state.revision ? ` (Foul Play ${state.revision})` : ''}. On this computer it searches with up to ` +
        `${state.threads} thread${state.threads === 1 ? '' : 's'}, at low priority so your battle stays smooth.`;
    }
    local.note.textContent = note;
    local.note.className = `bots-local-note${tone ? ` bots-local-note--${tone}` : ''}`;

    const progress = state.progress;
    local.progress.hidden = !state.installing;
    if (state.installing) {
      const percent = Math.round(Math.max(0, Math.min(1, progress?.fraction || 0)) * 100);
      local.fill.style.width = `${percent}%`;
      local.bar.setAttribute('aria-valuenow', String(percent));
      local.step.textContent = progress ? `${progress.label} · ${percent}%` : 'Starting…';
    }

    local.where.hidden = !state.installed || state.installing;
    const choice = runsLocally(value) ? 'local' : 'cloud';
    for (const button of local.where.querySelectorAll('button')) {
      button.setAttribute('aria-checked', String(button.dataset.engine === choice));
      button.tabIndex = button.dataset.engine === choice ? 0 : -1;
      button.disabled = localBusy || active;
    }
    local.download.hidden = state.installing || (state.installed && state.current);
    local.download.textContent = state.installed ? 'Update' : localError || state.error ? 'Try again' : 'Download';
    local.download.disabled = localBusy || localBattle;
    local.cancel.hidden = !state.installing;
    local.remove.hidden = !state.installed || state.installing;
    local.remove.disabled = localBusy || localBattle;
  }

  async function localAction(run) {
    if (localBusy) return;
    localBusy = true;
    localError = '';
    if (last) showLocal(last);
    try {
      const result = await run();
      if (result && !result.ok && !result.cancelled && result.error) localError = result.error;
    } catch {
      localError = 'Something went wrong. Try again.';
    } finally {
      localBusy = false;
      await refresh();
    }
  }

  local.download.addEventListener('click', () => localAction(() => window.desktop.installLocalPractice()));
  local.cancel.addEventListener('click', () => localAction(() => window.desktop.cancelLocalPracticeInstall()));
  local.remove.addEventListener('click', () => localAction(() => window.desktop.removeLocalPractice()));
  const choose = engine => localAction(async () => {
    const result = await window.desktop.setSetting('practiceEngine', engine);
    return result?.ok ? { ok: true } : { ok: false, error: result?.error || 'The choice could not be saved.' };
  });
  for (const button of local.where.querySelectorAll('button')) {
    button.addEventListener('click', () => { if (button.getAttribute('aria-checked') !== 'true') choose(button.dataset.engine); });
    // Arrow keys move between the two options, as in any radio group.
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const other = local.where.querySelector(`button:not([data-engine="${button.dataset.engine}"])`);
      other.focus();
      choose(other.dataset.engine);
    });
  }

  // Where Foul Play will run for the next battle, and what its cards say about it.
  const runsLocally = value => value.engineChoice === 'local' && Boolean(value.local?.installed);
  function engineState(value) {
    if (!runsLocally(value)) return { ...cloudState(value.cloud), icon: 'cloud' };
    if (value.local.installing) return { ready: false, text: 'Updating on this computer…', tone: 'warn', icon: 'computer' };
    return { ready: true, text: 'This computer', icon: 'computer' };
  }

  function updatePlay() {
    if (!last) return;
    const value = last;
    const active = value.state === 'ready' || value.state === 'starting';
    const list = Array.isArray(value.opponents) ? value.opponents : [];
    const cloud = engineState(value);
    const needsTeams = TEAM_FORMATS.includes(format);
    for (const article of groups.querySelectorAll('.bot-card')) {
      const bot = list.find(item => item.id === article.dataset.bot);
      const note = article.querySelector('.bot-card-cloud');
      if (note) {
        note.className = `bot-card-cloud${cloud.tone ? ` bot-card-cloud--${cloud.tone}` : ''}`;
        if (note.dataset.icon !== cloud.icon) {
          note.dataset.icon = cloud.icon;
          note.firstElementChild.replaceWith(svg(cloud.icon === 'computer' ? COMPUTER : CLOUD, '0 0 16 16', { 'stroke-width': '1.4' }));
        }
        note.querySelector('.bot-card-cloud-text').textContent = cloud.text;
      }
      const play = article.querySelector('.bot-play');
      play.disabled = busy || active || !value.installed || (!bot?.local && !cloud.ready) || (needsTeams && !teamsReady());
      play.title = needsTeams && !teamsReady() ? 'Choose both teams first' : '';
    }
  }

  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const value = await window.desktop.getPractice();
      last = value;
      const active = value.state === 'ready' || value.state === 'starting';
      build(Array.isArray(value.opponents) ? value.opponents : []);
      updatePlay();
      showLocal(value);

      // The battle plays in its own tab; while it runs, this page only leads back to it.
      running.hidden = !active;
      go.hidden = !active;
      status.textContent = !value.installed ? 'Battle server unavailable' : active ? 'Battle in progress' : value.state === 'failed' ? 'Practice failed' : 'Ready to play';
      status.className = `status status--${value.error ? 'err' : active ? 'ok' : 'off'}`;
      message.textContent = actionError || value.error ||
        (!value.installed ? 'The practice battle server is not installed in this build.' : '');
      message.hidden = !message.textContent;
    } catch {
      status.textContent = 'Practice status unavailable';
      for (const play of groups.querySelectorAll('.bot-play')) play.disabled = true;
    } finally { polling = false; }
  }

  // Starting opens the battle's tab as soon as the session exists; that tab shows the progress.
  async function begin(opponent) {
    busy = true;
    actionError = '';
    for (const play of groups.querySelectorAll('.bot-play')) play.disabled = true;
    const options = TEAM_FORMATS.includes(format)
      ? { opponent, format, teams: { player: teamSpec('player'), bot: teamSpec('bot') } } : { opponent };
    const pending = window.desktop.startPractice(options);
    let settled = null;
    pending.then(result => { settled = result || { ok: false }; }, () => { settled = { ok: false }; });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (settled && !settled.ok) break;
      const value = await window.desktop.getPractice().catch(() => null);
      if (value && (value.state === 'starting' || value.state === 'ready')) {
        location.href = 'practice-battle.html';
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (settled && !settled.ok && !settled.cancelled) {
      // A team that stopped being usable (edited or deleted in the Teambuilder) is shown on its slot.
      if (SIDES.includes(settled.side)) {
        check(settled.side);
      } else actionError = settled.error || 'Practice could not start.';
    }
    busy = false;
    await refresh();
  }

  showFormat();
  refresh();
  setInterval(refresh, 1000);
  setInterval(loadTeams, 4000);
})();
