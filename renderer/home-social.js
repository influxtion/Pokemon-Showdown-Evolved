'use strict';

// The conversation is the native Showdown view, clipped to the Friends panel.
(() => {
  const get = id => document.getElementById(id);
  const desktop = window.desktop;
  const panel = get('home-contact');
  const area = get('home-chat-view');
  const recent = get('home-conversations');
  let session = { ready: false, connected: false, messages: [] };
  let target = null;
  let version = 0;
  let active = false;
  let stopped = false;
  let started = 0;
  let frame = null;
  let recentKey = '';

  function hideChat() {
    active = false;
    area.hidden = true;
    desktop.hideClient();
  }
  function back() {
    version++;
    hideChat();
    target = null;
    panel.hidden = true;
    get('friends').hidden = false;
    get('friends-head').hidden = false;
    recent.hidden = !recent.childElementCount;
    get('challenge-toggle').focus();
  }
  function status(text) { get('contact-status').textContent = text; }
  function showContact(name) {
    hideChat();
    target = null;
    panel.hidden = false;
    get('friends').hidden = true;
    get('friends-head').hidden = true;
    recent.hidden = true;
    get('contact-name').textContent = name;
    for (const id of ['contact-chat', 'contact-challenge', 'contact-full']) get(id).hidden = true;
    panel.scrollIntoView({ block: 'nearest' });
  }
  function availability() {
    const ready = session.ready && session.connected;
    get('contact-chat').disabled = !ready;
    get('contact-challenge').disabled = !ready || !target?.online || !get('format').value ||
      target.userid === String(session.me || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  async function search(name) {
    const request = ++version;
    showContact(name || 'Search a user');
    status('Searching…');
    try {
      const result = await desktop.showdown('find-user', { user: name });
      if (stopped || request !== version) return;
      if (!result?.ok) throw new Error('Could not look up this user. Check the name and connection, then try again.');
      target = result;
      get('contact-name').textContent = result.name;
      status(result.online ? result.status || 'Online' : 'Offline or not found. Messages may not be delivered.');
      get('contact-chat').hidden = get('contact-challenge').hidden = false;
      availability();
      get('contact-chat').focus();
    } catch (error) {
      if (!stopped && request === version) status(error.message || 'User search failed. Try again.');
    }
  }
  function syncBounds() {
    frame = null;
    if (!active || stopped || area.hidden) return;
    if (!session.ready || !session.connected) { desktop.hideClient(); return; }
    const rect = area.getBoundingClientRect();
    const viewport = get('hub').getBoundingClientRect();
    const left = Math.max(rect.left, viewport.left, 0);
    const top = Math.max(rect.top, viewport.top, 0);
    const right = Math.min(rect.right, viewport.right, innerWidth);
    const bottom = Math.min(rect.bottom, viewport.bottom, innerHeight);
    if (right - left < 100 || bottom - top < 100 || document.querySelector('dialog[open]')) {
      desktop.hideClient();
      return;
    }
    desktop.showClient({ x: left, y: top, width: right - left, height: bottom - top });
  }
  function queueBounds() {
    if (frame === null && !stopped) frame = requestAnimationFrame(syncBounds);
  }
  async function chat(user) {
    const request = ++version;
    showContact(user.name);
    target = user;
    status('Opening chat…');
    try {
      const name = user.name && user.name.length <= 18 && user.name.toLowerCase().replace(/[^a-z0-9]/g, '') === user.userid
        ? user.name : user.userid;
      const result = await desktop.showdown('start-chat', { user: name });
      if (stopped || request !== version) return;
      if (result === 'needs-client') { location.href = 'play.html'; return; }
      if (result !== true) throw new Error('Chat is unavailable. Reconnect to Showdown and try again.');
      active = true;
      started = performance.now();
      area.hidden = false;
      get('contact-full').hidden = false;
      get('contact-challenge').hidden = false;
      status('Enter to send · Shift+Enter for a new line');
      availability();
      panel.scrollIntoView({ block: 'nearest' });
      queueBounds();
      window.showdownNav?.pollNow();
    } catch (error) {
      if (!stopped && request === version) status(error.message || 'Chat could not be opened.');
    }
  }
  get('challenge-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = get('challenge-user').value.trim();
    if (name) search(name);
  });
  get('contact-back').addEventListener('click', back);
  get('contact-chat').addEventListener('click', () => { if (target) chat(target); });
  get('contact-full').addEventListener('click', () => { if (active) location.href = 'play.html'; });
  get('contact-challenge').addEventListener('click', async () => {
    if (!target) return;
    const request = version;
    try {
      const result = await desktop.showdown('challenge', { user: target.userid, format: get('format').value });
      if (stopped || request !== version) return;
      if (result) location.href = 'play.html';
      else status('Could not open the challenge. Try again.');
    } catch { if (request === version) status('Could not open the challenge. Try again.'); }
  });
  get('format').addEventListener('change', availability);
  get('friends').addEventListener('click', event => {
    const button = event.target.closest('[data-friend-chat]');
    if (button) chat({ userid: button.dataset.friendChat, name: button.dataset.friendName, online: button.dataset.friendOnline === 'true' });
  });
  document.addEventListener('showdown-session', event => {
    session = event.detail;
    availability();
    const allMessages = session.messages || [];
    const messages = allMessages.slice(0, 20);
    const key = JSON.stringify(messages.map(m => [m.userid, m.name, m.unread]));
    if (recentKey !== key) {
      recentKey = key;
      recent.replaceChildren();
      if (messages.length) {
        const label = document.createElement('strong');
        label.textContent = 'Conversations';
        recent.append(label);
        for (const user of messages) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'home-conversation';
          button.textContent = user.name + (user.unread ? ' · Unread' : '');
          button.addEventListener('click', () => chat({ ...user, online: true }));
          recent.append(button);
        }
      }
    }
    recent.hidden = !panel.hidden || !messages.length;
    if (!active) return;
    if (!session.ready || !session.connected) {
      desktop.hideClient();
      status('Reconnecting to Showdown… Your conversation is kept.');
    } else if (performance.now() - started > 1000 && !allMessages.some(m => m.userid === target.userid)) {
      back();
    } else if (session.popups || (performance.now() - started > 1000 &&
        (session.current !== '' || session.menuTab !== 'pm' || session.pmOpen !== target.userid))) {
      hideChat();
      location.href = 'play.html';
    } else {
      status('Enter to send · Shift+Enter for a new line');
      queueBounds();
    }
  });
  const poll = setInterval(() => { if (active) window.showdownNav?.pollNow(); }, 1000);
  const observer = new ResizeObserver(queueBounds);
  observer.observe(area);
  observer.observe(get('hub'));
  document.addEventListener('scroll', queueBounds, true);
  window.addEventListener('resize', queueBounds);
  window.addEventListener('pagehide', () => {
    stopped = true;
    active = false;
    version++;
    observer.disconnect();
    clearInterval(poll);
    if (frame !== null) cancelAnimationFrame(frame);
  });
})();
