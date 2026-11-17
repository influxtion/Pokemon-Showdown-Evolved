'use strict';

// The Bots page: one collapsible group of cards per difficulty, hardest first. Each card starts a
// practice battle against its bot. The simple bots run on this computer; Foul Play needs the cloud.
(() => {
  const $ = id => document.getElementById(id);
  const status = $('practice-status');
  const message = $('practice-message');
  const running = $('practice-running');
  const go = $('practice-go');
  const groups = $('practice-bots');
  let busy = false;
  let polling = false;
  let actionError = '';
  let built = '';

  const GROUPS = [['hard', 'Hard'], ['medium', 'Medium'], ['easy', 'Easy']];
  const FORMATS = { gen9randombattle: 'Random Battle', gen9ou: 'OU' };
  const COLLAPSED = 'bots.collapsed';
  // Line icons, 24 × 24, drawn in the card's accent color. Static markup, never built from data.
  const ICONS = {
    foulplay: '<circle cx="12" cy="4.5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 6.5v10.5M12 10l-7 7M12 10l7 7"/>',
    heuristic: '<path d="M4 6.5l1.5 1.5L8.5 5M4 12.5l1.5 1.5 3-3M4 18.5l1.5 1.5 3-3M11.5 6.5H20M11.5 12.5H20M11.5 18.5H20"/>',
    greedy: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6l1-8z"/>',
    random: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
    bot: '<rect x="3.5" y="7.5" width="17" height="12" rx="3"/><path d="M12 7.5V4M9 13v1M15 13v1"/>',
  };
  const CLOUD = '<path d="M4.5 12.5h7a2.75 2.75 0 0 0 .4-5.47A4 4 0 0 0 4.2 6.4 3.05 3.05 0 0 0 4.5 12.5z"/>';
  const CHEVRON = '<path d="M3 4.5l3 3 3-3"/>';

  const collapsed = new Set((() => {
    try { const value = JSON.parse(localStorage.getItem(COLLAPSED) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
  })());

  function svg(paths, viewBox, extra = {}) {
    const template = document.createElement('template');
    template.innerHTML = `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const element = template.content.firstElementChild;
    for (const [key, value] of Object.entries(extra)) element.setAttribute(key, value);
    return element;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // What the Foul Play card says about the cloud server, and whether it can start.
  function cloudState(cloud) {
    if (!cloud?.configured) return { ready: false, text: 'Cloud server not set up in this build', tone: 'warn' };
    if (!cloud.checked) return { ready: true, text: 'Checking the cloud server…' };
    if (!cloud.online) return { ready: true, text: "Can't reach the cloud server", tone: 'warn' };
    if (!cloud.available) return { ready: false, text: 'Unavailable on the cloud server', tone: 'warn' };
    if (cloud.busy) return { ready: true, text: 'Cloud server busy, try again shortly', tone: 'warn' };
    return { ready: true, text: 'Cloud server, online' };
  }

  function card(bot) {
    const article = element('article', 'bot-card');
    article.dataset.bot = bot.id;
    const body = element('div', 'bot-card-body');
    const name = element('div', 'bot-card-name');
    name.append(svg(ICONS[bot.id] || ICONS.bot, '0 0 24 24'), element('h4', '', bot.name));
    const formats = (bot.formats || []).map(format => FORMATS[format] || format).join(', ');
    body.append(name, element('p', 'bot-card-meta', [bot.kind, formats].filter(Boolean).join(' · ')),
      element('p', 'bot-card-text', bot.description || ''));
    const foot = element('div', 'bot-card-foot');
    if (!bot.local) {
      const cloud = element('span', 'bot-card-cloud');
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

  // Builds the groups once per bot list; refresh() then only updates their state.
  function build(list) {
    const key = list.map(bot => `${bot.id}:${bot.difficulty}`).join(',');
    if (key === built) return;
    built = key;
    const sections = [];
    for (const [id, label] of GROUPS) {
      const members = list.filter(bot => (bot.difficulty || 'easy') === id);
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
        try { localStorage.setItem(COLLAPSED, JSON.stringify([...collapsed])); } catch { /* Remembering is optional. */ }
      });
      heading.append(toggle);
      section.append(heading, grid);
      sections.push(section);
    }
    groups.replaceChildren(...sections);
  }

  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const value = await window.desktop.getPractice();
      const active = value.state === 'ready' || value.state === 'starting';
      const list = Array.isArray(value.opponents) ? value.opponents : [];
      build(list);
      const cloud = cloudState(value.cloud);
      for (const article of groups.querySelectorAll('.bot-card')) {
        const bot = list.find(item => item.id === article.dataset.bot);
        const note = article.querySelector('.bot-card-cloud');
        if (note) {
          note.className = `bot-card-cloud${cloud.tone ? ` bot-card-cloud--${cloud.tone}` : ''}`;
          note.querySelector('.bot-card-cloud-text').textContent = cloud.text;
        }
        article.querySelector('.bot-play').disabled = busy || active || !value.installed || (!bot?.local && !cloud.ready);
      }

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
    const pending = window.desktop.startPractice({ opponent });
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
    if (settled && !settled.ok && !settled.cancelled) actionError = settled.error || 'Practice could not start.';
    busy = false;
    await refresh();
  }

  refresh();
  setInterval(refresh, 1000);
})();
