'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeBattle } = require('../app/battle-review-model');
const { extractProtocol } = require('../app/battle-review-input');

// Synthetic protocol cases isolate event ordering. The oracle suite also exercises legal simulator battles.
function log(turns, options = {}) {
  const { format = '[Gen 9] OU', gen = '9', game = 'singles', p1 = 'Gliscor, M|100/100',
    p2 = 'Deoxys-Speed|100/100', result = '|win|Ada', extra = '' } = options;
  return [`|gametype|${game}`, '|player|p1|Ada', '|player|p2|Cora', `|gen|${gen}`, `|tier|${format}`,
    '|teamsize|p1|6', '|teamsize|p2|6', '|start', `|switch|p1a: Left|${p1}`, `|switch|p2a: Right|${p2}`,
    extra, ...turns.flatMap((lines, i) => [`|turn|${i + 1}`, ...lines]), result].join('\n');
}
const attack = (side, move, target = side === 1 ? 2 : 1) =>
  `|move|p${side}a: ${side === 1 ? 'Left' : 'Right'}|${move}|p${target}a: ${target === 1 ? 'Left' : 'Right'}`;
const row = (report, side, turn) => report.sides[side].turns[turn - 1];

test('the attacking player sees the opponent’s switch or Tera in the outcome, after the pre-choice assessment', () => {
  const attackFire = attack(1, 'Flamethrower');
  const options = { p2: 'Scizor|100/100' };
  const switched = analyzeBattle(log([['|switch|p2a: Replacement|Blissey|100/100', attackFire]], options));
  const changed = analyzeBattle(log([['|-terastallize|p2a: Right|Water', attackFire]], options));
  for (const result of [switched, changed]) {
    assert.match(row(result, 'p1', 1).before, /Scizor/);
    assert.equal(row(result, 'p1', 1).stars, null);
  }
  assert.match(row(switched, 'p1', 1).outcome, /switched Scizor out for Blissey/);
  assert.match(row(changed, 'p1', 1).outcome, /Scizor Terastallized into the Water type/);
});

test('both players get an evidence-based independent summary and the game result never changes choice grades', () => {
  const turns = [
    [attack(1, 'Stealth Rock'), '|-sidestart|p2: Cora|move: Stealth Rock', attack(2, 'Spikes'), '|-sidestart|p1: Ada|Spikes'],
    [attack(1, 'Rapid Spin'), '|-damage|p2a: Right|84/100', '|-sideend|p1: Ada|Spikes|[from] move: Rapid Spin',
      attack(2, 'Ice Beam'), '|-supereffective|p1a: Left', '|-damage|p1a: Left|43/100'],
    [attack(1, 'Roost', 1), '|-heal|p1a: Left|93/100', attack(2, 'Ice Beam'), '|-damage|p1a: Left|33/100'],
    [attack(1, 'Earthquake'), '|-damage|p2a: Right|60/100', attack(2, 'Ice Beam'), '|-damage|p1a: Left|0 fnt', '|faint|p1a: Left'],
  ];
  const a = analyzeBattle(log(turns));
  const b = analyzeBattle(log(turns, { result: '|win|Cora' }));
  assert.deepEqual(a.players, { p1: 'Ada', p2: 'Cora' });
  assert.equal(a.turnCount, 4);
  assert.equal(a.supported, true);
  assert.equal(a.winner, 'Ada');
  assert.match(a.sides.p1.summary, /Ada won in 4 turns/);
  assert.match(a.sides.p1.summary, /Stealth Rock|Rapid Spin/);
  assert.match(a.sides.p2.summary, /Ice Beam|Spikes/);
  for (const side of ['p1', 'p2']) {
    assert.deepEqual(a.sides[side].turns, b.sides[side].turns);
    assert.equal(a.sides[side].decisions, 4);
  }
  assert.equal(a.sides.p2.stars, null);
  assert.equal(row(a, 'p1', 2).stars, null);
  assert.match(row(a, 'p1', 2).before, /Spikes/);
  assert.equal(row(a, 'p1', 3).stars, null);
  assert.match(row(a, 'p1', 3).before, /Gliscor \(≈43%\)/);
  assert.ok(a.sides.p2.highlights.every(point => point.turn >= 1 && point.turn <= 4));
});

