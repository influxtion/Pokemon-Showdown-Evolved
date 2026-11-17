'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const status = $('practice-status');
  const start = $('practice-start');
  const go = $('practice-go');
  const startTitle = $('practice-start-title');
  const startNote = $('practice-start-note');
  const message = $('practice-message');
  const preset = $('practice-preset');
  const presetHint = $('practice-preset-hint');
  const description = $('practice-opponent-description');
  const cloudNote = $('practice-engine-cloud-note');
  const PRESET_HINT = presetHint.textContent;
  let busy = false;
  let polling = false;
  let actionError = '';

  function note(element, text, tone = '') {
    element.textContent = text;
    element.className = `engine-note${tone ? ` engine-note--${tone}` : ''}`;
  }

  function cloudState(cloud) {
    if (!cloud?.configured) return { ready: false, text: 'Not set up in this build.', tone: 'warn' };
    if (!cloud.checked) return { ready: true, text: 'Checking the server…' };
    if (!cloud.online) return { ready: true, text: "Can't reach the server right now.", tone: 'warn' };
    if (!cloud.available) return { ready: false, text: 'Foul Play is unavailable on the server right now.', tone: 'warn' };
    if (cloud.busy) return { ready: true, text: 'Online, but every engine is busy. Try again shortly.', tone: 'warn' };
    return { ready: true, text: 'Online.', tone: 'ok' };
  }

  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const value = await window.desktop.getPractice();
      const active = value.state === 'ready' || value.state === 'starting';
      if (active && ['quiet', 'balanced', 'full'].includes(value.preset)) preset.value = value.preset;
      const cloud = cloudState(value.cloud);
      note(cloudNote, cloud.text, cloud.tone);
      description.textContent = value.opponents?.[0]?.description || '';
      const cap = value.cloud?.presets?.full;
      presetHint.textContent = cap && cap < 8 ? `The cloud server runs up to ${cap} search thread${cap === 1 ? '' : 's'}. ${PRESET_HINT}` : PRESET_HINT;

      // The battle plays in its own tab; while it runs, this page only leads back to it.
      start.hidden = active;
      go.hidden = !active;
      startTitle.textContent = active ? 'A practice battle is running' : 'Unrated practice';
      startNote.textContent = active ? 'It stays open in its own tab. Close that tab to end practice.'
        : 'Separate from your online Showdown account. The battle opens in its own tab.';
      start.disabled = busy || !value.installed || !cloud.ready;
      preset.disabled = busy || active;
      let text = !value.installed ? 'Battle server unavailable' : active ? 'Battle in progress' : value.state === 'failed' ? 'Practice failed' : 'Ready to play';
      status.textContent = text;
      status.className = `status status--${value.error ? 'err' : active ? 'ok' : 'off'}`;
      message.textContent = actionError || value.error ||
        (!value.installed ? 'The practice battle server is not installed in this build.' : '');
      message.hidden = !message.textContent;
    } catch {
      status.textContent = 'Practice status unavailable';
      start.disabled = true;
    } finally { polling = false; }
  }

  // Starting opens the battle's tab as soon as the session exists; that tab shows the progress.
  async function begin() {
    busy = true;
    actionError = '';
    start.disabled = true;
    const pending = window.desktop.startPractice({ opponent: 'foulplay', preset: preset.value });
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

  start.addEventListener('click', begin);
  refresh();
  setInterval(refresh, 1000);
})();
