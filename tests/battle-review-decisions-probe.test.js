'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { compareScenario, runExperiment } = require('../scripts/practice/probe-review-decisions.cjs');

test('a single move is weighted across joint item and response hypotheses before comparing alternatives', () => {
  const cells = [];
  for (const item of ['Choice Specs', 'Choice Scarf']) {
    for (const reply of ['Make It Rain', 'Switch to Moltres']) {
      const switched = reply === 'Switch to Moltres';
      const slower = item === 'Choice Specs';
      cells.push({ item, reply, move: 'Earthquake', foeKO: !switched && slower ? 8 : 0, ownKO: !switched && !slower ? 8 : 0 });
      cells.push({ item, reply, move: 'Stone Edge', foeKO: switched ? 4 : 0, ownKO: switched ? 0 : 8 });
    }
  }
  const experiment = { samplesPerCell: 8, cells };
  // Both policies have a 50% marginal switch rate. Their switches come from different item holders.
  const specsSwitches = compareScenario(experiment, 0.5, 1, 0).estimates;
  assert.deepEqual(specsSwitches, { Earthquake: { foeKO: 0, ownKO: 0.5 }, 'Stone Edge': { foeKO: 0.25, ownKO: 0.5 } });
  const scarfSwitches = compareScenario(experiment, 0.5, 0, 1).estimates;
  assert.deepEqual(scarfSwitches, { Earthquake: { foeKO: 0.5, ownKO: 0 }, 'Stone Edge': { foeKO: 0.25, ownKO: 0.5 } });
  assert.throws(() => compareScenario(experiment, 0.5, 1.1, 0));
});

const sim = path.resolve(__dirname, '../vendor/practice/dist/server/dist/sim/battle.js');
test('the legal OU fixture preserves the player view and replays all eight cells deterministically', {
  skip: existsSync(sim) ? false : 'run npm run build:practice',
}, () => {
  const experiment = runExperiment(8);
  assert.deepEqual(runExperiment(8), experiment);
  assert.equal(experiment.cells.length, 8);
  assert.equal(new Set(experiment.cells.map(cell => [cell.item, cell.reply, cell.move].join('/'))).size, 8);
  for (const cell of experiment.cells) {
    if (cell.reply === 'Switch to Moltres') {
      assert.equal(cell.ownKO, 0);
      if (cell.move === 'Earthquake') assert.equal(cell.foeKO, 0);
    }
  }
  for (const move of ['Earthquake', 'Stone Edge']) {
    const switches = experiment.cells.filter(cell => cell.reply === 'Switch to Moltres' && cell.move === move);
    assert.equal(switches[0].foeKO, switches[1].foeKO);
    assert.equal(switches[0].missed, switches[1].missed);
  }
});
