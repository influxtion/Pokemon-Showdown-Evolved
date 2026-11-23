'use strict';

// Public Gen 9 type facts projected from the simulator pinned in vendor/practice/SOURCE.md.
// No sets, usage, damage calculator, requests, or unrevealed team information enter the review.
const data = require('./battle-review-data.json');
const ids = text => new Set(text.split(' '));
const id = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const SIDES = ['p1', 'p2'];
const opponent = side => side === 'p1' ? 'p2' : 'p1';
const speciesTypes = new Map();
const moveTypes = new Map();
for (const [types, names] of Object.entries(data.species)) {
  for (const name of names.split(' ')) speciesTypes.set(name, types.split('/'));
}
for (const [type, names] of Object.entries(data.moves)) {
  for (const name of names.split(' ')) moveTypes.set(name, type);
}
const priority = ids(data.priority);
const stableDamage = ids(data.stableDamage);
const typeChart = new Map(Object.entries(data.typeChart).map(([type, groups]) => [type, groups.map(ids)]));
const standardTier = /^\[Gen 9\] (?:OU|Ubers|Uber|UU|RU|NU|PU|ZU|LC|AG|Anything Goes|Random Battle|Random Battle \(Blitz\)|Battle Stadium Singles(?: Reg(?:ulation)? [A-Z])?|Monotype)$/i;
const recoveries = ids('recover roost slackoff milkdrink softboiled shoreup synthesis morningsun moonlight healorder');
const pivots = ids('uturn voltswitch flipturn partingshot chillyreception teleport batonpass shedtail');
const lockedMoves = ids('thrash outrage petaldance ragingfury rollout iceball uproar');
const conditional = ids('focuspunch beakblast upperhand snore falseswipe explosion selfdestruct mistyexplosion chloroblast');
const hazards = new Map([['stealthrock', 1], ['spikes', 3], ['toxicspikes', 2], ['stickyweb', 1]]);
const removal = ids('rapidspin mortalspin defog tidyup');
const scouting = ids('protect detect banefulbunker spikyshield burningbulwark kingsshield silktrap');
const setup = ids('swordsdance nastyplot calmmind dragondance quiverdance bulkup irondefense agility shiftgear tailglow growth shellsmash');
const directStatus = new Map([['toxic', 'bad poison'], ['willowisp', 'burn'], ['thunderwave', 'paralysis']]);
const typeChangingAbilities = ids('normalize refrigerate galvanize aerilate pixilate liquidvoice');
const absorbs = new Map(Object.entries({
  flashfire: 'Fire', wellbakedbody: 'Fire', waterabsorb: 'Water', stormdrain: 'Water', dryskin: 'Water',
  lightningrod: 'Electric', voltabsorb: 'Electric', motordrive: 'Electric', eartheater: 'Ground',
  levitate: 'Ground', sapsipper: 'Grass',
}));
const labels = ['', 'Repeated immunity', 'Switch-dependent', 'Playable line', 'Sound choice', 'Strong choice'];
const fieldChanges = new Set(['-weather', '-fieldstart', '-fieldend', '-sidestart', '-sideend', '-swapsideconditions',
  '-boost', '-unboost', '-clearboost', '-clearallboost', '-setboost', '-invertboost', '-swapboost', '-copyboost',
  '-clearpositiveboost', '-clearnegativeboost', '-item', '-enditem', '-ability', '-endability', '-formechange',
  'detailschange', '-transform', '-start', '-end', '-terastallize', '-status', '-curestatus', '-cureteam']);