test('a new opposing Tera, switch, critical hit or miss during resolution cannot rewrite the grade', () => {
  const variants = [
    [attack(1, 'Ice Beam'), '|-damage|p2a: Right|65/100'],
    ['|-terastallize|p2a: Right|Water', attack(1, 'Ice Beam'), '|-resisted|p2a: Right', '|-damage|p2a: Right|96/100'],
    ['|switch|p2a: Replacement|Toxapex|100/100', attack(1, 'Ice Beam'), '|-resisted|p2a: Replacement'],
    [attack(1, 'Ice Beam'), '|-crit|p2a: Right', '|-damage|p2a: Right|0 fnt', '|faint|p2a: Right'],
    [attack(1, 'Ice Beam') + '|[miss]', '|-miss|p1a: Left|p2a: Right'],
  ].map(lines => row(analyzeBattle(log([lines], { p2: 'Dragonite|100/100' })), 'p1', 1));
  for (const choice of variants) {
    assert.equal(choice.stars, null);
    assert.equal(choice.before, variants[0].before);
    assert.equal(choice.lesson, variants[0].lesson);
  }
  assert.match(variants[3].outcome, /critical hit/);
  assert.equal((variants[4].outcome.match(/missed/g) || []).length, 1);
  assert.doesNotMatch(variants[1].before, /Water/);
});

test('known immunities and alternative damage precede the repeat; fresh immunity and hidden locks receive no retrospective blame', () => {
  const turns = [
    [attack(1, 'Tackle'), '|-damage|p2a: Right|80/100'],
    [attack(1, 'Earthquake'), '|-immune|p2a: Right'],
    [attack(1, 'Earthquake'), '|-immune|p2a: Right'],
    [attack(1, 'Earthquake'), '|-immune|p2a: Right'],
  ];
  const a = analyzeBattle(log(turns, { p2: 'Weezing|100/100' }));
  assert.ok(row(a, 'p1', 2).stars === null || row(a, 'p1', 2).stars >= 3);
  assert.equal(row(a, 'p1', 3).stars, null);
  assert.equal(row(a, 'p1', 4).stars, null); // Weezing's possible abilities do not settle this matchup.
  const locked = analyzeBattle(log([...turns.slice(0, 2), ['|-start|p1a: Left|Encore', ...turns[2]]]));
  assert.equal(row(locked, 'p1', 3).stars, null);
  assert.equal(row(locked, 'p1', 3).decision, false);
});

test('a single observed HP loss never establishes a damage bound or a finishing recommendation', () => {
  const initial = [attack(1, 'Tackle'), '|-damage|p2a: Right|35/100'];
  const unchanged = analyzeBattle(log([initial, [attack(1, 'Tackle')]]));
  assert.equal(row(unchanged, 'p1', 2).stars, null);
  assert.doesNotMatch(row(unchanged, 'p1', 2).lesson, /within reach|in range/i);
  for (const change of ['|-boost|p2a: Right|def|2', '|-status|p1a: Left|brn',
    '|-item|p2a: Right|Eviolite', '|-fieldstart|move: Grassy Terrain', '|-weather|RainDance',
    '|-sidestart|p2: Cora|Reflect', '|-terastallize|p2a: Right|Steel', '|replace|p2a: Right|Zoroark|35/100']) {
    const changed = analyzeBattle(log([[...initial, change], [attack(1, 'Tackle')]]));
    assert.notEqual(row(changed, 'p1', 2).stars, 5, change);
  }
  const crit = analyzeBattle(log([[attack(1, 'Tackle'), '|-crit|p2a: Right', '|-damage|p2a: Right|35/100'],
    [attack(1, 'Tackle')]]));
  assert.notEqual(row(crit, 'p1', 2).stars, 5);
  const residual = analyzeBattle(log([[attack(1, 'Tackle'), '|-damage|p2a: Right|20/100|[from] psn'], [attack(1, 'Tackle')]]));
  assert.notEqual(row(residual, 'p1', 2).stars, 5);
});

