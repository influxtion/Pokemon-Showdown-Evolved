'use strict';

// Native conversations share a fixed dock, independent of Home and Friends layout.
(() => {
  const get = id => document.getElementById(id);
  const desktop = window.desktop;
  const dock = get('home-chat-dock');
  const area = get('home-chat-view');
  const recent = get('home-conversations');
  const profile = get('user-profile');
  let searchTarget = null;
  let searchVersion = 0;
  let session = { ready: false, connected: false, messages: [] };
  let version = 0;
  let active = false;
  let stopped = false;
  let opening = false;
  let dockConfirmed = false;
  let frame = null;
  let recentKey = '';

  function hideChat() {
    dock.hidden = true;
    desktop.hideClient();
  }
  function status(text) {
    get('home-chat-status').textContent = text;
    get('home-chat-status').hidden = !text;
  }
  function availability() {
    const ready = session.ready && session.connected;
    const canChallenge = user => ready && user?.online && get('format').value &&
      user.userid !== String(session.me || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    get('user-profile-message').disabled = !ready || !searchTarget;
    get('user-profile-challenge').disabled = !canChallenge(searchTarget);
  }
  function dismissProfile() {
    searchVersion++;
    searchTarget = null;
    if (profile.open) profile.close();
    queueBounds();
  }
  async function search(name) {
    const request = ++searchVersion;
    searchTarget = null;
    get('user-profile-name').textContent = name;
    get('user-profile-status').textContent = 'Searching…';
    get('user-profile-avatar').hidden = true;
    get('user-profile-avatar').removeAttribute('src');
    availability();
    desktop.hideClient();
    if (!profile.open) profile.showModal();
    try {
      const result = await desktop.showdown('find-user', { user: name });
      if (stopped || request !== searchVersion) return;
      if (!result?.ok) throw new Error('Could not look up this user. Check the name and connection, then try again.');
      searchTarget = result;
      get('user-profile-name').textContent = result.name;
      get('user-profile-status').textContent = result.online ? result.status || 'Online' : 'Offline or not found. Messages may not be delivered.';
      get('user-profile-avatar').src = result.avatar || 'https://play.pokemonshowdown.com/sprites/trainers/lucas.png';
      get('user-profile-avatar').hidden = false;
      availability();
    } catch (error) {
      if (!stopped && request === searchVersion) get('user-profile-status').textContent = error.message || 'User search failed. Try again.';
    }
  }
  function syncBounds() {
    frame = null;
    if (stopped || dock.hidden) return;
    if (!session.ready || !session.connected || document.querySelector('dialog[open]')) {
      desktop.hideClient();
      return;
    }
    const count = (session.messages || []).length;
    const available = innerWidth - get('hub').getBoundingClientRect().left - 32;
    const columns = Math.max(1, Math.floor(available / 320));
    dock.style.setProperty('--chat-width', Math.min(count, columns) * 320 + 'px');
    const rect = area.getBoundingClientRect();
    desktop.showClient({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  }
  function queueBounds() {
    if (frame === null && !stopped) frame = requestAnimationFrame(syncBounds);
  }
  async function chat(user) {
    dismissProfile();
    const request = ++version;
    opening = true;
    try {
      const name = user.name && user.name.length <= 18 && user.name.toLowerCase().replace(/[^a-z0-9]/g, '') === user.userid
        ? user.name : user.userid;
      const result = await desktop.showdown('start-chat', { user: name, dock: true });
      if (stopped || request !== version) return;
      if (result === 'needs-client') { location.href = 'play.html'; return; }
      if (result !== true) throw new Error('Chat is unavailable. Reconnect to Showdown and try again.');
      active = true;
      await window.showdownNav?.pollNow();
    } catch (error) {
      if (!stopped && request === version) {
        get('user-profile-name').textContent = user.name;
        get('user-profile-status').textContent = error.message || 'Chat could not be opened.';
        if (!profile.open) profile.showModal();
        desktop.hideClient();
      }
    } finally { if (request === version) { opening = false; if (!stopped) window.showdownNav?.pollNow(); } }
  }
  window.homeChat = { open: chat };
  get('challenge-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = get('challenge-user').value.trim();
    if (name) search(name);
  });
  get('user-profile-close').addEventListener('click', dismissProfile);
  profile.addEventListener('cancel', event => { event.preventDefault(); dismissProfile(); });
  profile.addEventListener('click', event => {
    const rect = profile.getBoundingClientRect();
    if (event.target === profile && (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom)) dismissProfile();
  });
  get('user-profile-message').addEventListener('click', () => { if (searchTarget) chat(searchTarget); });
  async function challenge(user, report) {
    if (!user) return;
    const request = version;
    const lookup = searchVersion;
    try {
      const result = await desktop.showdown('challenge', { user: user.userid, format: get('format').value });
      if (stopped || request !== version || lookup !== searchVersion) return;
      if (result) location.href = 'play.html';
      else report('Could not open the challenge. Try again.');
    } catch { if (!stopped && request === version && lookup === searchVersion) report('Could not open the challenge. Try again.'); }
  }
  get('user-profile-challenge').addEventListener('click', () => challenge(searchTarget,
    text => { get('user-profile-status').textContent = text; }));
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
    recent.hidden = !messages.length;
    if (opening) return;
    if (!session.ready || !session.connected) {
      if (active) { status('Reconnecting to Showdown… Your conversations are kept.'); desktop.hideClient(); }
      return;
    }
    if (!allMessages.length) { active = false; dockConfirmed = false; hideChat(); return; }
    if (!active && session.current !== '') { hideChat(); return; }
    if (active && dockConfirmed && (!session.chatDock || session.popups || session.current !== '')) {
      hideChat();
      location.href = 'play.html';
      return;
    }
    if (!active && !session.chatDock && session.current === '' && !session.popups) {
      opening = true;
      desktop.showdown('chat-dock', { enabled: true }).then(result => {
        if (!stopped && result === true) active = true;
      }).catch(() => {}).finally(() => { opening = false; if (!stopped) window.showdownNav?.pollNow(); });
      return;
    }
    if (!session.chatDock) return;
    dockConfirmed = true;
    active = true;
    status('');
    dock.hidden = false;
    queueBounds();
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
