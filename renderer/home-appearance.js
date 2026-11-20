'use strict';

(() => {
const { palettes: HOME_PALETTES, backgrounds: HOME_BACKGROUNDS, defaults, valid } = window.HomeAppearanceOptions;
const media = matchMedia('(prefers-color-scheme: dark)');
const appearance = {};
let backgroundKey;
let backgroundRevision = 0;
let homeBackgroundReady = Promise.resolve();
function applyHomeBackground() {
  const key = Object.hasOwn(HOME_BACKGROUNDS, appearance.background) ? appearance.background : 'none';
  if (backgroundKey === key) return;
  backgroundKey = key;
  const revision = ++backgroundRevision;
  const root = document.documentElement;
  const credit = document.getElementById('background-credit');
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
  const p = HOME_PALETTES[appearance.palette] || HOME_PALETTES.hearth;
  const dark = appearance.appearance === 'dark';
  const [bg,paper,subtle,ink,muted,line,rail,hero,heroEnd,accent,yellow,daily,news,rooms,friends,coral] = p[dark ? 'dark' : 'light'];
  const tokens = {
    'bg-app':bg, 'bg-panel':paper, 'bg-raised':paper, 'bg-hover':subtle, 'bg-input':paper, 'bg-selected':news, 'bg-subtle':subtle, 'client-bg':bg,
    'text':ink, 'text-2':muted, 'text-3':muted, 'border':line, 'border-strong':line, 'border-hover':accent, 'accent':accent, 'on-accent':paper,
    'primary':yellow, 'primary-hover':`color-mix(in srgb, ${yellow} 82%, white)`, 'primary-active':yellow, 'on-primary':'#3c3c2d',
    'rail-bg':rail, 'rail-border':rail, 'rail-selected':`color-mix(in srgb, ${rail} 85%, #172937)`, 'rail-hover':hero,
    'rail-text':'#dfebe0', 'rail-text-strong':'#fff9ec', 'rail-muted':'#b6c8c4', 'rail-indicator':yellow,
    'strip-bg':rail, 'tab-hover':hero, 'tab-border':hero, 'topbar-bg':paper, 'topbar-border':line,
    'hero-bg':hero, 'hero-border':`color-mix(in srgb, ${hero} 65%, ${yellow})`, 'hero-text':'#fff8e9', 'hero-muted':'#fff8e9',
    'hero-input':`color-mix(in srgb, ${heroEnd} 90%, #243641)`, 'hero-input-border':`color-mix(in srgb, ${hero} 60%, #f5edcf)`, 'hero-team-bg':`color-mix(in srgb, ${hero} 82%, #e6d9ac)`,
    'home-hero-end':heroEnd, 'home-daily':daily, 'home-news':news, 'home-rooms':rooms, 'home-friends':friends, 'home-coral':coral,
    'home-highlight':dark ? '#fff6dc1c' : '#ffffff9c', 'home-shadow':dark ? '#081e2928' : '#6b573a18',
    'home-readable-muted':`color-mix(in srgb, ${muted} 20%, ${ink})`,
    'home-surface-strength':dark ? '76%' : '100%',
    'home-surface-text':dark ? ink : `color-mix(in srgb, ${ink} 92%, #000)`,
    'ok':dark ? '#a9d6ab' : '#3e7956', 'ok-bg':rooms,
  };
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


window.HomeAppearance = {
  apply,
  get ready() { return homeBackgroundReady; },
};
media.addEventListener('change', () => {
  const settings = {};
  for (const key of Object.keys(defaults)) settings[key] = appearance[key.slice(4, 5).toLowerCase() + key.slice(5)];
  apply(settings);
});
})();