test('a previous attack informs switch coaching without forecasting the opponent’s choice or reading entry HP', () => {
  const first = [attack(2, 'Thunderbolt'), '|-damage|p1a: Left|40/100'];
  const sw = '|switch|p1a: New|Clodsire|100/100';
  const a = analyzeBattle(log([first, [sw, attack(2, 'Thunderbolt'), '|-immune|p1a: New']], { p1: 'Corviknight|100/100' }));
  const b = analyzeBattle(log([first, [sw, attack(2, 'Ice Beam'), '|-damage|p1a: New|40/100']], { p1: 'Corviknight|100/100' }));
  assert.equal(row(a, 'p1', 2).stars, null);
  assert.match(row(a, 'p1', 2).before, /Thunderbolt on turn 1/);
  assert.equal(row(a, 'p1', 2).before, row(b, 'p1', 2).before);
  assert.equal(row(a, 'p1', 2).stars, row(b, 'p1', 2).stars);
  const risky = analyzeBattle(log([first, [sw.replace('100/100', '3/100'), attack(2, 'Thunderbolt')]],
    { p1: 'Corviknight|100/100', extra: '|-sidestart|p1: Ada|move: Stealth Rock' }));
  assert.equal(row(risky, 'p1', 2).stars, null);
  assert.match(row(risky, 'p1', 2).lesson, /hazard/i);
  assert.doesNotMatch(row(risky, 'p1', 2).before, /3%/);
});

test('forced switches, replacements, called moves and lost actions receive no decision credit', () => {
  const report = analyzeBattle(log([
    [attack(2, 'Roar'), '|drag|p1a: New|Clefable|100/100'],
    [attack(2, 'Moonblast'), '|-damage|p1a: New|0 fnt', '|faint|p1a: New', '|upkeep',
      '|switch|p1a: More|Blissey|100/100'],
    ['|cant|p1a: More|par', attack(2, 'Ice Beam')],
    [attack(1, 'Metronome', 1), attack(1, 'Earthquake') + '|[from]move: Metronome', '|-damage|p2a: Right|72/100'],
    [attack(2, 'Encore'), '|-start|p1a: More|Encore', attack(1, 'Soft-Boiled', 1) + '|[still]', '|-fail|p1a: More|heal'],
  ]));
  assert.equal(report.sides.p1.decisions, 1);
  assert.match(row(report, 'p1', 1).label, /Replacement/);
  assert.match(row(report, 'p1', 3).luck, /paralysis/);
  assert.match(row(report, 'p1', 4).action, /Metronome/);
  assert.equal(row(report, 'p1', 5).stars, null);
});

test('excludes chat, private requests and HTML from output and bounds malformed battle input', () => {
  const sample = log([['|c|secret-person|secret-text', '|request|{"secret":"opponent-team"}', '|raw|<b>secret-banner</b>', attack(1, 'Earthquake')]]);
  assert.doesNotMatch(JSON.stringify(analyzeBattle(sample)), /secret|opponent-team|<b>/);
  assert.throws(() => analyzeBattle(sample.replace('|win|Ada', '')), { code: 'incomplete-replay' });
  assert.throws(() => analyzeBattle(sample.replace('|turn|1', '|turn|4')), { code: 'invalid-replay' });
  assert.throws(() => analyzeBattle(sample.replace('|turn|1', '|turn|1001')), { code: 'review-limit' });
  assert.throws(() => analyzeBattle(sample.replace('|turn|1', '|split|p1')), { code: 'invalid-replay' });
  assert.throws(() => analyzeBattle('x'.repeat(16385)), { code: 'review-limit' });
  assert.throws(() => analyzeBattle('\n'.repeat(30000)), { code: 'review-limit' });
  assert.throws(() => analyzeBattle('x'.repeat(2 * 1024 * 1024 + 1)), { code: 'review-limit' });
});

