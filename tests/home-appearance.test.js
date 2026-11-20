'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const options = require('../renderer/home-appearance-options');

function fixture() {
  const images = [], timers = new Map(), properties = new Map();
  const credit = {}, root = { dataset: {}, style: {
    setProperty: (key, value) => properties.set(key, value),
    removeProperty: key => properties.delete(key),
  } };
  const media = { matches: false, addEventListener: (_name, fn) => { media.changed = fn; } };
  const context = {
    window: { HomeAppearanceOptions: options },
    document: { documentElement: root, getElementById: () => credit },
    matchMedia: () => media,
    Image: class {
      constructor() {
        this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
        images.push(this);
      }
      decode() { return this.promise; }
    },
    setTimeout: fn => { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/home-appearance.js'), 'utf8'), context);
  return { appearance: context.window.HomeAppearance, images, timers, root, credit, properties, media };
}

test('Home wallpaper loads asynchronously, ignores stale completion, and keeps credit in sync', async () => {
  const f = fixture();
  const ocean = f.appearance.apply(options.defaults);
  assert.equal(f.root.dataset.backgroundState, 'loading');
  assert.equal(f.properties.has('--home-background-image'), false);
  assert.equal(f.images[0].referrerPolicy, 'no-referrer');
  assert.equal(f.images[0].src, 'https://play.pokemonshowdown.com/fx/client-bg-ocean.jpg');
  const shaymin = f.appearance.apply({ ...options.defaults, homeBackground: 'shaymin' });
  f.images[1].resolve();
  await shaymin;
  f.images[0].resolve();
  await ocean;
  assert.equal(f.root.dataset.backgroundState, 'ready');
  assert.match(f.properties.get('--home-background-image'), /client-bg-shaymin\.jpg/);
  assert.equal(f.credit.textContent, 'Shaymin by Daniel Kong');
  assert.equal(f.timers.size, 0);
  await f.appearance.apply({ ...options.defaults, homeBackground: 'none' });
  assert.equal(f.root.dataset.backgroundState, 'plain');
  assert.equal(f.credit.hidden, true);
  assert.equal(f.properties.has('--home-background-image'), false);
});

test('failed, timed out, and superseded artwork leave the solid fallback usable', async () => {
  const f = fixture();
  const failed = f.appearance.apply(options.defaults);
  f.images[0].reject(new Error('Offline'));
  await failed;
  assert.equal(f.root.dataset.backgroundState, 'unavailable');
  assert.match(f.credit.textContent, /Showing plain color/);
  const timed = f.appearance.apply({ ...options.defaults, homeBackground: 'horizon' });
  [...f.timers.values()][0]();
  await timed;
  assert.equal(f.root.dataset.backgroundState, 'unavailable');
  f.images[1].resolve();
  await Promise.resolve();
  assert.equal(f.properties.has('--home-background-image'), false, 'late decode after timeout cannot restore artwork');
  const pending = f.appearance.apply({ ...options.defaults, homeBackground: 'psday' });
  await f.appearance.apply({ ...options.defaults, homeBackground: 'none' });
  f.images[2].resolve();
  await pending;
  assert.equal(f.root.dataset.backgroundState, 'plain');
  assert.equal(f.credit.hidden, true);
});

test('system appearance updates colors without reloading artwork or losing choices', async () => {
  const f = fixture();
  const settings = { ...options.defaults, homePalette: 'seaside', homeRadius: 14, homeBackgroundTone: 'muted' };
  const loaded = f.appearance.apply(settings);
  f.images[0].resolve();
  await loaded;
  assert.equal(f.properties.get('--bg-app'), options.palettes.seaside.light[0]);
  f.media.matches = true;
  f.media.changed();
  assert.equal(f.root.style.colorScheme, 'dark');
  assert.equal(f.properties.get('--bg-app'), options.palettes.seaside.dark[0]);
  assert.equal(f.properties.get('--home-radius'), '14px');
  assert.match(f.properties.get('--home-background-tint'), /44%/);
  assert.equal(f.images.length, 1);
  assert.equal(f.root.dataset.backgroundState, 'ready');
});
