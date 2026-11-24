'use strict';

const { defensiveMatchups } = require('./battle-review-defenses');
const { battleReviewCapture } = require('./battle-review-capture');
const { createTacticalReviewer, MAX_TURN } = require('./battle-review-tactics');

const MAX_DECISIONS = battleReviewCapture().limit;
const MAX_EVALUATIONS = 24;
const BUDGET_REASON = 'The review reached its simulation budget for this game.';
const RUNTIME_REASON = 'The practice simulator could not run this comparison.';

function describeMenu(decision, side) {
  const { request, choice } = decision;
  const roster = request?.side?.pokemon;
  if (request?.side?.id !== side || request.rqid !== decision.rqid || request.wait ||
      !Array.isArray(roster) || roster.length < 1 || roster.length > 6 ||
      !roster.every(mon => typeof mon?.details === 'string' && typeof mon.condition === 'string')) return null;
  const active = request.active?.[0];
  const forced = request.forceSwitch?.length === 1 && request.forceSwitch[0] === true;
  if (!forced && (!Array.isArray(active?.moves) || !active.moves.length || active.moves.length > 4)) return null;
  const selected = /^(move|switch) ([1-6])( terastallize)?$/.exec(choice);
  if (!selected) return null;
  const reviving = forced && roster.some(mon => mon.reviving);
  const moves = [];
  const switches = [];
  let played = '';
  for (const [index, move] of (forced ? [] : active.moves).entries()) {
    if (typeof move?.move !== 'string' || !move.move || move.move.length > 100) return null;
    const available = !move.disabled && move.pp !== 0;
    const pp = Number.isInteger(move.pp) ? String(move.pp) + (Number.isInteger(move.maxpp) ? '/' + move.maxpp : '') + ' PP' : '';
    moves.push([move.move, pp, available ? '' : 'unavailable'].filter(Boolean).join(' · '));
    if (available && selected[1] === 'move' && +selected[2] === index + 1) {
      if (selected[3] && !active.canTerastallize) return null;
      played = move.move + (selected[3] ? ' · Tera ' + active.canTerastallize : '');
    }
  }
  if (!active?.trapped || forced) {
    for (const [index, mon] of roster.entries()) {
      if (mon.active || mon.reviving || /(?:^0(?: |$)| fnt$)/.test(mon.condition) !== reviving) continue;
      const species = mon.details.split(',')[0].slice(0, 80);
      switches.push(species + ' · ' + mon.condition.slice(0, 32));
      if (selected[1] === 'switch' && !selected[3] && +selected[2] === index + 1) {
        played = (reviving ? 'Revive ' : 'Switch to ') + species;
      }
    }
  }
  if (!played) return null;
  return { played, kind: reviving ? 'Revival choice' : forced ? 'Replacement choice' : 'Turn choice',
    moves, switches, tera: typeof active?.canTerastallize === 'string' ? active.canTerastallize.slice(0, 24) : '',
    uncertain: Boolean(active?.maybeTrapped || active?.maybeDisabled || active?.maybeLocked) };
}

function attachPracticeReview(report, log, { side, capture, simulatorRoot }, createReviewer) {
  if (!['p1', 'p2'].includes(side)) return;
  const review = report.sides[side];
  const coverage = { captured: 0, compared: 0, matchups: 0, unconfirmed: 0, truncated: false };
  review.practice = coverage;
  if (capture?.version !== 1 || capture.side !== side || capture.format !== 'gen9randombattle' ||
      !Array.isArray(capture.decisions) || capture.decisions.length > MAX_DECISIONS) return;
  coverage.unconfirmed = Number.isSafeInteger(capture.skipped) ? Math.max(0, Math.min(1000000, capture.skipped)) : 0;
  coverage.truncated = capture.truncated === true;
  const lines = log.split('\n');
  const defenses = defensiveMatchups(side);
  const rows = new Map(review.turns.map(row => [row.turn, row]));
  const deadline = Date.now() + 25000;
  let evaluate, attempts = 0, previousId = -1, boundary = 0, turn = 0;
  for (const decision of capture.decisions) {
    if (!Number.isSafeInteger(decision?.rqid) || decision.rqid <= previousId ||
        !Number.isInteger(decision.boundary) || decision.boundary <= boundary || decision.boundary >= lines.length ||
        !Number.isInteger(decision.turn) || !rows.has(decision.turn)) {
      coverage.unconfirmed++;
      continue;
    }
    while (boundary < decision.boundary) {
      const line = lines[boundary++];
      defenses.observe(line);
      if (line.startsWith('|turn|')) turn = Number(line.slice(6));
    }
    previousId = decision.rqid;
    const menu = describeMenu(decision, side);
    if (turn !== decision.turn || !menu) {
      coverage.unconfirmed++;
      continue;
    }
    const row = rows.get(turn);
    (row.requests ??= []).push(menu);
    coverage.captured++;
    const matchup = defenses.compare(decision.request);
    if (matchup) { menu.matchup = matchup; coverage.matchups++; }
    if (turn > MAX_TURN) menu.reason = 'The one-turn simulator covers the first ' + MAX_TURN + ' turns of this battle.';
    else if (!simulatorRoot) menu.reason = RUNTIME_REASON;
    else if (attempts >= MAX_EVALUATIONS || Date.now() >= deadline) menu.reason = BUDGET_REASON;
    else {
      try {
        evaluate ??= (createReviewer || createTacticalReviewer)(simulatorRoot, { deadline });
        attempts++;
        // A model gets only this seat's decision and events already available at its request.
        const result = evaluate(lines.slice(0, boundary), decision);
        if (result.status === 'compared') {
          menu.tactics = result;
          coverage.compared++;
        } else menu.reason = result.reason;
      } catch {
        menu.reason = RUNTIME_REASON;
        evaluate = () => ({ status: 'skipped', reason: RUNTIME_REASON });
      }
    }
  }
}

module.exports = { attachPracticeReview };