test('no rating for insufficient evidence, completed team-preview forfeits, doubles, custom mechanics or other generations', () => {
  const short = analyzeBattle(log([[attack(1, 'Ice Beam')]], { p2: 'Garchomp|100/100' }));
  assert.equal(short.sides.p1.rated, 0);
  assert.equal(short.sides.p1.stars, null);
  for (const opts of [{ gen: '7' }, { game: 'doubles' }, { format: '[Gen 9] Inverse' }, { format: '[Gen 9] CAP' }]) {
    const report = analyzeBattle(log([[attack(1, 'Ice Beam')]], opts));
    assert.equal(report.supported, false);
    assert.match(report.scope, /outside that scope/);
    assert.equal(report.sides.p1.stars, null);
    assert.deepEqual(report.sides.p1.turns, []);
  }
  const preview = analyzeBattle('|player|p1|Ada\n|player|p2|Cora\n|gen|9\n|gametype|singles\n|tier|[Gen 9] OU\n|teampreview\n|win|Cora');
  assert.equal(preview.supported, true);
  assert.equal(preview.sides.p1.decisions, 0);
  assert.equal(preview.sides.p1.stars, null);
  assert.equal(analyzeBattle(log([], { result: '|tie' })).winner, '');
});

test('a publicly revealed absorbing ability applies to other moves of the same type and the recorded owner', () => {
  for (const activation of ['|-heal|p2a: Right|80/100|[from] ability: Water Absorb',
    '|-immune|p2a: Right|[from] ability: Water Absorb',
    '|-activate|p1a: Left|move: Surf|[from] ability: Water Absorb|[of] p2a: Right']) {
    const r = analyzeBattle(log([[attack(1, 'Surf'), activation], [attack(1, 'Hydro Pump')]],
      { p1: 'Primarina|100/100', p2: 'Clodsire|60/100' }));
    assert.equal(row(r, 'p1', 1).stars, null);
    assert.match(row(r, 'p1', 1).lesson, /species has an ability/);
    assert.equal(row(r, 'p1', 2).stars, null);
    assert.match(row(r, 'p1', 2).lesson, /had revealed an ability/);
  }
});

test('Pain Split updates both public HP totals and variable-power and multi-hit moves cannot project a knockout', () => {
  const r = analyzeBattle(log([[attack(1, 'Pain Split'), '|-sethp|p1a: Left|85/100|p2a: Right|18/100|[from] move: Pain Split'],
    [attack(2, 'Recover', 2)]]));
  assert.match(row(r, 'p2', 2).before, /18%/);
  for (const move of ['Eruption', 'Water Spout', 'Flail', 'Reversal', 'Dragon Energy', 'Bullet Seed', 'Population Bomb', 'Endeavor']) {
    const repeat = analyzeBattle(log([[attack(1, move), '|-damage|p2a: Right|38/100',
      attack(2, 'Tackle'), '|-damage|p1a: Left|8/100'], [attack(1, move)]]));
    assert.notEqual(row(repeat, 'p1', 2).stars, 5, move);
    assert.doesNotMatch(row(repeat, 'p1', 2).lesson, /earlier hit put a knockout/);
  }
});

test('hazard removal evaluates the public blocker and a resistance switch must improve the matchup', () => {
  for (const [move, defender] of [['Rapid Spin', 'Gholdengo'], ['Mortal Spin', 'Corviknight']]) {
    const r = analyzeBattle(log([[attack(1, move), '|-immune|p2a: Right'], [attack(1, move)]],
      { p2: defender + '|100/100', extra: '|-sidestart|p1: Ada|Stealth Rock' }));
    assert.equal(row(r, 'p1', 1).stars, null);
    assert.match(row(r, 'p1', 1).lesson, /needs to hit/);
    assert.equal(row(r, 'p1', 2).stars, null);
  }
  const anotherResist = analyzeBattle(log([[attack(2, 'Ice Beam')], ['|switch|p1a: New|Arcanine|100/100']],
    { p1: 'Heatran|100/100' }));
  assert.equal(row(anotherResist, 'p1', 2).stars, null);
});

