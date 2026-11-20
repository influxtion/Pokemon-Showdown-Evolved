'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const compact = Boolean(document.querySelector('.daily-compact'));
  let latest = null;
  let busy = false;
  let polling = false;
  function updateButtons() {
    const value = latest;
    for (const button of document.querySelectorAll('#daily-start, [data-daily-start]')) {
      const shortcut = button.hasAttribute('data-daily-start');
      button.textContent = value?.running ? (shortcut ? 'Return to daily' : compact ? 'Return' : 'Return to challenge')
        : value?.cleared ? 'Cleared today' : compact || shortcut ? 'Play daily' : 'Start challenge';
      button.disabled = busy || !value?.ok || (!value.running && (!value.canStart || !value.installed || value.practiceBusy));
      if (shortcut) button.title = $('daily-status').textContent;
    }
  }
  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const value = await window.desktop.getDailyChallenge();
      latest = value;
      if (!value?.ok) throw new Error(value?.error || 'Daily challenge unavailable.');
      $('daily-streak-text').textContent = value.streak ? `${value.streak}-day streak` : compact ? 'Start a streak' : 'No active streak';
      $('daily-streak').classList.toggle('is-lit', value.streak > 0);
      if ($('daily-record')) $('daily-record').textContent = `Best: ${value.best} ${value.best === 1 ? 'day' : 'days'} · Daily clears: ${value.total}`;
      $('daily-status').textContent = value.clockError ? 'Check your computer’s date to continue.'
        : value.running ? 'Attempt in progress'
          : value.cleared ? compact ? 'Cleared today · resets 00:00 UTC' : 'Challenge cleared. Come back after the next reset.'
            : !value.attemptsLeft ? compact ? 'No attempts left · resets 00:00 UTC' : 'No attempts left today. Your next streak starts tomorrow.'
              : `${value.attemptsLeft} of 3 attempts remaining`;
      if (!value.installed) $('daily-status').textContent = 'The practice battle server is not installed.';
      else if (value.practiceBusy && !value.running) $('daily-status').textContent = 'End your current practice session to play the daily challenge.';
    } catch (error) {
      latest = null;
      $('daily-status').textContent = error.message || 'Daily challenge unavailable.';
    } finally { polling = false; updateButtons(); }
  }
  document.addEventListener('practice-cards-updated', updateButtons);
  document.addEventListener('click', async event => {
    const button = event.target.closest?.('#daily-start, [data-daily-start]');
    if (!button || button.disabled || busy) return;
    if (latest?.running) { location.href = 'practice-battle.html'; return; }
    busy = true;
    updateButtons();
    $('daily-error').hidden = true;
    try {
      const result = await window.desktop.startDailyChallenge();
      if (!result?.ok) throw new Error(result?.error || 'Could not start the daily challenge.');
      location.href = 'practice-battle.html';
    } catch (error) {
      $('daily-error').textContent = error.message;
      $('daily-error').hidden = false;
      if (button.hasAttribute('data-daily-start')) $('daily-error').scrollIntoView({ block: 'nearest' });
    } finally { busy = false; await refresh(); }
  });
  refresh();
  setInterval(refresh, 1000);
})();
