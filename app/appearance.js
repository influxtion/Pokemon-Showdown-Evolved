'use strict';
const fs = require('node:fs');
const path = require('node:path');
const appearance = require('../renderer/home-appearance-options');
const chrome = fs.readFileSync(path.join(__dirname, 'client-appearance.css'), 'utf8');

function appearanceCss(settings = {}, wallpaper = false) {
  const choice = key => appearance.valid(key, settings[key]) ? settings[key] : appearance.defaults[key];
  const art = wallpaper && choice('homeBackground') !== 'none'
    ? 'url("https://play.pokemonshowdown.com/fx/client-bg-' + choice('homeBackground') + '.jpg")' : 'none';
  function theme(dark) {
    const t = appearance.tokens(settings, dark);
    const tint = { natural: 0, soft: 12, muted: 32 }[choice('homeBackgroundTone')];
    const shade = dark ? '76%' : '100%';
    const vars = {
      'app': t['bg-app'], 'panel': t['bg-panel'], 'subtle': t['bg-subtle'], 'hover': t['bg-hover'], 'input': t['bg-input'],
      'border': t.border, 'border-strong': t['border-strong'], 'text': t.text, 'text-2': t['home-readable-muted'],
      'accent': t.accent, 'bar': t['rail-bg'], 'bar-hover': t['rail-hover'], 'bar-tab': t['rail-selected'],
      'primary': t.primary, 'primary-hover': t['primary-hover'], 'on-primary': t['on-primary'],
      'news': t['home-news'], 'rooms': t['home-rooms'], 'friends': t['home-friends'], 'daily': t['home-daily'],
      'radius': choice('homeRadius') + 'px', 'control-radius': Math.max(3, choice('homeRadius') - 4) + 'px',
      'gap': { current: 16, relaxed: 24, airy: 32 }[choice('homeSpacing')] + 'px',
      'card': art === 'none' ? t['bg-panel'] : 'color-mix(in srgb, color-mix(in srgb, ' + t['bg-panel'] + ' ' + shade + ', #000) 80%, transparent)',
      'edge': choice('homeBorders') === 'stitched' ? 'dashed' : 'solid',
      'card-outline': choice('homeBorders') === 'double' ? '1px solid ' + t.border : '0',
      'card-shadow': choice('homeBorders') === 'fine' ? 'none' : '0 2px 0 ' + t['home-shadow'] + ', inset 0 1px ' + t['home-highlight'],
      'wallpaper': art !== 'none' || !choice('homeTexture') ? art
        : 'repeating-linear-gradient(0deg, transparent 0 3px, color-mix(in srgb, ' + t.text + ' 2%, transparent) 3px 4px)',
      'wallpaper-tint': 'color-mix(in srgb, ' + t['bg-app'] + ' ' + (tint && dark ? tint + 12 : tint) + '%, transparent)',
      'wallpaper-fit': choice('homeBackgroundFit') === 'fit' ? 'contain' : 'cover',
    };
    return ':root { ' + Object.entries(vars).map(([key, value]) => '--sd-' + key + ':' + value + ' !important;').join('') + ' }';
  }
  return theme(false) + '\n@media (prefers-color-scheme: dark) {' + theme(true) + '}\n' + chrome;
}

// Only explicitly registered client/practice/replay views receive these styles, never OAuth.
// Each view replaces its one sheet without a reload. A new document invalidates pending keys.
class AppearanceStyles {
  constructor(readSettings) { this.readSettings = readSettings; this.views = new Map(); }
  watch(contents, { wallpaper = false } = {}) {
    if (this.views.has(contents)) return;
    const state = { wallpaper, key: null, epoch: 0, ready: false, css: '', queue: Promise.resolve() };
    this.views.set(contents, state);
    contents.on('did-start-navigation', event => {
      if (!event.isMainFrame || event.isSameDocument) return;
      state.ready = false; state.epoch++; state.key = null; state.css = '';
    });
    contents.on('dom-ready', () => { state.ready = true; this.update(contents, state); });
    contents.once('destroyed', () => { state.epoch++; this.views.delete(contents); });
  }
  update(contents, state) {
    const css = appearanceCss(this.readSettings(), state.wallpaper), epoch = state.epoch;
    state.queue = state.queue.then(async () => {
      if (!state.ready || contents.isDestroyed() || state.epoch !== epoch || state.css === css) return;
      const previous = state.key;
      const key = await contents.insertCSS(css, { cssOrigin: 'user' });
      if (contents.isDestroyed()) return;
      if (state.epoch !== epoch) { await contents.removeInsertedCSS(key); return; }
      state.key = key;
      state.css = css;
      if (previous) await contents.removeInsertedCSS(previous);
    }).catch(() => {});
    return state.queue;
  }
  refresh() { return Promise.all([...this.views].map(([contents, state]) => this.update(contents, state))); }
}
module.exports = { AppearanceStyles, appearanceCss };