test('Revival Blessing restores a benched teammate and leaves the active HP and status alone', () => {
  const sample = log([
    ['|faint|p1a: Left', '|upkeep', '|switch|p1a: Left|Pawmot|100/100'],
    [attack(1, 'Revival Blessing', 1), '|-heal|p1: Pikachu|50/100|[from] move: Revival Blessing',
      '|-status|p1: Pikachu|par'],
    [attack(1, 'U-turn')],
  ]).replace('|teamsize|p1|6', '|teamsize|p1|2');
  const report = analyzeBattle(sample);
  assert.match(row(report, 'p1', 2).outcome, /restored a benched teammate/);
  assert.equal(row(report, 'p1', 3).stars, null);
  assert.match(row(report, 'p1', 3).before, /living teammate/);
  const health = analyzeBattle(sample.replace('U-turn', 'Calm Mind'));
  assert.match(row(health, 'p1', 3).before, /Pawmot \(100%\)/);
});

test('a supported comparison is invariant to seat, resolution, and later revealed moves', () => {
  const options = { p1: 'Corviknight|100/100', p2: 'Avalugg|100/100', extra: '|-item|p1a: Left|Air Balloon' };
  const pick = attack(1, 'Drill Peck');
  const before = [attack(1, 'Peck')];
  const grade = ({ stars, label, before, lesson, comparison }) => ({ stars, label, before, lesson, comparison });
  const expected = grade(analyzeBattle(log([before, [pick]], options)).sides.p1.turns[1]);
  assert.equal(expected.stars, 4);
  assert.equal(expected.comparison.alternative, 'Peck');
  for (const variant of [[pick], [pick + '|[miss]', '|-miss|p1a: Left|p2a: Right'],
    ['|-terastallize|p2a: Right|Steel', pick, '|-resisted|p2a: Right'],
    ['|switch|p2a: Another|Rotom-Heat|100/100', pick],
    ['|-item|p1a: Left|Choice Band', pick, '|-crit|p2a: Right', '|-damage|p2a: Right|0 fnt']]) {
    const sample = log([before, variant, [attack(1, 'Brave Bird')]], { ...options, result: '|win|Cora' });
    assert.deepEqual(grade(analyzeBattle(sample).sides.p1.turns[1]), expected);
    const swapped = sample.replace(/p[12](?=a?: |\|)/g, side => side === 'p1' ? 'p2' : 'p1');
    assert.deepEqual(grade(analyzeBattle(swapped).sides.p2.turns[1]), expected);
  }
});

test('Gen 9 exact and displayed HP agree at faint, near-full and low HP boundaries', () => {
  for (const maximum of [48, 100, 301, 400]) {
    for (const current of [0, 1, Math.floor(maximum / 2), maximum - 1, maximum]) {
      const displayed = current === maximum ? 100 : Math.min(99, Math.ceil(current * 100 / maximum));
      const build = hp => log([['|switch|p1a: New|Clodsire|100/100']], { p1: 'Corviknight|' + hp });
      const exact = extractProtocol(build(current + '/' + maximum), 'text');
      const publicLog = extractProtocol(build(displayed + '/100'), 'text');
      assert.equal(exact, publicLog);
      const choice = analyzeBattle(exact).sides.p1.turns[0];
      assert.equal(choice.decision, current !== 0);
      if (current === 1) assert.match(choice.before, /≈\d+%/);
    }
  }
});

test('a custom rule announcement prevents ordinary OU assessments without retaining server HTML', () => {
  const raw = '|raw|<div class="infobox"><details class="readmore" open><summary><strong>1 custom rule:</strong></summary> Inverse Mod</details></div>';
  const input = log([[attack(1, 'Ice Beam')]]).replace('|start', raw + '\n|start');
  const sanitized = extractProtocol(input, 'text');
  assert.doesNotMatch(sanitized, /Inverse|<div|readmore/);
  assert.equal(extractProtocol(sanitized, 'text'), sanitized);
  for (const sample of [input, sanitized]) {
    const report = analyzeBattle(sample);
    assert.equal(report.supported, false);
    assert.deepEqual(report.sides.p1.turns, []);
  }
});
