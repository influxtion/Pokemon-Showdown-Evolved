'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tabShortcut } = require('../app/shortcuts');

const key = (extra = {}) => ({ type: 'keyDown', key: 'Tab', code: 'Tab', control: true, shift: false, alt: false, meta: false, ...extra });

test('Ctrl+Tab cycles forwards and Ctrl+Shift+Tab backwards', () => {
  assert.deepEqual(tabShortcut(key()), { type: 'cycle', direction: 1 });
  assert.deepEqual(tabShortcut(key({ shift: true })), { type: 'cycle', direction: -1 });
  assert.deepEqual(tabShortcut(key({ isAutoRepeat: true })), { type: 'cycle', direction: 1 });
});

test('Ctrl+W closes the open tab, once per press', () => {
  assert.deepEqual(tabShortcut(key({ key: 'w', code: 'KeyW' })), { type: 'close' });
  assert.deepEqual(tabShortcut(key({ key: 'W', code: 'KeyW' })), { type: 'close' }, 'Caps Lock');
  assert.equal(tabShortcut(key({ key: 'w', code: 'KeyW', isAutoRepeat: true })), null, 'holding the keys closes one tab');
  assert.equal(tabShortcut(key({ key: 'W', code: 'KeyW', shift: true })), null);
  assert.equal(tabShortcut(key({ key: 'w', code: 'KeyW', control: false })), null, 'typing a w');
});

test('Ctrl+1 to Ctrl+9 jump to a tab', () => {
  for (let n = 1; n <= 9; n += 1) {
    assert.deepEqual(tabShortcut(key({ key: String(n), code: `Digit${n}` })), { type: 'jump', index: n });
  }
  assert.deepEqual(tabShortcut(key({ key: '&', code: 'Digit1' })), { type: 'jump', index: 1 }, 'layouts with digits on the shifted row');
  assert.deepEqual(tabShortcut(key({ key: '4', code: '' })), { type: 'jump', index: 4 });
  assert.equal(tabShortcut(key({ key: '0', code: 'Digit0' })), null);
  assert.equal(tabShortcut(key({ key: '1', code: 'Digit1', control: false })), null, 'typing a digit');
  assert.equal(tabShortcut(key({ key: '!', code: 'Digit1', shift: true })), null);
});

test('other key presses are left alone', () => {
  assert.equal(tabShortcut(key({ control: false })), null, 'plain Tab moves focus as usual');
  assert.equal(tabShortcut(key({ control: false, shift: true })), null);
  assert.equal(tabShortcut(key({ alt: true })), null);
  assert.equal(tabShortcut(key({ key: '1', code: 'Digit1', alt: true })), null, 'AltGr combinations');
  assert.equal(tabShortcut(key({ meta: true })), null);
  assert.equal(tabShortcut(key({ type: 'keyUp' })), null);
  assert.equal(tabShortcut(key({ key: 'T', code: 'KeyT' })), null);
  assert.equal(tabShortcut(null), null);
});
