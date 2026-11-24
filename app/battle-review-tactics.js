'use strict';

const path = require('node:path');
const { WORLD_COUNT, seed, history, openingWorlds, advanceWorlds, submitBoth, checkDeadline, BUDGET_REACHED } = require('./battle-review-tactics-worlds');

const SCREEN_SEEDS = 4;
const CHECK_SEEDS = 8;
const MAX_TURN = 4;
const METRICS = ['foeHP', 'ownHP', 'foeKO', 'ownKO'];
const objective = 'One-turn HP exchange is opposing team HP lost minus your team HP lost. Each full Pokémon counts as 100 points.';

function options(request) {
  const result = [];
  const active = request.active?.[0];
  for (const [i, slot] of (active?.moves || []).entries()) {
    if (slot.disabled || slot.pp === 0) continue;
    const choice = 'move ' + (i + 1);
    result.push({ choice, name: slot.move, id: slot.id, kind: 'move' });
    if (active.canTerastallize) {
      result.push({ choice: choice + ' terastallize', name: slot.move + ' · Tera ' + active.canTerastallize, id: slot.id, kind: 'tera' });
    }
  }
  if (!active?.trapped) {
    for (const [i, mon] of request.side.pokemon.entries()) {
      if (mon.active || mon.reviving || !/^\d+\//.test(mon.condition)) continue;
      result.push({ choice: 'switch ' + (i + 1), name: 'Switch to ' + mon.details.split(',')[0], kind: 'switch' });
    }
  }
  return result;
}

// Each hypothesis gets replies drawn from its own available set before we see
// any candidate. Its generated move and team order break ties reproducibly.
function selectReplies(engine, battle, foe) {
  const pokemon = battle[foe].active[0];
  const request = battle[foe].activeRequest;
  const menu = options(request);
  const ordinary = menu.filter(option => option.kind === 'move');
  const attacks = ordinary.filter(option => engine.Dex.moves.get(option.id).category !== 'Status');
  const first = attacks[0] || ordinary[0];
  const status = ordinary.find(option => engine.Dex.moves.get(option.id).category === 'Status');
  const another = status !== first && status ? status : attacks[1];
  const tera = menu.find(option => option.kind === 'tera' && option.id === first?.id);
  const swap = menu.find(option => option.kind === 'switch' && !pokemon.trapped);
  return [first, another, tera, swap].filter(Boolean);
}

function balance(battle, seat) {
  const team = battle[seat].pokemon;
  return { hp: team.reduce((sum, mon) => sum + 100 * mon.hp / mon.maxhp, 0),
    alive: team.reduce((sum, mon) => sum + Number(mon.hp > 0), 0) };
}

function finishTurn(battle, turn, logStart) {
  for (let i = 0; i <= 12; i++) {
    if (battle.ended || battle.turn > turn || battle.log.indexOf('|upkeep', logStart) >= 0) return i;
    if (battle.requestState !== 'switch') return null;
    const forced = battle.sides.filter(side => side.activeRequest?.forceSwitch?.[0]);
    if (!forced.length) return null;
    for (const side of forced) {
      if (side.activeRequest.side.pokemon.some(mon => mon.reviving)) return null;
      const incoming = options(side.activeRequest).find(option => option.kind === 'switch');
      if (!incoming || !battle.choose(side.id, incoming.choice)) return null;
    }
  }
  return null;
}

function roll(engine, state, chance, seat, candidate, reply, initial) {
  const battle = engine.Battle.fromJSON(state);
  try {
    const foe = seat === 'p1' ? 'p2' : 'p1';
    const turn = battle.turn;
    const offset = battle.log.length;
    battle.prng = new engine.PRNG(chance);
    if (!submitBoth(battle, seat, candidate.choice, reply.choice)) return null;
    const replacements = finishTurn(battle, turn, offset);
    if (replacements === null) return null;
    const own = balance(battle, seat), opposing = balance(battle, foe);
    const foeHP = initial.foe.hp - opposing.hp;
    const ownHP = initial.own.hp - own.hp;
    return { foeHP, ownHP, score: foeHP - ownHP, foeKO: initial.foe.alive - opposing.alive,
      ownKO: initial.own.alive - own.alive, usedReplacement: replacements > 0 };
  } finally {
    battle.destroy();
  }
}

function cellsFor(engine, seat, states) {
  const foe = seat === 'p1' ? 'p2' : 'p1';
  const cells = [];
  for (const [i, state] of states.entries()) {
    const battle = engine.Battle.fromJSON(state);
    try {
      const replies = selectReplies(engine, battle, foe);
      if (!replies.length) return [];
      const active = battle[foe].active[0];
      const item = engine.Dex.items.get(active.item).name || 'no held item';
      const ability = engine.Dex.abilities.get(active.ability).name;
      const worldLabel = active.species.name + ' · ' + item + ' · ' + ability + ' · Tera ' + active.teraType;
      const initial = { own: balance(battle, seat), foe: balance(battle, foe) };
      for (const reply of replies) {
        cells.push({ state, world: i + 1, reply, worldLabel, initial, weight: 1 / (states.length * replies.length) });
      }
    } finally {
      battle.destroy();
    }
  }
  return cells;
}

function measure(engine, cells, seat, menu, seeds, deadline) {
  const totals = menu.map(() => ({ foeHP: 0, ownHP: 0, foeKO: 0, ownKO: 0, score: 0, usedReplacement: false }));
  const samples = [];
  for (const cell of cells) {
    const scores = [];
    for (const [i, candidate] of menu.entries()) {
      checkDeadline(deadline);
      const row = [];
      for (const chance of seeds) {
        const outcome = roll(engine, cell.state, chance, seat, candidate, cell.reply, cell.initial);
        if (!outcome) return null;
        if (outcome.usedReplacement) totals[i].usedReplacement = true;
        row.push(outcome.score);
        for (const metric of METRICS) totals[i][metric] += cell.weight * outcome[metric] / seeds.length;
      }
      scores.push(row);
    }
    samples.push(scores);
  }
  for (const total of totals) total.score = total.foeHP - total.ownHP;
  return { totals, samples };
}

const mean = array => array.reduce((sum, value) => sum + value, 0) / array.length;
const rounded = (value, places = 1) => Number(value.toFixed(places));

function describe(engine, decision, menu, cells, screen, checked) {
  const played = menu.findIndex(option => option.choice === decision.choice);
  // Pick ONE fixed alternative using averages across all joint worlds/replies.
  // Compare that same option with the played choice on fresh, disjoint chance seeds.
  const ranked = menu.map((_, i) => i).filter(i => i !== played).sort((a, b) => screen.totals[b].score - screen.totals[a].score);
  const alt = ranked[0];
  const deltas = [];
  const replies = cells.map((cell, i) => {
    const scores = checked.samples[i];
    const alternativeScore = mean(scores[alt]), playedScore = mean(scores[played]);
    deltas.push(alternativeScore - playedScore);
    return { world: cell.world, worldLabel: cell.worldLabel, reply: cell.reply.name,
      alternativeScore: rounded(alternativeScore), playedScore: rounded(playedScore) };
  });
  const alternative = menu[alt].name, name = menu[played].name;
  const delta = checked.totals[alt].score - checked.totals[played].score;
  // One chance seed is shared across all candidates AND all cells. Estimate
  // variability across paired seed-level mixture differences, never across cells.
  const paired = Array.from({ length: CHECK_SEEDS }, (_, j) => cells.reduce((sum, cell, i) =>
    sum + cell.weight * (checked.samples[i][alt][j] - checked.samples[i][played][j]), 0));
  const pairedSE = Math.sqrt(paired.reduce((sum, value) => sum + (value - delta) ** 2, 0) /
    (CHECK_SEEDS * (CHECK_SEEDS - 1)));
  const hasReversal = Math.min(...deltas) < -5 && Math.max(...deltas) > 5;
  const sameDirection = checked.samples.every(cell => cell[alt].every((v, i) => v >= cell[played][i])) &&
    screen.samples.every(cell => mean(cell[alt]) >= mean(cell[played]));
  const additionalCost = menu[alt].kind === 'tera' && menu[played].kind !== 'tera' ||
    checked.totals[alt].ownKO > checked.totals[played].ownKO + 0.001;
  const usesReplacement = [played, alt].some(i => screen.totals[i].usedReplacement || checked.totals[i].usedReplacement);
  const positional = menu[played].kind === 'switch' || engine.Dex.moves.get(menu[played].id || '').category === 'Status';
  let label = 'Similar immediate results';
  let summary = 'The sampled replies and chance rolls give no consistent large advantage to either of these choices.';
  if (hasReversal) {
    label = 'Prediction-dependent';
    const higher = replies[deltas.indexOf(Math.max(...deltas))], lower = replies[deltas.indexOf(Math.min(...deltas))];
    summary = alternative + ' had a better HP exchange when example team ' + higher.world + ' chose ' + higher.reply +
      '. ' + name + ' did better when example team ' + lower.world + ' chose ' + lower.reply + '.';
  } else if (delta >= 10 && Math.min(...deltas) >= 5 && sameDirection && !additionalCost && !usesReplacement && !positional) {
    label = 'Opportunity to study';
    summary = alternative + ' gained ' + rounded(delta) + ' more net HP points on average and led against every sampled reply. Consider what the played line aimed to achieve on later turns.';
  } else if (checked.totals.every(total => total.score <= checked.totals[played].score + 0.001) &&
      screen.totals.every(total => total.score <= screen.totals[played].score + 0.001)) {
    label = 'Played line held up';
    summary = name + ' matched or led the other choices on average in both batches of sampled HP exchanges.';
  } else if (delta >= 5 && (usesReplacement || positional) && !additionalCost) {
    label = 'Position tradeoff';
    summary = alternative + ' led by ' + rounded(delta) + ' immediate net HP points on average. ' + (usesReplacement ?
      'A mid-turn switch used the first healthy bench slot. Choosing a different replacement could change that exchange.' :
      name + ' can also affect the position on later turns, beyond this HP comparison.');
  } else if (Math.abs(delta) >= 5) {
    label = additionalCost && delta > 0 ? 'Resource tradeoff' : 'Uncertain immediate result';
    const better = delta > 0 ? alternative : name;
    summary = better + ' led by ' + rounded(Math.abs(delta)) + ' net HP points on average. ' +
      (additionalCost && delta > 0 ? (menu[alt].kind === 'tera' && menu[played].kind !== 'tera' ?
        'The alternative would spend your Tera for this battle.' : 'The alternative also had a higher sampled faint count for your team.') :
        'The two batches did not establish a consistent large gain across these replies and rolls.');
  }
  const candidates = menu.map(({ choice, name: action }, i) => {
    const total = checked.totals[i];
    return { choice, name: action, played: i === played, score: rounded(total.score), foeHP: rounded(total.foeHP),
      ownHP: rounded(total.ownHP), foeKO: rounded(total.foeKO, 2), ownKO: rounded(total.ownKO, 2) };
  });
  return { status: 'compared', turn: decision.turn, label, objective, played: name, alternative, summary,
    worlds: WORLD_COUNT, seedsPerReply: CHECK_SEEDS, candidates, replies,
    assumptions: [
      'Two hypothetical teams from the pinned Random Battle generator share the visible lead and match your request and preceding events. The displayed lead is assumed genuine. Other hidden teams could change the result.',
      'Each team has equal weight. Within it, the first attack, a status move or second attack, a Tera variant and the first available switch share weight equally when available. These example replies do not estimate bot behavior.',
      'Every choice uses the same chance seeds. Four rolls per reply select one fixed alternative across teams. Eight fresh rolls per reply give the displayed means. Rare outcomes can be missed.',
      'For ' + alternative + ' versus ' + name + ', the paired net HP difference ranged from ' +
        rounded(Math.min(...paired)) + ' to ' + rounded(Math.max(...paired)) + ' points across the eight check seeds. Its estimated sampling standard error is ' +
        rounded(pairedSE) + ' points under these fixed teams and reply weights.',
      'Mid-turn pivots use the first healthy bench slot. HP includes recoil, healing and end-of-turn effects. The exchange omits the later value of setup, field position and spending Tera.',
    ] };
}

function createTacticalReviewer(simulatorRoot, { deadline = Infinity } = {}) {
  const sim = path.join(simulatorRoot, 'dist', 'sim');
  const engine = { ...require(sim), extractChannelMessages: require(path.join(sim, 'battle')).extractChannelMessages };
  let previous = null;
  function evaluate(prefix, decision) {
    const prior = previous;
    previous = null;
    const { turn, request } = decision;
    const skip = reason => ({ status: 'skipped', turn, reason });
    checkDeadline(deadline);
    if (!prefix.includes('|tier|[Gen 9] Random Battle') || prefix.includes('|-reviewcustomrules|') ||
        !['p1', 'p2'].includes(request.side.id) || request.side.pokemon.length !== 6) return skip('This request does not match the pinned six-Pokémon Random Battle format.');
    if (turn > MAX_TURN) return skip('The one-turn simulator covers the first ' + MAX_TURN + ' turns of this battle.');
    if (turn < 1 || (turn > 1 || request.forceSwitch) && !prior) return skip('A matching simulated history was unavailable for this position.');
    const active = request.active?.[0];
    if (!request.forceSwitch && (!active || active.maybeTrapped || active.maybeDisabled || active.maybeLocked ||
        active.canMegaEvo || active.canZMove || active.canDynamax)) return skip('The complete selectable menu could not be established.');
    const states = turn === 1 && !request.forceSwitch && !prior ? openingWorlds(engine, prefix, decision, deadline) :
      advanceWorlds(engine, prefix, decision, prior, deadline);
    if (states.length < WORLD_COUNT) return skip('Two hypothetical teams could not reproduce your full request and the preceding battle events.');
    previous = { view: history(prefix), turn, choice: decision.choice, worlds: states };
    if (request.forceSwitch) return skip('A replacement has a different horizon from a simultaneous turn choice. Its menu is recorded here.');
    const menu = options(request);
    if (menu.length < 2 || !menu.some(candidate => candidate.choice === decision.choice)) return skip('The confirmed choice has no verifiable alternative in this menu.');
    const cells = cellsFor(engine, request.side.id, states.slice(0, WORLD_COUNT));
    if (!cells.length) return skip('Comparable opponent replies could not be established.');
    const seeds = label => Array.from({ length: label === 'screen' ? SCREEN_SEEDS : CHECK_SEEDS }, (_, i) => seed(label + '-' + turn, i));
    const screen = measure(engine, cells, request.side.id, menu, seeds('screen'), deadline);
    const checked = screen && measure(engine, cells, request.side.id, menu, seeds('check'), deadline);
    if (!checked) return skip('At least one offered choice or mid-turn continuation could not resolve consistently across the sampled teams.');
    return describe(engine, decision, menu, cells, screen, checked);
  }
  return (prefix, decision) => {
    try { return evaluate(prefix, decision); } catch (error) {
      if (error !== BUDGET_REACHED) throw error;
      previous = null;
      return { status: 'skipped', turn: decision.turn, reason: 'The review reached its simulation budget for this game.' };
    }
  };
}

module.exports = { createTacticalReviewer, MAX_TURN };
