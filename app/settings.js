'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const THEMES = new Set(['system', 'light', 'dark']);
const START_PAGES = new Set(['home', 'showdown', 'replays']);
// Keys older versions saved that mean nothing now; dropped on load so those files still open.
const RETIRED_KEYS = new Set([]);
// Where Foul Play runs: 'cloud' (the default) or 'local', once the player has downloaded it.
const PRACTICE_ENGINES = new Set(['cloud', 'local']);
// Home layouts: 'classic' (Showdown's menu, modernised) or 'modern' (the focused redesign); null
// until the player picks one in the welcome.
const HOME_LAYOUTS = new Set(['classic', 'modern']);
// Battle screen: 'launcher' (app/client-battle-room.css) or 'showdown' (Showdown's own, untouched).
const BATTLE_STYLES = new Set(['launcher', 'showdown']);
// How wide the battle column is, set by dragging the handle beside the log.
const { validWidth } = require('./battle-resize');
const homeAppearance = require('../renderer/home-appearance-options');
const DEFAULTS = Object.freeze({
  theme: 'system', startPage: 'home', confirmOnClose: true, showdexEnabled: false, showdexPrompted: false, notifyMessages: true, homeLayout: null,
  battleStyle: 'launcher', practiceEngine: 'cloud', battleWidth: 640,
  ...homeAppearance.defaults,
});
const KEYS = new Set(Object.keys(DEFAULTS));

// Values a saved file may hold. A renderer can only set a real choice (see set()).
function valid(key, value) {
  if (Object.hasOwn(homeAppearance.defaults, key)) return homeAppearance.valid(key, value);
  if (key === 'theme') return THEMES.has(value);
  if (key === 'startPage') return START_PAGES.has(value);
  if (key === 'homeLayout') return value === null || HOME_LAYOUTS.has(value);
  if (key === 'battleStyle') return BATTLE_STYLES.has(value);
  if (key === 'practiceEngine') return PRACTICE_ENGINES.has(value);
  if (key === 'battleWidth') return validWidth(value);
  if (key === 'confirmOnClose') return typeof value === 'boolean';
  if (key === 'showdexPrompted') return typeof value === 'boolean';
  if (key === 'showdexEnabled') return typeof value === 'boolean';
  if (key === 'notifyMessages') return typeof value === 'boolean';
  return false;
}

function parse(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid settings');
  const values = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (RETIRED_KEYS.has(key)) continue;
    if (!KEYS.has(key) || !valid(key, value)) throw new Error('Invalid settings');
    values[key] = value;
  }
  // A pre-existing settings file belongs to an upgrade, not a new installation.
  if (!Object.hasOwn(raw, 'showdexPrompted')) values.showdexPrompted = true;
  return values;
}

class Settings {
  constructor(dir, fileSystem = fs) {
    this.file = path.join(dir, 'settings.json');
    this.fs = fileSystem;
    this.loadError = null;
    this.values = this.load();
  }

  load() {
    let text;
    try {
      text = this.fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') this.loadError = 'Settings could not be read. Changes are disabled.';
      return { ...DEFAULTS };
    }
    try {
      return parse(text);
    } catch {
      // Keep the unreadable file for inspection instead of silently overwriting it later.
      try {
        this.fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}-${randomUUID()}`);
      } catch {
        this.loadError = 'Invalid settings could not be preserved. Changes are disabled.';
      }
      return { ...DEFAULTS };
    }
  }

  get(key) {
    return this.values[key];
  }

  snapshot() {
    return { ...this.values };
  }

  write(next) {
    if (this.loadError) throw new Error(this.loadError);
    const tmp = `${this.file}.tmp-${randomUUID()}`;
    this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      this.fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      this.fs.renameSync(tmp, this.file);
    } catch (error) {
      try { this.fs.unlinkSync(tmp); } catch {}
      throw error;
    }
    this.values = next;
  }

  set(key, value) {
    if (!KEYS.has(key) || !valid(key, value) || value === null) return false;
    this.write({ ...this.values, [key]: value });
    return true;
  }

  reset() {
    this.write({ ...DEFAULTS, showdexPrompted: this.values.showdexPrompted });
    return this.snapshot();
  }
}

module.exports = { Settings, THEMES, START_PAGES, HOME_LAYOUTS, BATTLE_STYLES, PRACTICE_ENGINES, DEFAULTS };
