'use strict';

// The practice battle's own tab. The Practice page only sets a battle up; this page shows the
// battle client while a session runs, and closing its tab (or End practice) ends the session.
(() => {
  const $ = id => document.getElementById(id);
  const status = $('battle-status');
  const area = $('battle-area');
  const next = $('battle-next');
  const end = $('battle-end');
  const forfeit = $('battle-forfeit');
  const message = $('battle-message');
  const empty = $('battle-empty');
  const emptyTitle = $('battle-empty-title');
  const emptyText = $('battle-empty-text');
  const back = $('battle-back');
  const NAME = 'Foul Play';
  let busy = false;
  let polling = false;
  let actionError = '';

  function sync() {
    if (area.hidden) return;
    const bounds = area.getBoundingClientRect();
    window.desktop.showPractice({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  }

  function showEmpty(title, text, canLeave) {
    emptyTitle.textContent = title;
    emptyText.textContent = text;
    back.hidden = !canLeave;
    empty.hidden = false;
  }

  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const value = await window.desktop.getPractice();
      const running = value.state === 'ready';
      const starting = value.state === 'starting';
      const finished = Boolean(running && value.battle?.finished);
      const clientUp = running && ['battle', 'finished'].includes(value.clientState) && !value.clientError;
      const recovery = Boolean(value.battle && (value.battle.searchFallbacks || value.battle.rejectedChoices || value.battle.defaultChoices));

      // The battle view is only shown once it has a battle open; until then a plain card says why.
      area.hidden = !clientUp;
      empty.hidden = true;
      if (value.state === 'failed' || value.clientError) {
        showEmpty('Practice stopped', value.error || value.clientError || 'The practice session failed.', true);
      } else if (starting || (running && !clientUp)) {
        showEmpty('Starting the battle', `Preparing the simulator and connecting to ${NAME}. This can take a moment.`, false);
      } else if (!running) {
        showEmpty('No battle running', 'Start a new practice battle from the Practice page.', true);
      }

      let text = 'Not running';
      if (starting) text = 'Starting…';
      else if (running && value.battle?.thinking) text = `${NAME} is thinking · turn ${value.battle.turn || 1}`;
      else if (finished) text = ({ win: 'You won', loss: `${NAME} won`, tie: 'Battle tied' })[value.battle.result] || 'Battle finished';
      else if (running && value.battle?.turn) text = `Turn ${value.battle.turn} · last search ${((value.battle.elapsedMs || 0) / 1000).toFixed(1)}s`;
      else if (running) text = 'Connecting…';
      else if (value.state === 'failed' || value.clientError) text = 'Practice stopped';
      status.textContent = text;
      status.className = `status status--${value.error || value.clientError ? 'err' : starting || recovery ? 'warn' : running ? 'ok' : 'off'}`;

      next.hidden = !finished;
      next.disabled = busy;
      forfeit.hidden = !clientUp || finished;
      forfeit.disabled = busy;
      end.hidden = !running && !starting;
      end.disabled = busy;
      message.textContent = actionError;
      message.hidden = !actionError;
      sync();
    } catch {
      status.textContent = 'Practice status unavailable';
    } finally { polling = false; }
  }

  async function act(action) {
    busy = true;
    actionError = '';
    next.disabled = end.disabled = forfeit.disabled = true;
    try {
      const result = await action();
      if (!result?.ok && !result?.cancelled) actionError = result?.error || 'Practice action failed.';
      return result;
    } catch {
      actionError = 'Practice action failed. Try again.';
      return null;
    } finally { busy = false; await refresh(); }
  }

  next.addEventListener('click', () => act(() => window.desktop.nextPracticeBattle()));
  forfeit.addEventListener('click', () => act(() => window.desktop.forfeitPractice()));
  // Ending practice closes this tab, the same as its close button.
  end.addEventListener('click', () => window.showdownNav?.closePracticeBattle());
  new ResizeObserver(sync).observe(area);
  window.addEventListener('resize', sync);
  refresh();
  setInterval(refresh, 1000);
})();
