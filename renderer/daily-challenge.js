'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const button = $('daily-start');
  let latest = null;
  let busy = false;
  let polling = false;
  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const value = await window.desktop.getDailyChallenge();
      latest = value;
      if (!value?.ok) throw new Error(value?.error || 'Daily challenge unavailable.');
      $('daily-streak-text').textContent = value.streak ? `${value.streak}-day streak` : 'No active streak';
      $('daily-streak').classList.toggle('is-lit', value.streak > 0);
      $('daily-record').textContent = `Best: ${value.best} ${value.best === 1 ? 'day' : 'days'} · Daily clears: ${value.total}`;
      $('daily-status').textContent = value.clockError ? 'Check your computer’s date to continue.'
        : value.running ? 'Attempt in progress · return to your battle'
          : value.cleared ? 'Challenge cleared. Come back after the next reset.'
            : !value.attemptsLeft ? 'No attempts left today. Your next streak starts tomorrow.'
              : `${value.attemptsLeft} of 3 attempts remaining`;
      button.textContent = value.running ? 'Return to challenge' : value.cleared ? 'Cleared today' : 'Start challenge';
      button.disabled = busy || (!value.running && (!value.canStart || !value.installed || value.practiceBusy));
      if (!value.installed) $('daily-status').textContent = 'The practice battle server is not installed.';
      else if (value.practiceBusy && !value.running) $('daily-status').textContent = 'End your current practice session to play the daily challenge.';
    } catch (error) {
      button.disabled = true;
      $('daily-status').textContent = error.message || 'Daily challenge unavailable.';
    } finally { polling = false; }
  }
  button.addEventListener('click', async () => {
    if (busy) return;
    if (latest?.running) { location.href = 'practice-battle.html'; return; }
    busy = true;
    button.disabled = true;
    $('daily-error').hidden = true;
    try {
      const result = await window.desktop.startDailyChallenge();
      if (!result?.ok) throw new Error(result?.error || 'Could not start the daily challenge.');
      location.href = 'practice-battle.html';
    } catch (error) {
      $('daily-error').textContent = error.message;
      $('daily-error').hidden = false;
    } finally { busy = false; await refresh(); }
  });
  refresh();
  setInterval(refresh, 1000);
})();
