'use strict';

// The practice battle's tab. The Bots page sets a battle up; this page shows it, and closing the
// tab (or End practice) ends the session.
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
  const subtitle = $('battle-subtitle');
  const queueActions = $('battle-queue-actions');
  const useLocal = $('battle-use-local');
  const leaveQueue = $('battle-leave-queue');
  const ordinal = n => `${n}${(n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
  let NAME = 'the bot';
  let daily = false;
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
      daily = Boolean(value.dailyChallenge);
      NAME = value.opponents?.find(bot => bot.id === value.opponent)?.name || 'the bot';
      subtitle.textContent = `vs. ${NAME} · ${({ gen9ou: 'Gen 9 OU' })[value.format] || 'Gen 9 Random Battle'}`;
      if (daily) subtitle.textContent = `Daily Bot Gauntlet Challenge · Medium · Gen 9 Random Battle`;
      const running = value.state === 'ready';
      const starting = value.state === 'starting';
      const finished = Boolean(running && value.battle?.finished);
      const clientUp = running && ['battle', 'finished'].includes(value.clientState) && !value.clientError;
      const recovery = Boolean(value.battle && (value.battle.searchFallbacks || value.battle.rejectedChoices || value.battle.defaultChoices));

      // The battle view is only shown once it has a battle open; until then a plain card says why.
      area.hidden = !clientUp;
      empty.hidden = true;
      const queue = starting ? value.queue : null;
      queueActions.hidden = !queue;
      useLocal.hidden = !(queue && value.local?.installed && !value.local.installing);
      useLocal.disabled = leaveQueue.disabled = busy;
      if (queue) {
        showEmpty('Waiting for a cloud engine', `Every cloud engine is busy, so you're in line: ${ordinal(queue.position)} of ${queue.waiting}. ` +
          `The battle starts by itself when it's your turn.${queue.position === 1 ? ' You are next.' : ''}`, false);
      } else if (value.state === 'failed' || value.clientError) {
        showEmpty('Practice stopped', value.error || value.clientError || 'The practice session failed.', true);
      } else if (starting || (running && !clientUp)) {
        showEmpty('Starting the battle', `Preparing the simulator and connecting to ${NAME}. This can take a moment.`, false);
      } else if (!running) {
        showEmpty('No battle running', 'Start a new practice battle from the Bots page.', true);
      }

      let text = 'Not running';
      if (queue) text = `In queue · ${ordinal(queue.position)} in line`;
      else if (starting) text = 'Starting…';
      else if (running && value.battle?.thinking) text = `${NAME} is thinking · turn ${value.battle.turn || 1}`;
      else if (finished) text = ({ win: 'You won', loss: `${NAME} won`, tie: 'Battle tied' })[value.battle.result] || 'Battle finished';
      else if (running && value.battle?.turn) text = `Turn ${value.battle.turn} · last search ${((value.battle.elapsedMs || 0) / 1000).toFixed(1)}s`;
      // OU opens on team preview: the battle exists, but no turn has started.
      else if (running && value.battle && value.format === 'gen9ou') text = 'Team preview';
      else if (running) text = 'Connecting…';
      else if (value.state === 'failed' || value.clientError) text = 'Practice stopped';
      status.textContent = text;
      status.className = `status status--${value.error || value.clientError ? 'err' : starting || recovery ? 'warn' : running ? 'ok' : 'off'}`;
      end.textContent = queue ? 'Leave queue' : daily ? 'End challenge' : 'End practice';

      next.hidden = !finished || (daily && !value.daily?.canStart);
      next.textContent = daily ? 'Try daily challenge again' : 'Battle again';
      next.disabled = busy;
      forfeit.hidden = !clientUp || finished;
      forfeit.disabled = busy;
      end.hidden = !running && !starting;
      end.disabled = busy;
      const dailyMessage = daily ? (!value.daily?.ok ? value.daily?.error
        : value.daily.cleared ? `Daily challenge cleared · ${value.daily.streak}-day streak. Next challenge at 00:00 UTC.`
          : value.daily.running && !value.daily.pending ? 'The daily deadline passed. This battle no longer counts toward a streak.'
            : `${value.daily.attemptsLeft} attempts remaining${finished ? '' : ' after this attempt'} · resets at 00:00 UTC. Quitting uses this attempt.`) : '';
      message.textContent = actionError || dailyMessage || '';
      message.hidden = !message.textContent;
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

  next.addEventListener('click', () => act(() => daily ? window.desktop.startDailyChallenge() : window.desktop.nextPracticeBattle()));
  forfeit.addEventListener('click', () => act(() => window.desktop.forfeitPractice()));
  // End practice closes this tab, like its close button; while queued, that leaves the queue.
  end.addEventListener('click', () => window.showdownNav?.closePracticeBattle());
  leaveQueue.addEventListener('click', () => window.showdownNav?.closePracticeBattle());
  useLocal.addEventListener('click', () => act(() => window.desktop.usePracticeLocal()));
  new ResizeObserver(sync).observe(area);
  window.addEventListener('resize', sync);
  refresh();
  setInterval(refresh, 1000);
})();
