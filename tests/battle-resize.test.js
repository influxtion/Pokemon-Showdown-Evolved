'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { battleResizeScript, widthFromMessage, MIN_WIDTH, MAX_WIDTH } = require('../app/battle-resize');

test('only a well-formed width message within range is saved', () => {
  assert.equal(widthFromMessage('sd-battle-width:900'), 900);
  assert.equal(widthFromMessage(`sd-battle-width:${MIN_WIDTH}`), MIN_WIDTH);
  assert.equal(widthFromMessage(`sd-battle-width:${MAX_WIDTH}`), MAX_WIDTH);
  for (const text of ['sd-battle-width:639', 'sd-battle-width:2001', 'sd-battle-width:900.5', 'sd-battle-width:abc',
    'sd-battle-width:', 'battle-width:900', ' sd-battle-width:900', 'sd-battle-width:900 ', undefined, null, 900]) {
    assert.equal(widthFromMessage(text), null, String(text));
  }
});

test('the script is valid JavaScript and falls back to the field width for a bad value', () => {
  for (const width of [640, 900, 2000]) {
    const code = battleResizeScript(width);
    assert.doesNotThrow(() => new vm.Script(code));
    assert.match(code, new RegExp(`let wanted = ${width};`));
  }
  for (const bad of [NaN, 5000, 700.5, '900);alert(1', undefined]) assert.match(battleResizeScript(bad), /let wanted = 640;/);
});

test('installed again, the script only updates the width', () => {
  const widths = [];
  const window = { __sdBattleResize: { set: (value) => widths.push(value) } };
  vm.runInNewContext(battleResizeScript(1000), { window });
  assert.deepEqual(widths, [1000]);
});