const errorMessages = {
  'invalid-replay': 'The battle log could not be read.',
  'incomplete-replay': 'The battle must finish before it can be reviewed.',
  'review-limit': 'The battle log exceeds the review limits.',
};
function reject(code) {
  const error = new Error(errorMessages[code]);
  error.code = code;
  throw error;
}
function clean(value, max = 68) {
  return (value || '').slice(0, max * 2).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>|]/g, '').trim().slice(0, max);
}
function slot(value) {
  const match = /^(p[12])a?: /.exec(value || '');
  return match ? match[1] : null;
}
function health(value) {
  if (/^0(?:\s|$)/.test(value)) return 0;
  const match = /^(\d{1,5})\/(\d{1,5})(?:[gry]?\s|[gry]?$)/.exec(value || '');
  if (!match || +match[2] === 0 || +match[1] > +match[2]) return null;
  return Math.round(+match[1] * 100 / +match[2]);
}
function pokemon(details, hpString) {
  const name = clean((details || '').split(',')[0]) || 'Unknown Pokémon';
  const tera = /, tera:([A-Za-z]+)/.exec(details || '');
  const types = tera && tera[1] !== 'Stellar' ? [tera[1]] : speciesTypes.get(id(name));
  const status = /\s(brn|par|tox|psn|slp|frz)(?:\s|$)/.exec(hpString || '')?.[1] || '';
  return { name, types, hp: health(hpString), status, ability: '', item: '', lastMove: '',
    encore: false, prepared: '', revealed: new Map(), tera: Boolean(tera) };
}
function position(mon) {
  return mon.hp === null ? mon.name : `${mon.name} (${mon.hp}%)`;
}
function effectiveness(type, types) {
  if (!typeChart.has(type) || !types?.length) return null;
  const [weak, resist, immune] = typeChart.get(type);
  let factor = 1;
  for (const defense of types) {
    if (!typeChart.has(defense)) return null;
    if (immune.has(defense)) return 0;
    if (weak.has(defense)) factor *= 2;
    if (resist.has(defense)) factor /= 2;
  }
  return factor;
}
function hazardName(value) {
  return id((value || '').replace(/^move:\s*/i, ''));
}
function snapshot(state) {
  const active = {};
  for (const side of SIDES) {
    const mon = state.active[side];
    active[side] = { ...mon, revealed: new Map(mon.revealed) };
  }
  return { active, hazards: { p1: new Map(state.hazards.p1), p2: new Map(state.hazards.p2) },
    prior: new Map(state.prior), remaining: { ...state.remaining }, field: new Set(state.field),
    useTypes: state.useTypes };
}
function judgement(stars, before, lesson, label = labels[stars]) {
  return { stars, label, before, lesson };
}
function typeLine(type, target, scene) {
  if (!scene.useTypes || !type || !target.types || absorbs.get(target.ability) === type || target.barriers?.has(type) ||
      (type === 'Ground' && target.item === 'airballoon')) return null;
  return effectiveness(type, target.types);
}
function assessMove(side, action, scene) {
  const foe = opponent(side);
  const actor = scene.active[side];
  const target = scene.active[foe];
  const key = action.key;
  const against = position(target);
  const opening = `${position(actor)} faced ${against}.`;
  if (action.forced) return judgement(null, opening, 'The replay does not establish a free move choice here.', 'Forced or called move');
  if (action.called) return judgement(null, opening, 'The called move is resolved separately from the move that called it.', 'Called move');
  if (recoveries.has(key) && actor.hp !== null) {
    const threat = [...scene.prior.values()].find(record => record.side === foe && record.damage >= actor.hp && stableDamage.has(record.key));
    if (threat) return judgement(null, `${actor.name} had ${actor.hp}% HP. ${target.name}’s ${threat.name} had already dealt about ${threat.damage}% in this matchup.`,
      'Recovery requires surviving until the heal resolves. Consider the observed move order and a repeat of that attack.', 'Recovery under pressure');
    if (actor.hp <= 50) return judgement(4, `${actor.name} started at ${actor.hp}% and could use a substantial heal.`,
      'Restoring HP could preserve another switch-in. Compare that benefit with the chance of being knocked out before moving.');
    if (actor.hp >= 95) return judgement(null, `${actor.name} started at ${actor.hp}%.`,
      'Healing here depends on taking damage before the move resolves. Compare the move order and the opponent’s other options.', 'Timing-dependent');
    if (actor.hp <= 75) return judgement(3, `${actor.name} was missing ${100 - actor.hp}% of its HP before moving.`,
      'Recovering could improve its next matchup. Check whether giving the opponent a turn was affordable at this health.');
  }
  if (directStatus.has(key) && scene.useTypes && target.types) {
    if (target.status) return judgement(2, `${target.name} already had a major status at the start of the turn.`,
      `${action.name} could target an incoming replacement. The active target would first need to lose its existing status.`);
    const protectedType = key === 'toxic' ? ['Poison', 'Steel'] : key === 'willowisp' ? ['Fire'] : ['Ground', 'Electric'];
    if (!target.types.some(type => protectedType.includes(type)) && !target.substitute && !scene.field.has('mistyterrain')) {
      return judgement(3, `${target.name} began without a major status, and its visible typing allowed ${directStatus.get(key)}.`,
        'Status offered lasting value if the target stayed. A switch, protection, an item or an ability could absorb the attempt.');
    }
  }
  if (scouting.has(key)) {
    if (actor.protectedTurn === scene.number - 1) return judgement(2, `${actor.name} successfully protected itself last turn.`,
      'Consecutive protection can fail. Consider whether another protected turn was worth that risk.', 'Protection risk');
    if (['brn', 'psn', 'tox'].includes(target.status)) return judgement(4, `${target.name} was already burned or poisoned.`,
      'Protection can buy a residual-damage turn against an attack. The opponent could also switch or set up.');
    return judgement(null, opening, 'Protection can scout an attack. Check what its reveal would change about the next choice and what a free setup turn would cost.', 'Scouting choice');
  }
  const layers = scene.hazards[foe].get(key) || 0;
  if (hazards.has(key) && scene.remaining[foe] > 1) {
    if (layers >= hazards.get(key)) return judgement(2, `The opposing side already had the maximum layers of ${action.name}.`,
      'Another layer needs the hazard to be cleared first. Check whether an immediate clear was worth anticipating.');
    return judgement(4, `The opposing side had ${layers} of ${hazards.get(key)} possible layers of ${action.name} and could still switch.`,
      'The hazard can tax future entries. Weigh those switches against the attack or setup turn the opponent could take now.');
  }
  if (removal.has(key) && scene.hazards[side].size && scene.remaining[side] > 1) {
    const ignoresAbility = ['moldbreaker', 'teravolt', 'turboblaze', 'myceliummight'].includes(actor.ability);
    const scrappy = ['scrappy', 'mindseye'].includes(actor.ability);
    const blocked = (key === 'rapidspin' && !scrappy && target.types?.includes('Ghost')) ||
      (key === 'mortalspin' && target.types?.includes('Steel')) || (key === 'defog' && !ignoresAbility && target.ability === 'goodasgold') ||
      scene.prior.get(side + key)?.immune;
    if (blocked) return judgement(2, `Entry hazards were present, but ${target.name} showed a barrier to ${action.name}.`,
      'The hazard clear depends on the opponent switching or losing the barrier. Check a direct attack or a different route to clearing.', 'Blocked removal');
    return judgement(4, `Entry hazards were already on ${actor.name}’s side, with teammates left to switch in.`,
      'Clearing the field can preserve teammates on later entries. Check possible blockers and any opposing hazards Defog would also remove.');
  }
  const past = scene.prior.get(side + key);
  if (past?.immune) {
    const alternative = [...scene.prior.values()].find(record => record.side === side && record.damage >= 15);
    const stars = alternative && past.immune >= 2 ? 1 : 2;
    return judgement(stars, `${action.name} had already met an immunity against ${target.name} on turn ${past.turn}.`,
      alternative ? `${alternative.name} had dealt damage in this matchup. Repeating ${action.name} relies on a switch or a change to the immunity.` :
        'This choice can catch a switch. If the same target stays and the immunity holds, the move gives up its immediate effect.');
  }
  if (past?.damage >= 20 && target.hp !== null && stableDamage.has(key) && !conditional.has(key)) {
    const inRange = target.hp <= Math.floor(past.damage * 0.8);
    return judgement(inRange ? 5 : 4, `${action.name} previously took about ${past.damage}% from ${target.name} on turn ${past.turn}. The target started this turn at ${target.hp}%.`,
      inRange ? 'The earlier hit put a knockout within reach if the target stayed. Damage variation, protection and switches could still change it.' :
        'The earlier hit supports attacking again if the target stays. Consider what the opponent could switch in.');
  }
  const type = moveTypes.get(key);
  const factor = typeLine(type, target, scene);
  const ignoresAbility = ['moldbreaker', 'teravolt', 'turboblaze'].includes(actor.ability) ||
    ['sunsteelstrike', 'moongeistbeam', 'photongeyser', 'gmaxdrumsolo', 'gmaxfireball', 'gmaxhydrosnipe'].includes(key);
  if (type && !ignoresAbility && !typeChangingAbilities.has(actor.ability) && absorbs.get(target.ability) === type) {
    return judgement(2, `${target.name} had already revealed an ability that blocks ${type} attacks.`,
      'This coverage can catch a switch. Against the active target, the known ability would first have to be bypassed or lost.', 'Revealed immunity');
  }
  if (['waterspout', 'eruption', 'dragonenergy'].includes(key) && actor.hp !== null && actor.hp < 50) {
    return judgement(null, `${actor.name} started at ${actor.hp}%. ${action.name} loses power as its user loses HP.`,
      'Compare the weakened attack with alternatives. An earlier hit from higher HP is a poor guide to the current damage.', 'HP-dependent power');
  }
  if (conditional.has(key) || typeChangingAbilities.has(actor.ability)) return judgement(null, opening,
    'The move depends on conditions that a type comparison alone cannot settle.', 'Context-dependent');
  if (factor > 0 && priority.has(key) && target.hp !== null && target.hp <= 16 &&
      !scene.field.has('psychicterrain') && !['armortail', 'dazzling', 'queenlymajesty'].includes(target.ability)) {
    return judgement(4, `${target.name} was at ${target.hp}%, and ${action.name} has increased priority.`,
      'Priority offered a way to threaten the weakened target before a normal attack. The exact knockout range and an opposing switch remain open.');
  }
  if (factor > 1) return judgement(4, `${action.name}’s ${type} typing threatened ${target.name}’s visible ${target.types.join('/')} typing.`,
    'Attacking this weakness was a sound line if the target stayed. A switch, a defensive ability or Terastallization could change the matchup.');
  if (factor !== null && factor < 1 && !pivots.has(key)) {
    const other = [...actor.revealed].find(([known]) => typeLine(moveTypes.get(known), target, scene) > 1 && !conditional.has(known));
    if (other) return judgement(factor === 0 ? 2 : 3, `${target.name}’s visible typing ${factor === 0 ? 'was immune to' : 'resisted'} ${action.name}. ${actor.name} had also shown ${other[1].name}, which targeted a weakness.`,
      'Compare the two lines if the target stays. A predicted switch, a secondary effect, PP or a move lock can favor different coverage.', 'Coverage trade-off');
  }
  if (factor === 1 && actor.types?.includes(type) && target.hp !== null && target.hp <= 40) {
    return judgement(3, `${target.name} was at ${target.hp}%. ${action.name} matched ${actor.name}’s visible typing and hit the target’s typing neutrally.`,
      'A neutral same-type attack offered direct pressure. The visible HP alone cannot guarantee the knockout.');
  }
  if (pivots.has(key) && scene.remaining[side] > 1) return judgement(3, `${actor.name} had a teammate available to bring in with ${action.name}.`,
    'Pivoting can preserve initiative. Its value depends on the replacement matchup and whether the move can complete.');
  if (setup.has(key)) return judgement(null, opening, 'Setup trades this turn for a stronger next one. Check whether the opponent had already shown an attack, phazing move or status that could interrupt that plan.', 'Setup choice');
  if (key === 'knockoff') return judgement(null, opening, 'Removing an item can justify modest immediate damage. Check what was already known about the possible switch-ins and their items.', 'Item pressure');
  return judgement(null, opening,
    'Compare the line against a stay and a switch. The public record does not establish which alternative was preferable.', 'Context-dependent');
}
function assessSwitch(side, incoming, scene) {
  const outgoing = scene.active[side];
  const enemy = scene.active[opponent(side)];
  const layers = scene.hazards[side];
  const rock = layers.has('stealthrock') ? 12.5 * (effectiveness('Rock', incoming.types) ?? 4) : 0;
  const grounded = scene.field.has('gravity') || !incoming.types?.includes('Flying');
  const spikes = grounded ? [0, 12.5, 100 / 6, 25][layers.get('spikes') || 0] : 0;
  if (rock + spikes > 0 && incoming.hp !== null && incoming.hp <= Math.ceil(rock + spikes)) {
    return judgement(null, `${incoming.name} had ${incoming.hp}% HP with damaging entry hazards on its side.`,
      'The incoming Pokémon could faint on entry unless an item, ability or field effect protects it. Check that cost before weighing the matchup.', 'Entry hazard risk');
  }
  const previous = enemy.revealed.get(enemy.lastMove);
  const type = moveTypes.get(enemy.lastMove);
  const outgoingFactor = effectiveness(type, outgoing.types);
  const matched = scene.useTypes && type && previous && !typeChangingAbilities.has(enemy.ability) &&
    !scene.field.has('gravity') && outgoingFactor > 0 &&
    absorbs.get(outgoing.ability) !== type && !(type === 'Ground' && outgoing.item === 'airballoon');
  const into = matched ? effectiveness(type, incoming.types) : null;
  if (into !== null && into < 1 && into < outgoingFactor) return judgement(into === 0 ? 5 : 4,
    `${enemy.name} had shown ${previous.name} on turn ${previous.turn}. ${incoming.name}’s visible typing offered ${into === 0 ? 'an immunity' : 'a resistance'} to its ${type} typing.`,
    'The switch covered a repeat of that attack. A different move or a double switch could punish the same choice.');
  return judgement(null, `${position(outgoing)} faced ${position(enemy)}.`,
    'Compare what the outgoing Pokémon still needed to cover with the attacks the incoming Pokémon could take.', 'Positional choice');
}

