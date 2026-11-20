'use strict';

(() => {
const { backgrounds: HOME_BACKGROUNDS, defaults, valid, tokens: paletteTokens } = window.HomeAppearanceOptions;
const media = matchMedia('(prefers-color-scheme: dark)');
const appearance = {};
let backgroundKey;
let backgroundRevision = 0;
let homeBackgroundReady = Promise.resolve();
function applyHomeBackground() {
  const root = document.documentElement;
  const key = root.dataset.backgroundPolicy !== 'plain' && Object.hasOwn(HOME_BACKGROUNDS, appearance.background) ? appearance.background : 'none';
  if (backgroundKey === key) return;
  backgroundKey = key;
  const revision = ++backgroundRevision;
  let credit = document.getElementById('background-credit');
  if (!credit) {
    credit = document.createElement('span');
    credit.id = 'background-credit';
    credit.className = 'home-background-credit';
    credit.setAttribute('role', 'status');
    const bar = document.querySelector('.topbar-actions') || document.querySelector('.topbar');
    bar?.append(credit);
  }
  root.dataset.backgroundState = key === 'none' ? 'plain' : 'loading';
  root.style.removeProperty('--home-background-image');
  credit.hidden = key === 'none';
  if (key === 'none') {
    credit.textContent = '';
    homeBackgroundReady = Promise.resolve();
    return;
  }
  const { title, artist } = HOME_BACKGROUNDS[key];
  credit.textContent = `${title} by ${artist} · Loading…`;
  const image = new Image();
  image.referrerPolicy = 'no-referrer';
  const src = `https://play.pokemonshowdown.com/fx/client-bg-${key}.jpg`;
  image.src = src;
  let timer;
  homeBackgroundReady = Promise.race([
    image.decode(),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Background timeout')), 12000); }),
  ]).then(() => {
    if (revision !== backgroundRevision) return;
    root.style.setProperty('--home-background-image', `url("${src}")`);
    root.dataset.backgroundState = 'ready';
    credit.textContent = `${title} by ${artist}`;
  }, () => {
    if (revision !== backgroundRevision) return;
    root.dataset.backgroundState = 'unavailable';
    credit.textContent = `${title} unavailable · Showing plain color`;
  }).finally(() => clearTimeout(timer));
}
function apply(settings = {}, mode) {
  for (const [key, fallback] of Object.entries(defaults)) {
    const property = key.slice(4, 5).toLowerCase() + key.slice(5);
    appearance[property] = valid(key, settings[key]) ? settings[key] : fallback;
  }
  appearance.appearance = mode || (media.matches ? 'dark' : 'light');
  const dark = appearance.appearance === 'dark';
  const tokens = paletteTokens(settings, dark);
  const bg = tokens['bg-app'];
  for (const [key,value] of Object.entries(tokens)) document.documentElement.style.setProperty(`--${key}`, value);
  document.documentElement.style.colorScheme = appearance.appearance;
  document.documentElement.style.setProperty('--home-radius', `${appearance.radius}px`);
  document.documentElement.style.setProperty('--radius', `${Math.max(3, appearance.radius - 4)}px`);
  document.documentElement.dataset.homeTheme = appearance.palette;
  document.documentElement.dataset.borders = appearance.borders;
  document.documentElement.dataset.texture = String(appearance.texture);
  document.documentElement.dataset.spacing = appearance.spacing;
  document.documentElement.dataset.backgroundFit = appearance.backgroundFit === 'fit' ? 'fit' : 'fill';
  const tint = { natural: 0, soft: 12, muted: 32 }[appearance.backgroundTone] ?? 12;
  document.documentElement.style.setProperty('--home-background-tint', `color-mix(in srgb, ${bg} ${tint && dark ? tint + 12 : tint}%, transparent)`);
  applyHomeBackground();
  return homeBackgroundReady;
}


// The home* preference names are retained so existing choices carry across the app.
window.HomeAppearance = {
  apply,
  setPlainBackground(force) {
    document.documentElement.dataset.backgroundPolicy = force ? 'plain' : 'selected';
    applyHomeBackground();
  },
  get ready() { return homeBackgroundReady; },
};
media.addEventListener('change', () => {
  const settings = {};
  for (const key of Object.keys(defaults)) settings[key] = appearance[key.slice(4, 5).toLowerCase() + key.slice(5)];
  apply(settings);
});
if (window.desktop?.getSettings) {
  window.HomeAppearance.loaded = window.desktop.getSettings().then(result => {
    const settings = result?.ok ? result.settings : null;
    apply(settings || {});
    return settings;
  }, () => { apply({}); return null; });
}
})();
