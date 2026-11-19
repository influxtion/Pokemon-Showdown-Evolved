'use strict';

const controls = {
  theme: document.getElementById('theme'),
  homeLayout: document.getElementById('home-layout'),
  battleStyle: document.getElementById('battle-style'),
  startPage: document.getElementById('start-page'),
  confirmOnClose: document.getElementById('confirm-on-close'),
  notifyMessages: document.getElementById('notify-messages'),
};
const status = document.getElementById('settings-status');
let saved = null;

function message(text) {
  status.textContent = text;
  status.hidden = !text;
}

function show(values) {
  saved = values;
  controls.theme.value = values.theme;
  controls.homeLayout.value = values.homeLayout || '';
  controls.battleStyle.value = values.battleStyle;
  controls.startPage.value = values.startPage;
  controls.confirmOnClose.checked = values.confirmOnClose;
  controls.notifyMessages.checked = values.notifyMessages;
}

function disableSettings(disabled) {
  for (const control of Object.values(controls)) control.disabled = disabled;
}

async function load() {
  disableSettings(true);
  try {
    const result = await window.desktop.getSettings();
    if (!result?.ok || !result.settings) throw new Error(result?.error || 'Settings could not be loaded.');
    show(result.settings);
    disableSettings(false);
    message('');
    return true;
  } catch (error) {
    message(error.message || 'Settings could not be loaded.');
    return false;
  }
}

async function save(key, value) {
  if (!saved) return;
  disableSettings(true);
  try {
    const result = await window.desktop.setSetting(key, value);
    if (!result?.ok || !result.settings) throw new Error(result?.error || 'Setting could not be saved.');
    show(result.settings);
    message('Saved.');
  } catch (error) {
    show(saved);
    message(error.message || 'Setting could not be saved.');
  } finally {
    disableSettings(false);
  }
}

controls.theme.addEventListener('change', () => save('theme', controls.theme.value));
controls.homeLayout.addEventListener('change', () => save('homeLayout', controls.homeLayout.value));
controls.battleStyle.addEventListener('change', () => save('battleStyle', controls.battleStyle.value));
controls.startPage.addEventListener('change', () => save('startPage', controls.startPage.value));
controls.confirmOnClose.addEventListener('change', () => save('confirmOnClose', controls.confirmOnClose.checked));
controls.notifyMessages.addEventListener('change', () => save('notifyMessages', controls.notifyMessages.checked));

async function runAction(buttonId, method, success) {
  const button = document.getElementById(buttonId);
  button.addEventListener('click', async () => {
    button.disabled = true;
    message('Working…');
    try {
      const result = await window.desktop[method]();
      if (result?.cancelled) {
        message('Cancelled.');
      } else {
        if (!result?.ok) throw new Error(result?.error || 'Action failed.');
        if (method === 'resetLauncher' && !await load()) return;
        message(success);
      }
    } catch (error) {
      message(error.message || 'Action failed.');
    } finally {
      button.disabled = false;
    }
  });
}

runAction('reload-client', 'reloadClient', 'Client reload requested.');
runAction('open-logs', 'openLogs', 'Logs folder opened.');
runAction('sign-out', 'signOutShowdown', 'Showdown data cleared.');
runAction('reset-launcher', 'resetLauncher', 'Launcher data reset.');
load();

const updateCheck = document.getElementById('update-check');
const updateRestart = document.getElementById('update-restart');
const updateReleases = document.getElementById('update-releases');
const updateError = document.getElementById('update-error');
function showUpdate(state) {
  if (!state) return;
  document.getElementById('update-version').textContent = `Pokemon Showdown Evolved ${state.currentVersion}`;
  document.getElementById('update-status').textContent = state.mode === 'manual'
    ? 'Install updates from the Downloads page for this build.' : state.mode === 'development'
      ? 'Automatic updates are available in installed Windows and Linux AppImage builds.'
      : state.phase === 'downloading' ? `Downloading ${state.version}: ${state.percent}%`
        : state.message || 'Checks automatically after startup and every six hours. Includes preview releases.';
  updateCheck.hidden = state.mode !== 'automatic';
  updateCheck.disabled = ['checking', 'downloading', 'ready'].includes(state.phase) || state.restarting;
  updateRestart.hidden = state.phase !== 'ready';
  updateReleases.hidden = state.mode === 'automatic' && state.phase !== 'error';
}
window.desktop.onUpdateChange(showUpdate);
window.desktop.getUpdates().then(showUpdate).catch(() => {});
updateCheck.addEventListener('click', () => {
  updateError.hidden = true;
  window.desktop.checkUpdates().then(showUpdate).catch(() => {});
});
updateReleases.addEventListener('click', () => window.desktop.openReleases());
updateRestart.addEventListener('click', async () => {
  updateRestart.disabled = true;
  updateError.hidden = true;
  try {
    const result = await window.desktop.restartForUpdate();
    if (!result?.ok) throw new Error(result?.error || 'Could not safely restart. Try again.');
  } catch (error) {
    updateError.textContent = error.message;
    updateError.hidden = false;
  } finally { updateRestart.disabled = false; }
});