function decide(turn, side, action, assessment) {
  if (turn.rows[side]) return;
  turn.rows[side] = { turn: turn.number, action: action.title, ...assessment, outcome: '', decision: action.decision };
}
function record(turn, side, event) {
  if (!side || !turn || turn.events[side].length >= 4) return;
  if (!turn.events[side].includes(event)) turn.events[side].push(event);
}
function opening(number, state, priorTurn) {
  if (number !== priorTurn + 1 || number > 1000) reject(number > 1000 ? 'review-limit' : 'invalid-replay');
  return { number, scene: { ...snapshot(state), number }, rows: {}, events: { p1: [], p2: [] }, luck: new Set(),
    moves: 0, upkeep: false, tera: {}, current: null };
}
function finish(turn, report) {
  if (!turn) return;
  const luck = [...turn.luck].join(' ');
  for (const side of SIDES) {
    const row = turn.rows[side] || { turn: turn.number, action: 'No recorded choice', label: 'No decision shown',
      stars: null, before: `${position(turn.scene.active[side])} faced ${position(turn.scene.active[opponent(side)])}.`,
      lesson: 'The log does not show a move or voluntary switch to judge.', decision: false };
    if (turn.tera[side]) row.action = `${row.action} · Tera ${turn.tera[side]}`;
    row.outcome = turn.events[side].join(' ') || 'No further effect on this choice was recorded.';
    if (luck) row.luck = luck;
    report.sides[side].turns.push(row);
  }
}
function gameSummary(report, side, result) {
  const duration = `${report.turnCount} ${report.turnCount === 1 ? 'turn' : 'turns'}`;
  const ending = report.winner ? `${report.winner} won in ${duration}.` : `The battle ended in a tie after ${duration}.`;
  const visible = result.turns.filter(row => row.decision);
  if (!visible.length) return `${ending} The replay shows no move or voluntary switch for ${report.players[side]}.`;
  function weight(row) {
    if (row.stars !== null && row.stars <= 2) return 7;
    if (row.stars === 5) return 6;
    if (row.outcome.includes('fainted.')) return 5;
    if (row.stars === 4) return 4;
    if (row.outcome.includes('was set.') || row.outcome.includes('was cleared.')) return 3;
    return row.stars === null ? 1 : 2;
  }
  const early = visible.filter(row => row.turn <= Math.ceil(report.turnCount / 2));
  const late = visible.filter(row => row.turn > Math.ceil(report.turnCount / 2));
  const chosen = [early, late].filter(group => group.length)
    .map(group => group.sort((left, right) => weight(right) - weight(left) || left.turn - right.turn)[0]);
  const moments = chosen.map(row => {
    const action = row.action.startsWith('Switch to ') ? `${report.players[side]} switched to ${row.action.slice(10)}` : row.action;
    const event = row.outcome.split('. ').find(text => /fell to|fainted|was set|was cleared|was immune|failed to apply|recovered to|was affected/.test(text));
    const effect = event ? `, and ${event.replace(/\.$/, '')}` : '';
    return `On turn ${row.turn}, ${action}${effect}.`;
  });
  return [ending, ...moments].join(' ');
}
function summarize(report) {
  for (const side of SIDES) {
    const result = report.sides[side];
    const rated = result.turns.filter(row => row.stars !== null);
    result.rated = rated.length;
    result.decisions = result.turns.filter(row => row.decision).length;
    result.stars = rated.length >= 3 ? Math.round(rated.reduce((sum, row) => sum + row.stars, 0) / rated.length * 2) / 2 : null;
    result.summary = report.supported ? gameSummary(report, side, result) : report.scope;
    result.ratingNote = result.stars === null ? 'Three graded turns are needed for an overall rating.' :
      `The rating averages ${result.rated} of ${result.decisions} visible choices.`;
    const candidates = [...rated].sort((a, b) => a.stars - b.stars || a.turn - b.turn);
    const selected = [];
    if (candidates[0]?.stars <= 2) selected.push(candidates[0]);
    const strongest = [...candidates].sort((a, b) => b.stars - a.stars || a.turn - b.turn);
    for (const row of strongest) {
      if (selected.length === 3) break;
      if (!selected.some(previous => previous.action === row.action)) selected.push(row);
    }
    if (selected.length === 0) {
      const example = result.turns.find(row => row.decision);
      if (example) selected.push(example);
    }
    result.highlights = selected.sort((a, b) => a.turn - b.turn)
      .map(row => ({ turn: row.turn, text: `${row.action}. ${row.before}` }));
  }
  return report;
}

