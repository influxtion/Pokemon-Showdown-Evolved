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

// Populate from the same allowlists the main process validates. No custom URLs or CSS.
const homeOptions = window.HomeAppearanceOptions;
const homeLabels = {
  homePalette: ['Palette', Object.values(homeOptions.palettes).map(p => p.name)],
  homeBackground: ['Background', ['Plain color', ...Object.values(homeOptions.backgrounds).map(b => b.title)]],
  homeBackgroundTone: ['Artwork tint', ['Natural', 'Soft', 'Muted']],
  homeBackgroundFit: ['Image framing', ['Fill screen', 'Show whole image']],
  homeBorders: ['Borders', ['Fine outline', 'Soft inset', 'Double frame', 'Stitched edge']],
  homeRadius: ['Corners', ['Slight', 'Soft', 'Round']],
  homeSpacing: ['Spacing', ['Compact', 'Relaxed', 'Airy']],
  homeTexture: ['Plain background texture', ['Subtle', 'None']],
};
for (const [key, [label, labels]] of Object.entries(homeLabels)) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  const text = document.createElement('label');
  text.className = 'setting-text';
  text.htmlFor = key;
  text.textContent = label;
  const holder = document.createElement('div');
  holder.className = 'setting-control';
  const select = document.createElement('select');
  select.className = 'select';
  select.id = key;
  homeOptions.choices[key].forEach((value, i) => select.add(new Option(labels[i], String(value))));
  controls[key] = select;
  select.addEventListener('change', () => save(key, homeOptions.choices[key][select.selectedIndex]));
  holder.append(select);
  row.append(text, holder);
  document.getElementById('home-appearance-controls').append(row);
}

function message(text) {
  status.textContent = text;
  status.hidden = !text;
}

function show(values) {
  saved = values;
  window.HomeAppearance.apply(values);
  controls.theme.value = values.theme;
  controls.homeLayout.value = values.homeLayout || '';
  controls.battleStyle.value = values.battleStyle;
  controls.startPage.value = values.startPage;
  controls.confirmOnClose.checked = values.confirmOnClose;
  controls.notifyMessages.checked = values.notifyMessages;
  for (const key of Object.keys(homeLabels)) controls[key].value = String(values[key]);
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
document.getElementById('open-profile').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    if (!await window.desktop.showdown('profile', {})) throw new Error('Profile is unavailable. Wait for Showdown to connect, then try again.');
    location.href = 'play.html';
  } catch (error) {
    message(error.message || 'Profile could not be opened.');
  } finally { button.disabled = false; }
});
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
