'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PracticeTeams } = require('../app/practice-teams');
const { readBotConfig } = require('../app/bot-config');

// A stand-in for the simulator's team code: "Name|moves" lines, and "Uber" is banned.
const fakeSim = {
  Teams: {
    import: text => text.split('\n').filter(Boolean).map(line => ({ species: line.split(' @ ')[0] })),
    unpack: text => (text === 'broken' ? null : text.split(']').map(species => ({ species }))),
    pack: sets => sets.map(set => set.species).join(']'),
    export: sets => sets.map(set => set.species).join('\n\n'),
  },
  TeamValidator: { get: () => ({ validateTeam: sets => (sets.some(set => set.species === 'Uber') ? ['Uber is banned.'] : null) }) },
};
const teams = new PracticeTeams({ root: '/runtime', load: () => fakeSim });

test('accepts a legal team and returns its packed and exported forms', () => {
  assert.deepEqual(teams.check('gen9ou', 'export', 'Great Tusk @ Booster Energy\nKingambit'),
    { ok: true, packed: 'Great Tusk]Kingambit', exported: 'Great Tusk\n\nKingambit', species: ['Great Tusk', 'Kingambit'] });
  assert.equal(teams.check('gen9ou', 'packed', 'Great Tusk]Kingambit').ok, true);
});

test('explains illegal, unreadable, empty and oversized teams', () => {
  assert.match(teams.check('gen9ou', 'export', 'Uber').error, /^Not legal in OU: Uber is banned/);
  assert.match(teams.check('gen9ou', 'packed', 'broken').error, /Teambuilder/);
  assert.match(teams.check('gen9ou', 'export', '   ').error, /Paste a team/);
  assert.match(teams.check('gen9ou', 'export', 'A\n'.repeat(5000)).error, /too long/);
  assert.match(teams.check('gen9ou', 'export', 'A\nB\nC\nD\nE\nF\nG').error, /six/);
  assert.equal(teams.check('gen9randombattle', 'export', 'Great Tusk').ok, false);
});

test('says so when the simulator is missing', () => {
  const missing = new PracticeTeams({ root: '/nowhere', load: () => { throw new Error('missing'); } });
  assert.match(missing.check('gen9ou', 'export', 'Great Tusk').error, /missing/);
});

// With a built practice simulator, the real validator: the fixture team is legal, Koraidon is not.
const config = (() => { try { return readBotConfig(path.join(__dirname, '../out/bots/config.json')); } catch { return null; } })();
const simulatorRoot = config?.root || path.join(__dirname, '../vendor/laplace/dist');
test('checks teams with the practice simulator', { skip: !fs.existsSync(path.join(simulatorRoot, 'server/dist/sim')) }, () => {
  const real = new PracticeTeams({ root: simulatorRoot });
  const fixture = real.check('gen9ou', 'export', fs.readFileSync(path.join(__dirname, 'fixtures/ou-team.txt'), 'utf8'));
  assert.equal(fixture.ok, true);
  assert.equal(fixture.species.length, 6);
  assert.equal(real.check('gen9ou', 'packed', fixture.packed).ok, true);
  assert.match(real.check('gen9ou', 'export', 'Koraidon @ Choice Scarf\nAbility: Orichalcum Pulse\n- Flare Blitz').error, /Koraidon/);
});
