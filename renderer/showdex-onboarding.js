'use strict';

(() => {
  const prompt = document.getElementById('showdex-welcome');
  const welcome = document.getElementById('welcome');
  const install = document.getElementById('showdex-welcome-install');
  const skip = document.getElementById('showdex-welcome-skip');
  const status = document.getElementById('showdex-welcome-status');
  let busy = false;
  let complete = false;

  async function offer() {
    try {
      const result = await window.desktop.getSettings();
      if (result?.ok && result.settings.homeLayout && !result.settings.showdexPrompted && !welcome.open && !prompt.open) {
        prompt.showModal();
      }
    } catch { /* Settings must be readable before asking for a persistent choice. */ }
  }

  async function decline() {
    if (busy) return;
    busy = true;
    skip.disabled = install.disabled = true;
    try {
      const result = await window.desktop.setSetting('showdexPrompted', true);
      if (!result?.ok) throw new Error(result?.error || 'Your choice could not be saved. Try again.');
      prompt.close();
    } catch (error) {
      status.textContent = error.message;
      status.hidden = false;
    } finally { busy = false; skip.disabled = install.disabled = false; }
  }

  install.addEventListener('click', async () => {
    if (complete) { prompt.close(); return; }
    if (busy) return;
    busy = true;
    skip.disabled = install.disabled = true;
    install.textContent = 'Installing…';
    status.textContent = 'Installing and verifying Showdex…';
    status.hidden = false;
    try {
      const result = await window.desktop.installShowdex();
      if (!result?.ok) throw new Error(result?.error || 'Showdex could not be installed. Try again.');
      complete = true;
      status.textContent = 'Installed and enabled. Showdex will load when the Showdown client is ready.';
      install.textContent = 'Continue';
      skip.hidden = true;
    } catch (error) {
      status.textContent = error.message;
      install.textContent = 'Try again';
    } finally { busy = false; skip.disabled = install.disabled = false; }
  });
  skip.addEventListener('click', decline);
  prompt.addEventListener('cancel', event => { event.preventDefault(); if (complete) prompt.close(); else decline(); });
  welcome.addEventListener('close', offer);
  offer();
})();
