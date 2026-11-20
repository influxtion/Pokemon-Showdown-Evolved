'use strict';

// Shared by settings, launcher pages, embedded client styles, and the isolated design preview.
(() => {
// Ordered tokens: background, paper, subtle, ink, muted, line, rail, hero,
// hero end, accent, yellow, daily, news, rooms, friends, coral.
const HOME_PALETTES = {
  hearth: { name: 'Hearth', light: ['#f2e9dc','#f7faf7','#edf3ef','#36464a','#65716b','#bdcbd0','#344e57','#41697a','#304e60','#376b7c','#f1ca70','#f3e3c5','#d7e7f1','#d8e8e0','#efdfcd','#b77d56'], dark: ['#263b43','#314958','#2c414e','#f5eee1','#c3ccbe','#627d89','#253b46','#3c6275','#2d4c60','#a8d4e2','#edc777','#5d503e','#405e74','#405f58','#655344','#c8946d'] },
  garden: { name: 'Garden', light: ['#e9eddd','#fcfbef','#f0f1df','#374c3d','#667461','#b9c7ac','#3d5a48','#557459','#3f6251','#477653','#e7c96f','#f2e3b8','#dce6c9','#d3e3d3','#f0dfcc','#ad7553'], dark: ['#293d35','#354d40','#304639','#eff1dc','#c1ccb6','#627d61','#263d33','#496650','#345441','#b6d99f','#dfc678','#58533a','#4a5f43','#3d5e4d','#5c5144','#c08b63'] },
  seaside: { name: 'Seaside', light: ['#e7efea','#f9fcf5','#edf4e9','#294c53','#57777b','#acc9c7','#2a5863','#397b80','#316574','#23788a','#f2d27d','#f7e1c3','#d7e8ec','#dcebd9','#f3ddd6','#c37d62'], dark: ['#203c49','#2c4e59','#264752','#eaf4e8','#b2d0ce','#56818a','#1c3546','#326d78','#285568','#8fdae0','#efcd7c','#63513d','#3b6274','#3f6559','#684f4d','#d1946e'] },
  rosewood: { name: 'Rosewood', light: ['#f1e4dc','#fff9f1','#f6eae3','#513f3b','#7b635a','#cdb1a4','#694b47','#8d6256','#754e4d','#8a5347','#efcd86','#f4dfbd','#e8d4c8','#dfe6d1','#f0d3ca','#a9634d'], dark: ['#422f33','#553e40','#4c3638','#f8eadd','#d6bbaf','#8d6c63','#352b33','#7b5150','#603e45','#edb89e','#e8c487','#66523c','#68504c','#505c47','#704c4b','#cb8a65'] },
  amber: { name: 'Amber', light: ['#f3ead6','#fffbee','#f7efd9','#4c4834','#777057','#cbbd93','#565a43','#71764e','#535e43','#627747','#efc264','#f2dda4','#e9e4c5','#dde7c8','#f0dec4','#b97543'], dark: ['#353d35','#465044','#3b463c','#f5efda','#c8cdb4','#7b8565','#2e3b34','#616d4c','#485b44','#c4d79a','#edc66c','#62583b','#555e44','#485f48','#635842','#cb9257'] },
  twilight: { name: 'Twilight', light: ['#e6eaf3','#f8f9ff','#eef1f8','#35445b','#63718a','#b8c5d9','#334965','#47658a','#3b5376','#436e9f','#eac97d','#f1dfc4','#dce6f3','#dce8e2','#eadce2','#b67966'], dark: ['#25334e','#30415c','#2a3b54','#edf1f7','#becbe0','#596e8e','#202f49','#3e5b7d','#304865','#a8cbef','#eaca7e','#5a4d45','#3d5675','#3e5a5b','#584a5e','#c48e75'] },
};

// Artist credits follow the classic Showdown client's Storage.bg catalog.
const HOME_BACKGROUNDS = {
  ocean: { title: 'Sunrise Ocean', artist: 'Quanyails' },
  horizon: { title: 'Horizon', artist: 'Vivian Zou' },
  shaymin: { title: 'Shaymin', artist: 'Daniel Kong' },
  charizards: { title: 'Charizards', artist: 'Jessica Valencia' },
  psday: { title: 'Showdown Day', artist: 'LifeisDANK' },
};

const DEFAULTS = Object.freeze({
  homePalette: 'twilight', homeBorders: 'inset', homeRadius: 10, homeTexture: true,
  homeSpacing: 'relaxed', homeBackground: 'ocean', homeBackgroundTone: 'soft', homeBackgroundFit: 'fill',
});
const CHOICES = Object.freeze({
  homePalette: Object.keys(HOME_PALETTES),
  homeBorders: ['fine', 'inset', 'double', 'stitched'],
  homeRadius: [6, 10, 14],
  homeTexture: [true, false],
  homeSpacing: ['current', 'relaxed', 'airy'],
  homeBackground: ['none', ...Object.keys(HOME_BACKGROUNDS)],
  homeBackgroundTone: ['natural', 'soft', 'muted'],
  homeBackgroundFit: ['fill', 'fit'],
});
function valid(key, value) {
  return Object.hasOwn(CHOICES, key) && CHOICES[key].includes(value);
}
function tokens(settings = {}, dark = false) {
  const p = HOME_PALETTES[valid('homePalette', settings.homePalette) ? settings.homePalette : DEFAULTS.homePalette];
  const [bg,paper,subtle,ink,muted,line,rail,hero,heroEnd,accent,yellow,daily,news,rooms,friends,coral] = p[dark ? 'dark' : 'light'];
  const tokens = {
    'bg-app':bg, 'bg-panel':paper, 'bg-raised':paper, 'bg-hover':subtle, 'bg-input':paper, 'bg-selected':news, 'bg-subtle':subtle, 'client-bg':bg,
    'text':ink, 'text-2':muted, 'text-3':muted, 'border':line, 'border-strong':line, 'border-hover':accent, 'accent':accent, 'on-accent':dark ? bg : paper,
    'primary':yellow, 'primary-hover':`color-mix(in srgb, ${yellow} 82%, white)`, 'primary-active':yellow, 'on-primary':'#3c3c2d',
    'rail-bg':rail, 'rail-border':rail, 'rail-selected':`color-mix(in srgb, ${rail} 85%, #172937)`, 'rail-hover':hero,
    'rail-text':'#dfebe0', 'rail-text-strong':'#fff9ec', 'rail-muted':'#b6c8c4', 'rail-indicator':yellow,
    'strip-bg':rail, 'tab-hover':hero, 'tab-border':hero, 'topbar-bg':paper, 'topbar-border':line,
    'hero-bg':hero, 'hero-border':`color-mix(in srgb, ${hero} 65%, ${yellow})`, 'hero-text':'#fff8e9', 'hero-muted':'#fff8e9',
    'hero-input':`color-mix(in srgb, ${heroEnd} 90%, #243641)`, 'hero-input-border':`color-mix(in srgb, ${hero} 60%, #f5edcf)`, 'hero-team-bg':`color-mix(in srgb, ${hero} 82%, #e6d9ac)`,
    'home-hero-end':heroEnd, 'home-daily':daily, 'home-news':news, 'home-rooms':rooms, 'home-friends':friends, 'home-coral':coral,
    'daily-surface':dark ? '#36466c' : '#e7ebff', 'daily-accent':dark ? '#b9b1ff' : '#5b50ad',
    'daily-on-accent':dark ? '#252343' : '#ffffff', 'daily-flame':dark ? '#a9daff' : '#3c4ba3',
    'home-highlight':dark ? '#fff6dc1c' : '#ffffff9c', 'home-shadow':dark ? '#081e2928' : '#6b573a18',
    'home-readable-muted':`color-mix(in srgb, ${muted} 20%, ${ink})`,
    'home-surface-strength':dark ? '76%' : '100%',
    'home-surface-text':dark ? ink : `color-mix(in srgb, ${ink} 92%, #000)`,
    'ok':dark ? '#a9d6ab' : '#3e7956', 'ok-bg':rooms,
  };
  return tokens;
}

const options = { tokens, palettes: HOME_PALETTES, backgrounds: HOME_BACKGROUNDS, defaults: DEFAULTS, choices: CHOICES, valid };
if (typeof module !== 'undefined' && module.exports) module.exports = options;
else window.HomeAppearanceOptions = options;
})();
