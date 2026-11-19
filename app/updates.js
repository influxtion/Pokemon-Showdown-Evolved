'use strict';

const { EventEmitter } = require('node:events');

const RELEASES_URL = 'https://github.com/influxtion/Pokemon-Showdown-Launcher-App/releases';

// Unknown state blocks installation, including a disconnected client and delayed player names.
function restartBlocker({ session, dirty, busy, practice }) {
  if (dirty) return 'Save or discard your unsaved replay note before updating.';
  if (busy) return 'Wait for the current operation to finish before updating.';
  if (practice && ['starting', 'ready'].includes(practice.state) && !practice.battle?.finished) {
    return 'Finish or leave your practice battle before updating.';
  }
  if (!session?.ready || !session.connected || !Array.isArray(session.rooms) || !session.search) {
    return 'Reconnect to Showdown so the app can check for active battles before updating.';
  }
  if (session.rooms.some(room => (room.battle || room.id?.startsWith('battle-')) && !room.ended)) {
    return 'Finish or close your open battles before updating.';
  }
  if (session.search.pending || session.search.formats?.length || session.messages?.some(m => m.challenge)) {
    return 'Cancel your search or resolve pending challenges before updating.';
  }
  return '';
}

class Updates extends EventEmitter {
  constructor({ updater, version, mode = 'automatic', checkSafe, confirm, install }) {
    super();
    this.updater = updater;
    this.checkSafe = checkSafe;
    this.confirm = confirm;
    this.install = install;
    this.mode = mode;
    this.state = { currentVersion: version, phase: mode === 'automatic' ? 'idle' : mode, version: '', percent: 0, message: '' };
    this.working = false;
    this.restarting = false;
    if (!updater) return;
    updater.autoDownload = false;
    // Never attach an install-on-quit hook, even after downloading successfully.
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = true; // This app currently follows the public preview releases.
    updater.disableWebInstaller = true;
    updater.logger = null;
    updater.on('download-progress', progress => this.set({ phase: 'downloading', percent: Math.max(0, Math.min(100, Math.round(progress.percent || 0))) }));
    updater.on('update-downloaded', () => this.set({ phase: 'ready', percent: 100, message: 'Update downloaded. Restart when you are ready.' }));
    updater.on('error', () => this.set({ phase: 'error', message: 'The update could not finish. Your current app is unchanged. Try again later.' }));
  }

  status() { return { ...this.state, mode: this.mode, restarting: this.restarting }; }
  set(values) { Object.assign(this.state, values); this.emit('change', this.status()); }

  start() {
    if (this.mode !== 'automatic') return;
    this.initial = setTimeout(() => this.check(), 30000);
    this.interval = setInterval(() => this.check(), 6 * 60 * 60 * 1000);
    this.initial.unref?.();
    this.interval.unref?.();
  }
  dispose() { clearTimeout(this.initial); clearInterval(this.interval); }

  async check() {
    if (this.mode !== 'automatic' || this.working || this.restarting || this.state.phase === 'ready') return this.status();
    this.working = true;
    this.set({ phase: 'checking', message: 'Checking for updates…', percent: 0 });
    try {
      const result = await this.updater.checkForUpdates();
      // electron-updater performs the semver and downgrade checks. It returns a token only for an available update.
      if (!result?.cancellationToken) {
        this.set({ phase: 'current', message: 'You are up to date.' });
      } else {
        this.set({ phase: 'downloading', version: String(result.updateInfo.version).slice(0, 64), message: 'Downloading update…' });
        await this.updater.downloadUpdate(result.cancellationToken);
      }
    } catch {
      this.set({ phase: 'error', message: 'Updates are unavailable right now. You can keep playing and try again later.' });
    } finally { this.working = false; }
    return this.status();
  }

  async restart() {
    if (this.restarting || this.state.phase !== 'ready') return { ok: false, error: 'No downloaded update is ready to install.' };
    this.restarting = true;
    try {
      let reason = await this.checkSafe();
      if (reason) return { ok: false, error: reason };
      if (!await this.confirm()) return { ok: true, cancelled: true };
      reason = await this.checkSafe(); // State can change while the confirmation is open.
      if (reason) return { ok: false, error: reason };
      this.install();
      return { ok: this.state.phase !== 'error', error: this.state.phase === 'error' ? this.state.message : undefined };
    } catch {
      return { ok: false, error: 'Could not safely restart. Keep the app open and try again.' };
    } finally { this.restarting = false; }
  }
}

module.exports = { Updates, restartBlocker, RELEASES_URL };