function switchIn(state, turn, cmd, args) {
  const side = slot(args[0]);
  if (!side) return;
  const incoming = pokemon(args[1], args[2]);
  incoming.barriers = new Set(state.barriers[side].get(incoming.name));
  if (turn) {
    const forced = cmd !== 'switch' || turn.upkeep || turn.moves > 0 || state.active[side].hp === 0 ||
      turn.scene.active[side].hp === 0 || args.slice(3).some(arg => arg.startsWith('[from]'));
    if (!forced) {
      decide(turn, side, { title: `Switch to ${incoming.name}`, decision: true }, assessSwitch(side, incoming, turn.scene));
      record(turn, opponent(side), `The opponent switched ${state.active[side].name} out for ${incoming.name}.`);
    } else if (!turn.rows[side] && cmd !== 'replace') {
      decide(turn, side, { title: `${incoming.name} entered`, decision: false },
        judgement(null, 'The active Pokémon changed after an effect or a faint.',
          'This entry does not establish a voluntary switch at the start of the turn.', 'Replacement'));
    }
    const entry = cmd === 'replace' ? `Illusion revealed ${incoming.name}.` : `${position(incoming)} entered the field.`;
    record(turn, side, entry);
    turn.current = null;
  }
  state.active[side] = incoming;
  state.prior.clear();
}
function useMove(state, turn, args) {
  const side = slot(args[0]);
  if (!side) return;
  const mon = state.active[side];
  const name = clean(args[1], 54);
  const key = id(name);
  const called = args.slice(3).some(tag => /^\[from\]/i.test(tag));
  const wasForced = key === 'struggle' || mon.encore || turn.scene.active[side].encore || mon.prepared === key ||
    (mon.lastMove === key && (lockedMoves.has(key) || ['choiceband', 'choicescarf', 'choicespecs'].includes(mon.item)));
  turn.moves++;
  const targetSide = slot(args[2]);
  const action = { name, key, called, forced: wasForced, side, targetSide, crit: false, damage: 0 };
  turn.current = action;
  decide(turn, side, { title: `${mon.name} used ${name}`, decision: !called && !wasForced },
    assessMove(side, action, turn.scene));
  if (!called && mon.revealed.size < 32) mon.revealed.set(key, { name, turn: turn.number });
  mon.lastMove = key;
  mon.prepared = '';
  if (args.includes('[miss]')) miss(turn, state, side);
}
function miss(turn, state, side) {
  const text = `${state.active[side].name}’s move missed.`;
  if (turn.luck.size < 4) turn.luck.add(text);
  record(turn, side, text);
}
function healthChange(state, turn, cmd, args, side) {
  if (!side) return;
  const mon = state.active[side];
  const before = mon.hp;
  mon.hp = health(args[1]);
  if (!turn || mon.hp === null) return;
  const move = turn.current;
  const source = args.slice(2).find(arg => arg.startsWith('[from]'));
  if (cmd === '-heal') {
    if (!source) record(turn, move?.side || side, `${mon.name} recovered to ${mon.hp}%.`);
  } else if (cmd === '-damage' && !source && move && move.targetSide === side && move.side !== side) {
    record(turn, move.side, `${mon.name} fell to ${mon.hp}%.`);
    if (turn.rows[side]) record(turn, side, `${move.name} brought ${mon.name} to ${mon.hp}%.`);
    if (before !== null && !move.crit && !move.called && before > mon.hp) {
      move.damage += before - mon.hp;
      if (state.prior.size < 64) state.prior.set(move.side + move.key,
        { side: move.side, key: move.key, name: move.name, damage: move.damage, turn: turn.number });
    }
  } else if (cmd === '-damage' && source && hazards.has(hazardName(source.replace('[from] ', '')))) {
    record(turn, side, `Entry hazards brought ${mon.name} to ${mon.hp}%.`);
  }
}
function updateConditions(state, turn, cmd, args, side) {
  const effect = hazardName(args[1]);
  const mon = state.active[side];
  if (cmd === '-sidestart' || cmd === '-sideend') {
    if (!side || !hazards.has(effect)) return;
    if (cmd === '-sideend') state.hazards[side].delete(effect);
    else state.hazards[side].set(effect, Math.min((state.hazards[side].get(effect) || 0) + 1, hazards.get(effect)));
    record(turn, turn?.current?.side, `${clean(args[1]).replace(/^move: /, '')} ${cmd === '-sideend' ? 'was cleared' : 'was set'}.`);
  } else if (cmd === '-swapsideconditions') {
    [state.hazards.p1, state.hazards.p2] = [state.hazards.p2, state.hazards.p1];
  } else if (cmd === '-fieldstart' || cmd === '-fieldend') {
    const field = hazardName(args[0]);
    if (cmd === '-fieldend') state.field.delete(field);
    else if (state.field.size < 32) state.field.add(field);
  } else if (!mon) {
    return;
  } else if (cmd === '-terastallize') {
    if (args[1] !== 'Stellar') mon.types = typeChart.has(args[1]) ? [args[1]] : null;
    mon.tera = true;
    if (turn) {
      turn.tera[side] = clean(args[1], 16);
      record(turn, opponent(side), `${mon.name} Terastallized into the ${turn.tera[side]} type.`);
    }
  } else if (cmd === '-formechange' || cmd === 'detailschange') {
    const changed = pokemon(args[1], '');
    mon.name = changed.name;
    if (!mon.tera) mon.types = changed.types;
  } else if (cmd === '-transform') {
    mon.types = null;
    mon.revealed.clear();
  } else if (cmd === '-start' || cmd === '-end') {
    if (effect === 'encore') mon.encore = cmd === '-start';
    if (effect === 'substitute') mon.substitute = cmd === '-start';
    if (effect === 'typechange' || effect === 'typeadd') mon.types = null;
  } else if (cmd === '-prepare') {
    mon.prepared = effect;
  } else if (cmd === '-singleturn' && scouting.has(effect)) {
    mon.protectedTurn = turn?.number;
  } else if (cmd === '-ability' || cmd === '-endability') {
    mon.ability = cmd === '-ability' ? id(args[1] || '') : '';
  } else if (cmd === '-item' || cmd === '-enditem') {
    mon.item = cmd === '-item' ? id(args[1] || '') : '';
  } else if (cmd === '-status') {
    mon.status = args[1] || '';
  } else if (cmd === '-curestatus' || cmd === '-cureteam') {
    mon.status = '';
  }
}
function minor(state, turn, cmd, args) {
  const side = slot(args[0]);
  if (/^p[12]: /.test(args[0] || '') && side && !['-sidestart', '-sideend', '-cureteam'].includes(cmd)) {
    // A benched Pokémon has no position letter. Its HP and status do not belong to the active slot.
    if (cmd === '-heal' && args.includes('[from] move: Revival Blessing') && state.remaining[side] !== null) {
      state.remaining[side]++;
      record(turn, side, 'Revival Blessing restored a benched teammate.');
    }
    return;
  }
  const move = turn?.current;
  if (fieldChanges.has(cmd) && !args.includes('[upkeep]')) state.prior.clear();
  const revealed = args.find(tag => tag.startsWith('[from] ability: '));
  if (revealed) {
    const ownerToken = args.find(tag => tag.startsWith('[of] '));
    const owner = ownerToken ? slot(ownerToken.slice(5)) : side;
    if (owner) {
      const mon = state.active[owner];
      const ability = id(revealed.slice('[from] ability: '.length));
      if (mon.ability !== ability) state.prior.clear();
      mon.ability = ability;
      const immunity = absorbs.get(ability);
      if (immunity && state.barriers[owner].size < 32) {
        const known = new Set(state.barriers[owner].get(mon.name));
        known.add(immunity);
        state.barriers[owner].set(mon.name, known);
        mon.barriers = known;
      }
    }
  }
  if (cmd === '-damage' || cmd === '-heal' || cmd === '-sethp') {
    healthChange(state, turn, cmd, args, side);
    if (cmd === '-sethp' && slot(args[2])) healthChange(state, turn, cmd, args.slice(2), slot(args[2]));
    return;
  }
  updateConditions(state, turn, cmd, args, side);
  if (!turn) return;
  const name = state.active[side]?.name;
  if (cmd === '-miss' && (side || move?.side)) {
    miss(turn, state, side || move.side);
  } else if (cmd === '-crit' && side) {
    if (move) move.crit = true;
    if (turn.luck.size < 4) turn.luck.add(`A critical hit landed on ${name}.`);
  } else if (cmd === '-immune' && move && move.targetSide === side && move.side !== side && !args.some(tag => /\[from\] (?:psn|brn|confusion|tox)/i.test(tag))) {
    record(turn, move.side, `${name} was immune.`);
    if (turn.rows[side]) record(turn, side, `${name} was immune to ${move.name}.`);
    if (!move.called && moveTypes.has(move.key) && state.prior.size < 64) {
      const recordKey = move.side + move.key;
      state.prior.set(recordKey, { name: move.name, side: move.side, turn: turn.number,
        immune: 1 + (state.prior.get(recordKey)?.immune || 0) });
    }
  } else if (cmd === '-fail' && move) {
    record(turn, move.side, `${move.name} failed to apply its effect.`);
  } else if ((cmd === '-supereffective' || cmd === '-resisted') && move && side) {
    record(turn, move.side, cmd === '-resisted' ? `${name} resisted the attack.` : `The attack was super effective against ${name}.`);
  } else if (cmd === '-status' && side && move && !args.some(tag => tag.startsWith('[from]'))) {
    const status = { par: 'paralysis', brn: 'burn', tox: 'bad poison', psn: 'poison', slp: 'sleep', frz: 'freeze' }[args[1]];
    if (typeof status === 'string') record(turn, move.side, `${name} was affected by ${status}.`);
  } else if (cmd === '-boost' && side && move && move.side === side && !args.some(tag => tag.startsWith('[from]'))) {
    record(turn, side, `${name} raised its stats.`);
  } else if (cmd === '-activate' && effectIsProtect(args[1]) && move && side && side !== move.side) {
    record(turn, move.side, `${name} protected itself.`);
  }
}
function effectIsProtect(effect) {
  return ['protect', 'spikyshield', 'kingsshield', 'banefulbunker', 'silktrap', 'burningbulwark', 'detect']
    .includes(hazardName(effect));
}
function cannotMove(state, turn, args) {
  const side = slot(args[0]);
  if (!side) return;
  const name = state.active[side].name;
  const reason = { par: 'full paralysis', flinch: 'a flinch', slp: 'sleep', frz: 'freeze', recharge: 'recharge',
    'move: Taunt': 'Taunt', 'ability: Truant': 'Truant' }[args[1]];
  const text = typeof reason === 'string' ? `${name} could not move due to ${reason}.` : `${name} could not move.`;
  if (['par', 'flinch', 'frz'].includes(args[1]) && turn.luck.size < 4) turn.luck.add(text);
  decide(turn, side, { title: `${name} could not move`, decision: false }, judgement(null,
    `${position(turn.scene.active[side])} began the turn on the field.`,
    'An interrupted action does not reveal enough to assess the chosen line.', 'Action interrupted'));
  record(turn, side, text);
  turn.current = null;
}

