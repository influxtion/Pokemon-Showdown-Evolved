'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../renderer/battle-review-request.js'), 'utf8');

test('postgame offer tracks observed games, dismisses once and re-arms for a rematch', () => {
  const cache = new Map();
  const sessionStorage = { getItem: key => cache.get(key), setItem: (key, value) => cache.set(key, value) };
  const elements = new Map();
  for (const id of ['review-offer', 'offer-open', 'offer-dismiss']) {
    elements.set(id, { hidden: true, addEventListener(_type, handler) { this.click = handler; } });
  }
  const window = { addEventListener() {} };
  const document = { getElementById: id => elements.get(id) };
  vm.runInNewContext(script, { window, document, sessionStorage });
  const panel = document.getElementById('review-offer');
  const fallback = { hidden: true };
  let clicks = 0;
  const open = { click() { clicks++; }, focus() {} };
  let offer = new window.BattleReviewOffer('practice', fallback, open);
  offer.update('battle-gen9ou-1', true);
  assert.equal(panel.hidden, true, 'historical finish');
  assert.equal(fallback.hidden, false);
  offer.update('battle-gen9ou-2', false);
  offer.update('battle-gen9ou-2', true);
  assert.equal(panel.hidden, false);
  document.getElementById('offer-dismiss').click();
  offer.update('battle-gen9ou-2', true);
  assert.equal(panel.hidden, true);
  assert.equal(clicks, 0);
  offer = new window.BattleReviewOffer('practice', fallback, open);
  offer.update('battle-gen9ou-2', true);
  assert.equal(panel.hidden, true, 'returning preserves dismissal');
  // A restarted local simulator can reuse a room number.
  offer.update('battle-gen9ou-2', false);
  offer.update('battle-gen9ou-2', true);
  assert.equal(panel.hidden, false);
  document.getElementById('offer-open').click();
  assert.equal(clicks, 1);
  assert.equal(panel.hidden, true);
  offer.update('battle-gen9ou-3-secretpw', false);
  offer.update('battle-gen9ou-3-secretpw', true, false);
  assert.equal(panel.hidden, true, 'another live battle takes priority');
  offer.update('battle-gen9ou-3-secretpw', true);
  assert.equal(panel.hidden, true);
  assert.doesNotMatch([...cache.values()].join(''), /secretpw/);
});
