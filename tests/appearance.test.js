'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AppearanceStyles, appearanceCss } = require('../app/appearance');

class Contents extends EventEmitter {
  constructor() { super(); this.inserted = []; this.removed = []; this.dead = false; }
  isDestroyed() { return this.dead; }
  async insertCSS(css, options) { assert.equal(options.cssOrigin, 'user'); const key = String(this.inserted.length); this.inserted.push({ key, css }); return key; }
  async removeInsertedCSS(key) { this.removed.push(key); }
}
test('shared client colors validate all values and restrict art to the approved host', () => {
  const css = appearanceCss({ homePalette: 'twilight', homeRadius: 14, homeBackground: 'shaymin' }, true);
  assert.match(css, /--sd-app:#e6eaf3/);
  assert.match(css, /--sd-app:#25334e/);
  assert.match(css, /--sd-radius:14px/);
  assert.match(css, /client-bg-shaymin.jpg/);
  assert.doesNotMatch(appearanceCss({ homeBackground: 'shaymin' }), /url\(/, 'isolated practice/replay views make no wallpaper requests');
  assert.doesNotMatch(appearanceCss({ homeBackground: 'none' }, true), /url\(/);
  const malicious = appearanceCss({ homePalette: 'red;} body{display:none', homeRadius: 'url(evil)', homeBackground: 'https://evil.invalid/x' }, true);
  assert.doesNotMatch(malicious, /evil|display:none/);
  assert.match(malicious, /client-bg-ocean.jpg/);
});
test('palette changes replace one sheet per view without reloading and carry into new documents', async () => {
  let settings = { homePalette: 'twilight' };
  const manager = new AppearanceStyles(() => settings), client = new Contents(), practice = new Contents();
  manager.watch(client, { wallpaper: true }); manager.watch(practice);
  await manager.refresh();
  assert.equal(client.inserted.length, 0, 'wait for the document');
  client.emit('dom-ready'); practice.emit('dom-ready');
  await manager.refresh();
  assert.equal(client.inserted.length, 1, 'identical refresh does not insert twice');
  assert.match(client.inserted[0].css, /client-bg-ocean/);
  assert.doesNotMatch(practice.inserted[0].css, /url\(/);
  settings = { homePalette: 'garden', homeRadius: 14 };
  await manager.refresh();
  assert.deepEqual(client.removed, ['0']);
  assert.match(client.inserted[1].css, /--sd-app:#e9eddd/);
  client.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  client.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  assert.equal(manager.views.get(client).ready, true, 'subframes and anchors do not invalidate the document');
  client.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); client.emit('dom-ready');
  await manager.refresh();
  assert.equal(client.inserted.length, 3);
  assert.deepEqual(client.removed, ['0'], 'old-document key is discarded');
  client.dead = true; client.emit('destroyed');
  assert.equal(manager.views.size, 1);
});
test('navigation during an asynchronous stylesheet insertion discards its stale key', async () => {
  const manager = new AppearanceStyles(() => ({})), view = new Contents();
  let finish;
  view.insertCSS = () => new Promise(resolve => { finish = resolve; });
  manager.watch(view);
  view.emit('dom-ready');
  await Promise.resolve();
  view.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  finish('stale');
  await manager.views.get(view).queue;
  assert.deepEqual(view.removed, ['stale']);
  assert.equal(manager.views.get(view).key, null);
});
