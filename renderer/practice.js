'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const status = $('practice-status');
  const setup = $('practice-setup');
  const area = $('practice-area');
  const start = $('practice-start');
  const stop = $('practice-stop');
  const next = $('practice-next');
  const message = $('practice-message');
  const preset = $('practice-preset');
  const presetHint = $('practice-preset-hint');
  const description = $('practice-opponent-description');
  const engineInputs = [...document.querySelectorAll('input[name="practice-engine"]')];
  const cloudNote = $('practice-engine-cloud-note');
  const localNote = $('practice-engine-local-note');
  const local = $('practice-local');
  const localText = $('practice-local-text');
  const progress = $('practice-install-progress');
  const progressStep = $('practice-install-step');
  const progressPercent = $('practice-install-percent');
  const progressBar = $('practice-install-bar');
  const progressDetail = $('practice-install-detail');
  const install = $('practice-install');
  const cancelInstall = $('practice-install-cancel');
  const removeLocal = $('practice-local-remove');
  const NAME = 'Foul Play';
  const PRESET_HINT = presetHint.textContent;
  let busy = false;
  let polling = false;
  let actionError = '';
  let engineInitialized = false;

  const selectedEngine = () => engineInputs.find(input => input.checked)?.value || 'cloud';
  const setEngine = value => { for (const input of engineInputs) input.checked = input.value === value; };

  function sync() {
    if (area.hidden) return;
    const bounds = area.getBoundingClientRect();
    window.desktop.showPractice({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  }

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
    return { ready: true, text: 'Online. Nothing to install.', tone: 'ok' };
  }

  function localState(engine) {
    if (!engine?.supported) return { ready: false, text: "Can't be installed on this system yet.", tone: 'warn' };
    if (engine.installing) return { ready: false, text: `Installing · ${Math.floor((engine.progress?.fraction || 0) * 100)}%` };
    if (!engine.installed) return { ready: false, text: 'Needs a one-time install. Works offline after that.' };
    if (!engine.current) return { ready: true, text: 'Installed. An update is available.', tone: 'warn' };
    return { ready: true, text: 'Installed. Works offline.', tone: 'ok' };
  }

  function renderLocal(engine, visible, running) {
    local.hidden = !visible;
    if (!visible) return;
    const installing = Boolean(engine.installing);
    progress.hidden = !installing;
    if (installing) {
      const fraction = Math.max(0, Math.min(1, engine.progress?.fraction || 0));
      const step = engine.progress ? `Step ${engine.progress.index + 1} of ${engine.progress.steps} · ${engine.progress.label}` : 'Preparing';
      progressStep.textContent = step;
      progressPercent.textContent = `${Math.floor(fraction * 100)}%`;
      progressBar.value = Math.round(fraction * 1000);
      progressDetail.textContent = engine.progress?.detail || engine.log?.at(-1) || '';
      progressDetail.title = progressDetail.textContent;
    }
    if (installing) localText.textContent = 'Installing Foul Play on this computer. You can keep using the app; the engine build is the longest step.';
    else if (engine.error) localText.textContent = `The install did not finish: ${engine.error}`;
    else if (!engine.installed) localText.textContent = 'Foul Play is not installed on this computer yet. Installing downloads Python, Foul Play and a temporary Rust compiler, then builds the search engine. It takes several minutes and uses about 150 MB of disk space when done.';
    else if (!engine.current) localText.textContent = 'A newer pinned version of Foul Play is available. Updating rebuilds it; the installed version keeps working until the update finishes.';
    else localText.textContent = `Foul Play${engine.revision ? ` (${engine.revision})` : ''} is installed on this computer.`;
    install.hidden = installing || (engine.installed && engine.current);
    install.textContent = engine.error ? 'Try again' : engine.installed ? 'Update Foul Play' : 'Install Foul Play';
    install.disabled = busy || !engine.supported;
    cancelInstall.hidden = !installing;
    removeLocal.hidden = installing || !engine.installed;
    removeLocal.disabled = busy || running;
  }

  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const value = await window.desktop.getPractice();
      const running = value.state === 'ready';
      const starting = value.state === 'starting';
      const engines = value.engines || {};
      if (!engineInitialized || running || starting) {
        setEngine(running || starting ? value.engine : engines.selected || 'cloud');
        engineInitialized = true;
      }
      if ((running || starting) && ['quiet', 'balanced', 'full'].includes(value.preset)) preset.value = value.preset;
      const engine = selectedEngine();
      const cloud = cloudState(engines.cloud);
      const localEngine = engines.local || {};
      const onDevice = localState(localEngine);
      note(cloudNote, cloud.text, cloud.tone);
      note(localNote, onDevice.text, onDevice.tone);
      for (const input of engineInputs) input.disabled = busy || starting || running;
      engineInputs.find(input => input.value === 'local').disabled ||= !localEngine.supported;
      description.textContent = value.opponents?.[0]?.description || '';
      const cap = engines.cloud?.presets?.full;
      presetHint.textContent = engine === 'cloud' && cap && cap < 8 ? `The cloud server runs up to ${cap} search thread${cap === 1 ? '' : 's'}. ${PRESET_HINT}` : PRESET_HINT;

      renderLocal(localEngine, !running && !starting && (engine === 'local' || Boolean(localEngine.installing)), running || starting);
      const engineReady = engine === 'cloud' ? cloud.ready : onDevice.ready;
      const recovery = Boolean(value.battle && (value.battle.searchFallbacks || value.battle.rejectedChoices || value.battle.defaultChoices));
      setup.hidden = running || starting;
      area.hidden = !running;
      start.disabled = busy || !value.installed || !engineReady || starting || running;
      preset.disabled = busy || starting || running;
      stop.hidden = !running && !starting;
      stop.disabled = busy && !starting;
      next.hidden = !running || !value.battle?.finished;
      next.disabled = busy;
      const where = value.engine === 'local' ? 'on this computer' : 'on the cloud server';
      let text = !value.installed ? 'Battle server unavailable' : starting ? `Starting ${NAME} ${where}…` : running ? `${NAME} ready` : value.state === 'failed' ? 'Practice failed' : 'Ready to play';
      if (running && value.clientState === 'connecting') text = 'Connecting battle client…';
      if (running && value.battle?.thinking) text = `${NAME} is thinking · turn ${value.battle.turn || 1}`;
      else if (running && value.battle?.finished) text = ({ win: 'You won', loss: `${NAME} won`, tie: 'Battle tied' })[value.battle.result] || 'Battle finished';
      else if (running && value.battle?.turn) text = `Turn ${value.battle.turn} · last search ${((value.battle.elapsedMs || 0) / 1000).toFixed(1)}s`;
      if (value.clientError) text = 'Practice client failed';
      status.textContent = text;
      status.className = `status status--${value.error || value.clientError ? 'err' : starting || recovery ? 'warn' : running ? 'ok' : 'off'}`;
      message.textContent = actionError || value.error || value.clientError ||
        (!value.installed ? 'The practice battle server is not installed in this build.' : starting ? `Preparing the battle and connecting to ${NAME} ${where}. This can take a moment.` : '');
      message.hidden = !message.textContent;
      sync();
    } catch {
      status.textContent = 'Practice status unavailable';
      start.disabled = true;
    } finally { polling = false; }
  }

  async function act(action) {
    busy = true;
    actionError = '';
    start.disabled = stop.disabled = next.disabled = install.disabled = true;
    try {
      const result = await action();
      if (!result?.ok && !result?.cancelled) actionError = result?.error || 'Practice action failed.';
    } catch {
      actionError = 'Practice action failed. Try again.';
    } finally { busy = false; await refresh(); }
  }

  for (const input of engineInputs) {
    input.addEventListener('change', () => {
      actionError = '';
      window.desktop.setSetting('practiceEngine', selectedEngine()).catch(() => {});
      refresh();
    });
  }
  start.addEventListener('click', () => act(() => window.desktop.startPractice({ opponent: 'foulplay', preset: preset.value, engine: selectedEngine() })));
  stop.addEventListener('click', () => act(() => window.desktop.stopPractice()));
  next.addEventListener('click', () => act(() => window.desktop.nextPracticeBattle()));
  install.addEventListener('click', () => act(() => window.desktop.installLocalPractice()));
  cancelInstall.addEventListener('click', () => act(() => window.desktop.cancelLocalPracticeInstall()));
  removeLocal.addEventListener('click', () => act(() => window.desktop.removeLocalPractice()));
  new ResizeObserver(sync).observe(area);
  window.addEventListener('resize', sync);
  refresh();
  setInterval(refresh, 1000);
})();