function analyzeBattle(log) {
  if (typeof log !== 'string' || !log) reject('invalid-replay');
  if (Buffer.byteLength(log) > 2 * 1024 * 1024) reject('review-limit');
  const lines = log.split('\n');
  if (lines.length > 30000) reject('review-limit');
  const players = { p1: '', p2: '' };
  const report = { format: '', players, winner: '', turnCount: 0, supported: false, scope: '',
    sides: { p1: { turns: [] }, p2: { turns: [] } } };
  const state = { active: { p1: pokemon(), p2: pokemon() }, remaining: { p1: null, p2: null }, barriers: { p1: new Map(), p2: new Map() },
    hazards: { p1: new Map(), p2: new Map() }, prior: new Map(), field: new Set(), useTypes: false };
  let gen = '';
  let gametype = '';
  let turn;
  let complete = false;
  let started = false;
  for (const raw of lines) {
    if (raw.length > 16384) reject('review-limit');
    if (raw[0] !== '|') continue;
    const [, cmd, ...args] = raw.trimEnd().split('|');
    if (cmd === 'split') reject('invalid-replay');
    if (cmd === 'win' || cmd === 'tie') {
      complete = true;
      report.winner = cmd === 'win' ? clean(args[0]) : '';
      if (cmd === 'win' && !report.winner) reject('invalid-replay');
      break;
    }
    if (!started && cmd === 'player' && SIDES.includes(args[0]) && args[1]) players[args[0]] = clean(args[1]);
    else if (!started && cmd === 'gametype') gametype = args[0];
    else if (!started && cmd === 'gen') gen = args[0];
    else if (!started && cmd === 'tier') report.format = clean(args[0], 80);
    else if (!turn && cmd === 'teamsize' && SIDES.includes(args[0]) && /^\d{1,2}$/.test(args[1])) state.remaining[args[0]] = +args[1];
    else if (cmd === 'start') {
      started = true;
      state.useTypes = standardTier.test(report.format);
    } else if (cmd === 'turn') {
      if (!started || !/^\d{1,4}$/.test(args[0])) reject('invalid-replay');
      finish(turn, report);
      turn = opening(+args[0], state, report.turnCount);
      report.turnCount = turn.number;
    } else if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
      switchIn(state, turn, cmd, args);
    } else if (cmd.startsWith('-') || cmd === 'detailschange') {
      minor(state, turn, cmd, args);
    } else if (turn) {
      const side = slot(args[0]);
      if (cmd === 'move') useMove(state, turn, args);
      else if (cmd === 'cant') cannotMove(state, turn, args);
      else if (cmd === 'faint' && side) {
        state.active[side].hp = 0;
        if (state.remaining[side] !== null) state.remaining[side] = Math.max(0, state.remaining[side] - 1);
        record(turn, turn.current?.targetSide === side ? turn.current.side : side, `${state.active[side].name} fainted.`);
      } else if (cmd === 'upkeep' || cmd === '') {
        if (cmd === 'upkeep') turn.upkeep = true;
        turn.current = null;
      }
    }
  }
  if (!complete) reject('incomplete-replay');
  if (!players.p1 || !players.p2 || !gen || !gametype || !report.format) reject('invalid-replay');
  report.supported = gen === '9' && gametype === 'singles' && standardTier.test(report.format);
  report.scope = report.supported ? 'Standard Gen 9 singles · public turn-by-turn review' :
    'Turn ratings cover recognized standard Gen 9 singles formats, including OU, Anything Goes and Random Battle. This format is outside that scope.';
  if (report.supported) finish(turn, report);
  else for (const side of SIDES) report.sides[side].turns = [];
  return summarize(report);
}

module.exports = { analyzeBattle };
