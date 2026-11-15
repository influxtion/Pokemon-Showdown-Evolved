'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tabCycle } = require('../app/shortcuts');

const key = (extra = {}) => ({ type: 'keyDown', key: 'Tab', control: true, shift: false, alt: false, meta: false, ...extra });

test('Ctrl+Tab cycles forwards and Ctrl+Shift+Tab backwards', () => {
  assert.equal(tabCycle(key()), 1);
  assert.equal(tabCycle(key({ shift: true })), -1);
  assert.equal(tabCycle(key({ isAutoRepeat: true })), 1);
});

test('other key presses are left alone', () => {
  assert.equal(tabCycle(key({ control: false })), 0, 'plain Tab moves focus as usual');
  assert.equal(tabCycle(key({ control: false, shift: true })), 0);
  assert.equal(tabCycle(key({ alt: true })), 0);
  assert.equal(tabCycle(key({ meta: true })), 0);
  assert.equal(tabCycle(key({ type: 'keyUp' })), 0);
  assert.equal(tabCycle(key({ key: 'T' })), 0);
  assert.equal(tabCycle(null), 0);
});
