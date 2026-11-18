'use strict';

// Launcher pages only. The Showdown client view never gets a preload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  showClient: (bounds) => ipcRenderer.send('client:show', bounds),
  hideClient: () => ipcRenderer.send('client:hide'),
  reloadClient: () => ipcRenderer.invoke('client:reload'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getPractice: () => ipcRenderer.invoke('practice:status'),
  startPractice: (preset) => ipcRenderer.invoke('practice:start', preset),
  getPracticeTeams: (format) => ipcRenderer.invoke('practice:teams', format),
  checkPracticeTeam: (format, team) => ipcRenderer.invoke('practice:check-team', { format, team }),
  stopPractice: (confirmed) => ipcRenderer.invoke('practice:stop', confirmed === true),
  forfeitPractice: () => ipcRenderer.invoke('practice:forfeit'),
  showPractice: (bounds) => ipcRenderer.invoke('practice:show', bounds),
  nextPracticeBattle: () => ipcRenderer.invoke('practice:next'),
  installLocalPractice: () => ipcRenderer.invoke('practice:install-local'),
  usePracticeLocal: () => ipcRenderer.invoke('practice:use-local'),
  cancelLocalPracticeInstall: () => ipcRenderer.invoke('practice:cancel-install'),
  removeLocalPractice: () => ipcRenderer.invoke('practice:remove-local'),
  getShowdex: () => ipcRenderer.invoke('showdex:status'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  openLogs: () => ipcRenderer.invoke('settings:open-logs'),
  signOutShowdown: () => ipcRenderer.invoke('settings:sign-out'),
  resetLauncher: () => ipcRenderer.invoke('settings:reset'),
  getTheme: () => ipcRenderer.invoke('settings:get-theme'),
  setTheme: (theme) => ipcRenderer.invoke('settings:set-theme', theme),
  getSession: () => ipcRenderer.invoke('showdown:session'),
  getShowdown: () => ipcRenderer.invoke('showdown:snapshot'),
  showdown: (action, args = {}) => ipcRenderer.invoke('showdown:action', action, args),
  getReplayNotes: () => ipcRenderer.invoke('replays:list'),
  showReplayReview: (bounds) => ipcRenderer.invoke('review:show', bounds),
  getReplayReviewStatus: () => ipcRenderer.invoke('review:status'),
  reloadReplayReview: () => ipcRenderer.invoke('review:reload'),
  exportReplayNotes: () => ipcRenderer.invoke('replays:export'),
  chooseReplayImport: () => ipcRenderer.invoke('replays:choose-import'),
  commitReplayImport: (token, choices) => ipcRenderer.invoke('replays:commit-import', token, choices),
  cancelReplayImport: (token) => ipcRenderer.invoke('replays:cancel-import', token),
  getReplayImportStatus: () => ipcRenderer.invoke('replays:import-status'),
  undoReplayImport: () => ipcRenderer.invoke('replays:undo-import'),
  saveReplayNote: (note) => ipcRenderer.invoke('replays:save', note),
  deleteReplayNote: (id) => ipcRenderer.invoke('replays:delete', id),
  openReplayNote: (id) => ipcRenderer.invoke('replays:open', id),
  getReplayDraft: () => ipcRenderer.invoke('replays:draft'),
  confirmDiscardReplayNote: () => ipcRenderer.invoke('replays:confirm-discard'),
  setReplayNoteDirty: (dirty) => ipcRenderer.send('replays:dirty', dirty),
  // Tab strip shortcuts (Ctrl+Tab, Ctrl+W, Ctrl+1–9), caught in the main process wherever
  // the focus is. See app/shortcuts.js for the shapes.
  onTabShortcut: (handler) => {
    ipcRenderer.on('nav:shortcut', (_event, shortcut) => handler(shortcut));
  },
  // The client opened or switched rooms; no data, just a cue to read the session now.
  onClientChange: (handler) => {
    ipcRenderer.on('client:changed', () => handler());
  },
});
