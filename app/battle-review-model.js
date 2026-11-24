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
const { compareAttacks, ordinaryFactor, abilities, abilityImmunities } = require('./battle-review-comparisons');
const typeChart = new Set(Object.keys(data.typeChart));
const standardTier = /^\[Gen 9\] (?:OU|Ubers|Uber|UU|RU|NU|PU|ZU|LC|AG|Anything Goes|Random Battle|Random Battle \(Blitz\)|Battle Stadium Singles(?: Reg(?:ulation)? [A-Z])?|Monotype)$/i;
const recoveries = ids('recover roost slackoff milkdrink softboiled shoreup synthesis morningsun moonlight healorder');
const pivots = ids('uturn voltswitch flipturn partingshot chillyreception teleport batonpass shedtail');
const hazards = new Map([['stealthrock', 1], ['spikes', 3], ['toxicspikes', 2], ['stickyweb', 1]]);
const removal = ids('rapidspin mortalspin defog tidyup');
const scouting = ids('protect detect banefulbunker spikyshield burningbulwark kingsshield silktrap');
const setup = ids('swordsdance nastyplot calmmind dragondance quiverdance bulkup irondefense agility shiftgear tailglow growth shellsmash');
const directStatus = new Map([['toxic', 'bad poison'], ['willowisp', 'burn'], ['thunderwave', 'paralysis']]);
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
  if (+match[1] === +match[2]) return 100;
  return Math.min(99, Math.ceil(+match[1] * 100 / +match[2]));
}
function pokemon(details, hpString) {
  const name = clean((details || '').split(',')[0]) || 'Unknown Pokémon';
  const tera = /, tera:([A-Za-z]+)/.exec(details || '');
  const baseTypes = speciesTypes.get(id(name));
  const types = tera && tera[1] !== 'Stellar' ? [tera[1]] : baseTypes;
  const status = /\s(brn|par|tox|psn|slp|frz)(?:\s|$)/.exec(hpString || '')?.[1] || '';
  return { name, baseTypes, types, hp: health(hpString), status, ability: '', nativeAbility: '', item: '', itemKnown: false,
    lastMove: '', choiceLock: '', encore: false, prepared: '', revealed: new Map(), tera: Boolean(tera),
    teraType: tera?.[1] || '', boosts: {}, volatile: new Set(), ppDrained: new Set() };
}
function position(mon) {
  return mon.hp === null ? mon.name : `${mon.name} (${displayHP(mon.hp)})`;
}
function displayHP(hp) {
  return (hp > 0 && hp < 100 ? '≈' : '') + hp + '%';
}
function hazardName(value) {
  return id((value || '').replace(/^move:\s*/i, ''));
}
function snapshot(state) {
  const active = {};
  for (const side of SIDES) {
    const mon = state.active[side];
    active[side] = { ...mon, boosts: { ...mon.boosts }, volatile: new Set(mon.volatile),
      ppDrained: new Set(mon.ppDrained), revealed: new Map(mon.revealed) };
    if (mon.abilitySuppressed || (state.active[opponent(side)].ability === 'neutralizinggas' &&
        !state.active[opponent(side)].abilitySuppressed && mon.item !== 'abilityshield')) {
      active[side].abilitySuppressed = true;
      active[side].ability = '';
    }
    if (state.field.has('magicroom') || mon.volatile.has('embargo') || active[side].ability === 'klutz') active[side].item = '';
  }
  return { active, hazards: { p1: new Map(state.hazards.p1), p2: new Map(state.hazards.p2) },
    screens: { p1: new Set(state.screens.p1), p2: new Set(state.screens.p2) },
    prior: new Map(state.prior), remaining: { ...state.remaining }, field: new Set(state.field),
    useTypes: state.useTypes };
}
function judgement(stars, before, lesson, label) {
  return { stars, label, before, lesson };
}
function assessMove(side, action, scene) {
  const foe = opponent(side);
  const actor = scene.active[side];
  const target = scene.active[foe];
  const { key, name } = action;
  const opening = position(actor) + ' faced ' + position(target) + '.';
  const note = (label, lesson, fact = opening) => judgement(null, fact, lesson, label);
  if (action.called) return note('Called move', 'This effect used a move on the Pokémon’s behalf.');
  if (action.forced) return note('Move constrained', 'The log does not establish a free choice of move here.');
  if (action.teraType) return note('Tera decision', 'Consider both the move and spending Terastallization here. The move comparison does not price the defensive change or the value of keeping Tera.',
    opening + ' ' + actor.name + ' committed to Tera ' + action.teraType + ' with this choice.');

  const pair = compareAttacks(side, action, scene);
  if (pair) {
    const high = pair.better ? name : pair.alternative;
    const low = pair.better ? pair.alternative : name;
    const prior = actor.name + ' had shown ' + pair.alternative + ' on turn ' + pair.turn + '.';
    const reason = pair.kind === 'immunity'
      ? low + ' faced an immunity in the opening matchup. ' + high + ' had a route to direct damage under the visible conditions.'
      : name + ' has ' + pair.selectedPower + ' base power and ' + pair.alternative + ' has ' + pair.otherPower +
        '. Both have the same typing and damage category. Both ' + (pair.accuracy === 'true' ? 'bypass the regular accuracy check' :
          'have ' + pair.accuracy + '% listed accuracy') + '. On a hit under the same roll, ' + high +
        ' offers at least as much direct damage. Rounding or a knockout can make them equal.';
    return { ...judgement(pair.better ? 4 : 2, opening + ' ' + prior + ' ' + reason,
      'This comparison assumes both moves can be selected and the target stays as shown. A switch prediction, remaining PP or another goal can favor a different choice.',
      pair.kind === 'power' ? (pair.better ? 'Higher base power' : 'Lower base power') :
        (pair.better ? 'Open damage route' : 'Opening immunity')), comparison: pair };
  }

  if (hazards.has(key)) {
    const layers = scene.hazards[foe].get(key) || 0;
    const advice = target.ability === 'magicbounce' ? 'The opening target had revealed Magic Bounce. It can reflect this hazard back onto the user’s side.'
      : layers === hazards.get(key) ? 'The hazard was already at its layer limit. Adding a layer would require an opposing clear first.'
      : scene.remaining[foe] === 1 ? 'Only one opposing Pokémon remained. A hazard needs a later entry to affect the battle.'
      : 'Consider how many opposing entries remain and whether the hazard could be reflected or removed.';
    return note('Hazard placement', advice,
      opening + ' The opposing side had ' + layers + ' of ' + hazards.get(key) + ' possible layers of ' + name + '.');
  }
  if (removal.has(key)) {
    const layers = [...scene.hazards[side]].map(([hazard, count]) => ({ stealthrock: 'Stealth Rock', spikes: 'Spikes',
      toxicspikes: 'Toxic Spikes', stickyweb: 'Sticky Web' })[hazard] + ' ×' + count);
    const moveType = key === 'rapidspin' ? 'Normal' : key === 'mortalspin' ? 'Poison' : '';
    const advice = ordinaryFactor(moveType, target.types) === 0
      ? name + ' needs to hit to clear hazards. The opening target’s displayed typing ordinarily blocks its ' + moveType + ' damage.'
      : key === 'defog' && abilities(target).includes('goodasgold')
        ? 'Good as Gold can block Defog. Check the ability matchup before counting on a clear.'
        : 'Check whether the move could clear the field against the opening target and how much future entries would benefit.';
    return note('Hazard removal', advice,
      opening + (layers.length ? ' Hazards on the user’s side included ' + layers.join(', ') + '.' : ' The user’s side had no recorded entry hazards.'));
  }
  if (recoveries.has(key)) return note('Recovery timing',
    'Compare healing now with the risk of an attack before the heal and the turn the opponent gains for switching or setup.');
  if (scouting.has(key)) return note('Protection timing', actor.protectedTurn === scene.number - 1
    ? 'The previous protection succeeded. Consecutive uses can fail. Consider another way to spend this turn.'
    : ['psn', 'tox'].includes(target.status) && target.ability === 'poisonheal'
      ? 'The opposing Pokémon had revealed Poison Heal. Waiting a turn can let it recover HP from poison.'
      : 'What would learning the opponent’s move change next turn? Check residual effects on both sides, including abilities that heal.');
  if (directStatus.has(key)) return note('Status attempt', target.status
    ? 'The opening target already had a major status. Applying a different one would need a change of target or status.'
    : 'Consider the target’s typing, abilities, Substitute and terrain before counting on ' + directStatus.get(key) + '.');
  if (pivots.has(key)) return note('Pivot choice', 'Compare the replacement matchup with staying in. Some pivot moves need to connect before the user can switch.',
    opening + (scene.remaining[side] === 1 ? ' No other living teammate was recorded.' :
      scene.remaining[side] > 1 ? ' A living teammate remained on the user’s side.' : ''));
  if (setup.has(key)) return note('Setup choice', 'Which attack, switch or disruption could the opponent use while the boost takes effect?');
  if (key === 'knockoff') return note('Item pressure', 'Consider which held items the move could remove and which potential switch-ins would mind losing them.');
  if (priority.has(key)) return note('Priority move', 'Check opposing priority, terrain and blocking abilities before counting on moving first.');
  if (['waterspout', 'eruption', 'dragonenergy'].includes(key)) return note('HP-dependent power', name + ' loses power as its user loses HP. Move order can change its power before it resolves.');
  const type = moveTypes.get(key);
  const factor = ordinaryFactor(type, target.types);
  if (scene.useTypes && factor !== null) {
    const plausible = abilities(target);
    const possibleAbsorb = plausible.some(ability => abilityImmunities.get(ability) === type);
    const fact = ' The ordinary ' + type + ' type-chart multiplier against the displayed ' + target.types.join('/') + ' typing was ' + factor + '×.';
    return note('Attack matchup', possibleAbsorb
      ? (target.ability ? 'The target had revealed an ability' : 'The displayed species has an ability') +
        ' that can block ' + type + ' damage. Check bypass effects, items and switches.'
      : 'Check ability, item and field effects as well as switches. The type multiplier alone gives no knockout range or move ranking.', opening + fact);
  }
  return note('Context-dependent', 'Compare this line against the opponent staying in and switching. The public information does not establish a preferred alternative.');
}
function assessSwitch(side, incoming, scene) {
  const outgoing = scene.active[side];
  const enemy = scene.active[opponent(side)];
  const previous = enemy.revealed.get(enemy.lastMove);
  const opening = position(outgoing) + ' faced ' + position(enemy) + '.';
  const hazards = scene.hazards[side].size ? ' Include the entry hazards already on this side.' : '';
  const type = moveTypes.get(enemy.lastMove);
  const factor = ordinaryFactor(type, incoming.types);
  if (previous && factor !== null) {
    return judgement(null, opening + ' ' + enemy.name + ' had shown ' + previous.name + ' on turn ' + previous.turn +
      '. Against ' + incoming.name + '’s displayed typing its ordinary type-chart multiplier was ' + factor + '×.',
    'A repeat was one possible line. Compare it with other attacks, a double switch, and ability or item effects.' + hazards, 'Switch matchup');
  }
  return judgement(null, opening, 'Consider what the outgoing Pokémon still needs to cover and which moves the incoming Pokémon could face.' + hazards, 'Switch matchup');
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
    moves: 0, upkeep: false, tera: {}, incidental: {}, current: null };
}
function finish(turn, report) {
  if (!turn) return;
  const luck = [...turn.luck].join(' ');
  for (const side of SIDES) {
    const row = turn.rows[side] || { turn: turn.number, action: 'No recorded choice', label: 'No decision shown',
      stars: null, before: `${position(turn.scene.active[side])} faced ${position(turn.scene.active[opponent(side)])}.`,
      lesson: 'The log does not show a move or voluntary switch to judge.', decision: false };
    if (turn.tera[side]) {
      row.action = `${row.action} · Tera ${turn.tera[side]}`;
      row.decision = true;
    }
    row.outcome = turn.events[side].join(' ') || 'No further effect on this choice was recorded.';
    if (luck) row.luck = luck;
    report.sides[side].turns.push(row);
  }
}
function notableEvent(row) {
  const events = row.outcome.split('. ');
  return events.find(text => text.includes('fainted')) ||
    events.find(text => /fell to|was set|was cleared|was immune|failed to apply|recovered to|was affected|raised its stats/.test(text)) || '';
}
function gameSummary(report, side, result) {
  const duration = `${report.turnCount} ${report.turnCount === 1 ? 'turn' : 'turns'}`;
  const ending = report.winner ? `${report.winner} won in ${duration}.` : `The battle ended in a tie after ${duration}.`;
  const visible = result.turns.filter(row => row.decision);
  if (!visible.length) return `${ending} The replay shows no move or voluntary switch for ${report.players[side]}.`;
  function weight(row) {
    if (row.stars !== null && row.stars <= 2) return 7;
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
    const event = notableEvent(row);
    const effect = event ? ' ' + event.replace(/\.$/, '') + '.' : '';
    return `On turn ${row.turn}, ${action}.${effect}`;
  });
  return [ending, ...moments].join(' ');
}
function summarize(report) {
  for (const side of SIDES) {
    const result = report.sides[side];
    const rated = result.turns.filter(row => row.stars !== null);
    result.rated = rated.length;
    result.decisions = result.turns.filter(row => row.decision).length;
    result.stars = null;
    result.fourStars = rated.filter(row => row.stars === 4).length;
    result.twoStars = rated.length - result.fourStars;
    result.summary = report.supported ? gameSummary(report, side, result) : report.scope;
    result.ratingNote = 'An overall play rating is unavailable. Conditional comparisons cover only selected direct attacks.';
    const candidates = [...rated].sort((a, b) => a.stars - b.stars || a.turn - b.turn);
    const selected = [];
    if (candidates[0]?.stars <= 2) selected.push(candidates[0]);
    const strongest = [...candidates].sort((a, b) => b.stars - a.stars || a.turn - b.turn);
    for (const row of strongest) {
      if (selected.length === 3) break;
      if (!selected.some(previous => previous.action === row.action)) selected.push(row);
    }
    if (selected.length < 3) {
      const visible = result.turns.filter(row => row.decision);
      const eventful = visible.filter(row => row.outcome.includes('fainted.') || row.outcome.includes('was set.') ||
        row.outcome.includes('was cleared.') || row.action.includes(' · Tera '));
      for (const example of [eventful[0], eventful.at(-1), visible[0]]) {
        if (selected.length === 3) break;
        if (example && !selected.some(row => row.action === example.action)) selected.push(example);
      }
    }
    result.highlights = selected.sort((a, b) => a.turn - b.turn).map(row => {
      const detail = row.comparison ? `Compared with ${row.comparison.alternative} from turn ${row.comparison.turn}.` : notableEvent(row);
      return { turn: row.turn, text: detail ? row.action + '. ' + detail.replace(/\.$/, '') + '.' : row.action };
    });
  }
  return report;
}

function rememberAbility(mon, ability) {
  mon.ability = ability;
  mon.abilitySuppressed = false;
  if (!mon.changedAbility) mon.nativeAbility = ability;
}
function setTemporaryAbility(mon, ability) {
  mon.changedAbility = true;
  rememberAbility(mon, ability);
}
function rememberItem(mon, item) {
  if (mon.item !== item) mon.choiceLock = '';
  mon.item = item;
  mon.itemKnown = true;
}
function teamIdentity(state, side, name) {
  // Duplicate teammates and Illusion can share the same public nickname, details and species.
  const preview = state.preview[side];
  if (!preview.length || !state.teamSize[side] || preview.length < state.teamSize[side] ||
      preview.some(species => /^(zoroark|zorua)/.test(species))) return '';
  const species = id(name);
  return preview.filter(candidate => candidate === species).length === 1 ? species : '';
}
function switchIn(state, turn, cmd, args) {
  const side = slot(args[0]);
  if (!side) return;
  const outgoing = state.active[side];
  const incoming = pokemon(args[1], args[2]);
  incoming.identity = teamIdentity(state, side, incoming.name);
  incoming.possibleIllusion = cmd !== 'replace' && state.preview[side].some(species => /^(zoroark|zorua)/.test(species));
  if (cmd !== 'replace') {
    for (const key of outgoing.revealed.keys()) {
      if (!moveTypes.has(key)) continue;
      state.pastMoves[side].add(key);
      if (!outgoing.identity) state.ambiguousPP[side].add(key);
    }
  }
  if (outgoing.identity && cmd !== 'replace') {
    state.bench[side].set(outgoing.identity, { nativeAbility: outgoing.nativeAbility,
      item: outgoing.item, itemKnown: outgoing.itemKnown, revealed: new Map(outgoing.nativeRevealed || outgoing.revealed),
      ppDrained: new Set(outgoing.ppDrained), tera: outgoing.tera, teraType: outgoing.teraType });
  }
  const known = state.bench[side].get(incoming.identity);
  if (known) {
    rememberAbility(incoming, known.nativeAbility);
    incoming.item = known.item;
    incoming.itemKnown = known.itemKnown;
    incoming.revealed = new Map(known.revealed);
    incoming.ppDrained = new Set(known.ppDrained);
  }
  if (cmd === 'replace') {
    // An Illusion reveal is the same active Pokémon. Preserve public boosts, status and move history.
    Object.assign(incoming, { boosts: outgoing.boosts, volatile: outgoing.volatile, revealed: outgoing.revealed,
      lastMove: outgoing.lastMove, prepared: outgoing.prepared, encore: outgoing.encore, substitute: outgoing.substitute,
      item: outgoing.item, itemKnown: outgoing.itemKnown, choiceLock: outgoing.choiceLock,
      protectedTurn: outgoing.protectedTurn, ppDrained: outgoing.ppDrained });
    rememberAbility(incoming, 'illusion');
  }
  const switchCause = hazardName((args.slice(3).find(tag => tag.startsWith('[from] ')) || '').slice(7));
  if (switchCause === 'batonpass' || switchCause === 'shedtail') {
    incoming.substitute = outgoing.substitute;
    if (incoming.substitute) incoming.volatile.add('substitute');
    if (switchCause === 'batonpass') {
      incoming.boosts = { ...outgoing.boosts };
      for (const effect of ['ingrain', 'aquaring', 'magnetrise', 'focusenergy', 'leechseed', 'confusion']) {
        if (outgoing.volatile.has(effect)) incoming.volatile.add(effect);
      }
    }
  }
  if (turn) {
    const forced = cmd !== 'switch' || turn.upkeep || turn.moves > 0 || outgoing.ejected || state.active[side].hp === 0 ||
      turn.scene.active[side].hp === 0 || args.slice(3).some(arg => arg.startsWith('[from]'));
    if (!forced) {
      // Entry HP and a previously unseen Tera type arrive during resolution.
      const before = { ...incoming, hp: null, status: '', tera: Boolean(known?.tera), teraType: known?.teraType || '' };
      before.types = before.tera && before.teraType !== 'Stellar' ? [before.teraType] : before.baseTypes;
      decide(turn, side, { title: `Switch to ${incoming.name}`, decision: true }, assessSwitch(side, before, turn.scene));
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
  const source = args.slice(3).find(tag => /^\[from\]/i.test(tag)) || '';
  const locked = /^\[from\]\s*(?:move:\s*)?lockedmove$/i.test(source);
  const called = Boolean(source) && !locked;
  const openingMon = turn.scene.active[side];
  const choiceItem = ['choiceband', 'choicescarf', 'choicespecs'].includes(openingMon.item);
  const wasForced = key === 'struggle' || locked || mon.encore || openingMon.encore ||
    (choiceItem && openingMon.choiceLock === key);
  turn.moves++;
  const targetSide = slot(args[2]);
  const action = { name, key, called, forced: wasForced, side, targetSide, teraType: turn.tera[side] || '', landed: false };
  turn.current = action;
  if (!called && turn.incidental[side]) {
    delete turn.rows[side];
    delete turn.incidental[side];
  }
  if (called && !turn.rows[side]) turn.incidental[side] = true;
  // Ordinary opposing attacks in singles can omit the resolved target when blocked or aborted.
  const selected = targetSide ? action : { ...action, targetSide: opponent(side) };
  decide(turn, side, { title: `${mon.name} used ${name}`, decision: !called && !wasForced },
    assessMove(side, selected, turn.scene));
  if (!called) {
    const previous = mon.revealed.get(key);
    if (key !== 'struggle' && (previous || mon.revealed.size < 32)) {
      // With an ambiguous identity an earlier stay can have used the same PP.
      const ppUncertain = Boolean(previous?.ppUncertain || mon.ppDrained.has(key) || state.ambiguousPP[side].has(key) ||
        (!mon.identity && state.pastMoves[side].has(key)));
      mon.revealed.set(key, { name, turn: turn.number, uses: (previous?.uses || 0) + 1, ppUncertain });
    }
    mon.lastMove = key;
    if (choiceItem && mon.item === openingMon.item) mon.choiceLock = key;
    mon.prepared = '';
  } else {
    const ability = /^\[from\]\s*ability:\s*(.+)$/i.exec(source);
    if (ability) rememberAbility(mon, id(ability[1]));
    record(turn, side, `${name} was called by ${clean(source.replace(/^\[from\]\s*(?:(?:ability|move):\s*)?/i, ''))}.`);
  }
  if (args.includes('[miss]')) miss(turn, state, side);
}
function miss(turn, state, side) {
  const text = `${state.active[side].name}’s move missed.`;
  record(turn, side, text);
}
function healthChange(state, turn, cmd, args, side) {
  if (!side) return;
  const mon = state.active[side];
  mon.hp = health(args[1]);
  if (!turn || mon.hp === null) return;
  const move = turn.current;
  const source = args.slice(2).find(arg => arg.startsWith('[from]'));
  if (cmd === '-heal') {
    if (!source) record(turn, move?.side || side, `${mon.name} recovered to ${displayHP(mon.hp)}.`);
  } else if (cmd === '-damage' && !source && move && move.targetSide === side && move.side !== side) {
    record(turn, move.side, `${mon.name} fell to ${displayHP(mon.hp)}.`);
    record(turn, side, `${move.name} brought ${mon.name} to ${displayHP(mon.hp)}.`);
    // A real hit can leave the displayed HP percentage unchanged.
    move.landed = true;
    state.prior.delete(move.side + move.key);
  } else if (cmd === '-damage' && source && hazards.has(hazardName(source.replace('[from] ', '')))) {
    record(turn, side, `Entry hazards brought ${mon.name} to ${displayHP(mon.hp)}.`);
  }
}
function updateBoosts(state, cmd, args, side) {
  const mon = state.active[side];
  if (cmd === '-clearallboost') {
    for (const player of SIDES) state.active[player].boosts = {};
    return;
  }
  if (!mon) return;
  const stats = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
  if (cmd === '-clearboost') {
    mon.boosts = {};
  } else if (['-swapboost', '-copyboost'].includes(cmd)) {
    const other = state.active[slot(args[1])];
    if (!other) return;
    const affected = args[2] && !args[2].startsWith('[') ? args[2].split(',').map(s => s.trim()) : stats;
    for (const stat of affected) {
      if (!stats.includes(stat)) continue;
      const previous = mon.boosts[stat] || 0;
      mon.boosts[stat] = other.boosts[stat] || 0;
      if (cmd === '-swapboost') other.boosts[stat] = previous;
    }
  } else if (cmd === '-invertboost' || cmd === '-clearpositiveboost' || cmd === '-clearnegativeboost') {
    for (const stat of stats) {
      const stage = mon.boosts[stat] || 0;
      if (cmd === '-invertboost') mon.boosts[stat] = -stage;
      else if ((cmd === '-clearpositiveboost' && stage > 0) || (cmd === '-clearnegativeboost' && stage < 0)) mon.boosts[stat] = 0;
    }
  } else if (stats.includes(args[1]) && /^-?[0-6]$/.test(args[2])) {
    const amount = Number(args[2]);
    const stage = mon.boosts[args[1]] || 0;
    mon.boosts[args[1]] = cmd === '-setboost' ? amount : Math.max(-6, Math.min(6, stage + (cmd === '-boost' ? amount : -amount)));
  }
}
function updateConditions(state, turn, cmd, args, side) {
  const effect = hazardName(args[1]);
  const mon = state.active[side];
  if (cmd.endsWith('boost')) {
    updateBoosts(state, cmd, args, side);
  } else if (cmd === '-sidestart' || cmd === '-sideend') {
    if (!side) return;
    if (!hazards.has(effect)) {
      if (cmd === '-sideend') state.screens[side].delete(effect);
      else if (state.screens[side].size < 32) state.screens[side].add(effect);
      return;
    }
    if (cmd === '-sideend') state.hazards[side].delete(effect);
    else state.hazards[side].set(effect, Math.min((state.hazards[side].get(effect) || 0) + 1, hazards.get(effect)));
    record(turn, turn?.current?.side, `${clean(args[1]).replace(/^move: /, '')} ${cmd === '-sideend' ? 'was cleared' : 'was set'}.`);
  } else if (cmd === '-swapsideconditions') {
    [state.hazards.p1, state.hazards.p2] = [state.hazards.p2, state.hazards.p1];
    [state.screens.p1, state.screens.p2] = [state.screens.p2, state.screens.p1];
  } else if (cmd === '-weather') {
    state.field.delete(state.weather);
    state.weather = args[0] === 'none' ? '' : id(clean(args[0]));
    if (state.weather) state.field.add(state.weather);
  } else if (cmd === '-fieldstart' || cmd === '-fieldend') {
    const field = hazardName(args[0]);
    if (cmd === '-fieldend') state.field.delete(field);
    else {
      const terrains = ['mistyterrain', 'grassyterrain', 'electricterrain', 'psychicterrain'];
      if (terrains.includes(field)) for (const terrain of terrains) state.field.delete(terrain);
      if (state.field.size < 32) state.field.add(field);
    }
  } else if (!mon) {
    return;
  } else if (cmd === '-terastallize') {
    if (args[1] !== 'Stellar') mon.types = typeChart.has(args[1]) ? [args[1]] : null;
    mon.tera = true;
    mon.teraType = clean(args[1], 16);
    if (turn) {
      turn.tera[side] = clean(args[1], 16);
      record(turn, opponent(side), `${mon.name} Terastallized into the ${turn.tera[side]} type.`);
    }
  } else if (cmd === '-formechange' || cmd === 'detailschange') {
    const changed = pokemon(args[1], '');
    mon.name = changed.name;
    mon.baseTypes = changed.baseTypes;
    if (!mon.tera) mon.types = changed.types;
    setTemporaryAbility(mon, '');
  } else if (cmd === '-transform') {
    const target = state.active[slot(args[1])];
    mon.nativeRevealed ||= new Map(mon.revealed);
    mon.revealed = new Map();
    mon.transformed = true;
    mon.baseTypes = null;
    if (!mon.tera) mon.types = target?.tera ? null : target?.types;
    mon.boosts = { ...target?.boosts };
    setTemporaryAbility(mon, '');
  } else if (cmd === '-start' || cmd === '-end') {
    if (cmd === '-end') mon.volatile.delete(effect);
    else if (mon.volatile.size < 32) mon.volatile.add(effect);
    if (effect === 'encore') mon.encore = cmd === '-start';
    if (effect === 'disable') mon.disabledMove = cmd === '-start' ? id(args[2] || '') : '';
    if (effect === 'substitute') mon.substitute = cmd === '-start';
    if (effect === 'mimic' && cmd === '-start') {
      mon.nativeRevealed ||= new Map(mon.revealed);
      for (const [key, previous] of mon.nativeRevealed) mon.nativeRevealed.set(key, { ...previous, ppUncertain: true });
      mon.revealed.delete('mimic');
    }
    if (effect === 'typechange' || effect === 'typeadd') {
      const types = (args[2] || '').split('/');
      if (cmd === '-end' || !types.every(type => typeChart.has(type))) mon.types = null;
      else if (effect === 'typechange') mon.types = types;
      else if (mon.types) mon.types = [...new Set([...mon.types, ...types])];
    }
  } else if (cmd === '-prepare') {
    mon.prepared = effect;
  } else if (cmd === '-singleturn' && scouting.has(effect)) {
    mon.protectedTurn = turn?.number;
  } else if (cmd === '-ability' || cmd === '-endability') {
    if (cmd === '-endability') mon.abilitySuppressed = true;
    else if (args.some(arg => arg.startsWith('[from]'))) setTemporaryAbility(mon, id(args[1] || ''));
    else rememberAbility(mon, id(args[1] || ''));
  } else if (cmd === '-item' || cmd === '-enditem') {
    rememberItem(mon, cmd === '-item' ? id(args[1] || '') : '');
    if (cmd === '-enditem' && ['Eject Pack', 'Eject Button'].includes(args[1]) && args.length === 2) mon.ejected = true;
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
  const cause = args.find(tag => tag.startsWith('[from] ')) || '';
  const ownerToken = args.find(tag => tag.startsWith('[of] '));
  const owner = ownerToken ? slot(ownerToken.slice(5)) : side;
  const affected = state.active[side];
  if (cmd === '-ability' && cause === '[from] ability: Trace') {
    // The [of] Pokémon supplied the copied ability; Trace belongs to the first Pokémon.
    if (affected && !affected.changedAbility) affected.nativeAbility = 'trace';
    if (ownerToken && owner) rememberAbility(state.active[owner], id(args[1] || ''));
  } else if (cause.startsWith('[from] ability: ') && owner && cmd !== '-ability') {
    const ability = id(cause.slice('[from] ability: '.length));
    if (state.active[owner].ability !== ability) state.prior.clear();
    rememberAbility(state.active[owner], ability);
  }
  if (cause.startsWith('[from] item: ') && owner) {
    const item = id(cause.slice('[from] item: '.length));
    // A consumed berry can still be named as the source of the following heal/boost.
    if (['leftovers', 'blacksludge', 'lifeorb', 'rockyhelmet', 'flameorb', 'toxicorb'].includes(item)) {
      rememberItem(state.active[owner], item);
    }
  }
  if (cmd === '-activate' && affected) {
    const activation = id(args[1] || '');
    if (['movespite', 'moveeeriespell', 'movegrudge', 'movegmaxdepletion'].includes(activation)) {
      markSpentPP(affected, args[2]);
    } else if (activation === 'skillswap' || activation === 'moveskillswap') {
      if (owner && owner !== side) {
        const other = state.active[owner];
        const theirs = args[2] && !args[2].startsWith('[') ? id(args[2]) : other.ability;
        const ours = args[3] && !args[3].startsWith('[') ? id(args[3]) : affected.ability;
        if (!affected.changedAbility) affected.nativeAbility = ours;
        if (!other.changedAbility) other.nativeAbility = theirs;
        setTemporaryAbility(affected, theirs);
        setTemporaryAbility(other, ours);
        state.prior.clear();
      }
    } else if (activation === 'movesketch') {
      affected.revealed.delete('sketch');
    } else if ((args[1] || '').startsWith('ability: ')) {
      const ability = id(args[1].slice('ability: '.length));
      if (affected.ability !== ability) state.prior.clear();
      rememberAbility(affected, ability);
      const recipient = slot(args[2]);
      if (recipient && ['lingeringaroma', 'mummy'].includes(ability)) setTemporaryAbility(state.active[recipient], ability);
    }
  }
  if (cmd === '-block' && owner && (args[1] || '').startsWith('ability: ')) {
    rememberAbility(state.active[owner], id(args[1].slice('ability: '.length)));
  }
  if (cmd === '-damage' || cmd === '-heal' || cmd === '-sethp') {
    if (cmd === '-damage' && turn && side && cause === '[from] confusion') {
      cannotMove(state, turn, [args[0], 'confusion']);
    }
    healthChange(state, turn, cmd, args, side);
    if (cmd === '-sethp' && slot(args[2])) healthChange(state, turn, cmd, args.slice(2), slot(args[2]));
    return;
  }
  updateConditions(state, turn, cmd, args, side);
  if (!turn) return;
  if (cmd === '-end' && ['futuresight', 'doomdesire'].includes(hazardName(args[1]))) {
    record(turn, side, `The delayed ${clean(args[1]).replace(/^move: /, '')} resolved.`);
    turn.current = null;
    return;
  }
  const name = state.active[side]?.name;
  if (cmd === '-miss' && (side || move?.side)) {
    miss(turn, state, side || move.side);
  } else if (cmd === '-crit' && side) {
    const event = `A critical hit landed on ${name}.`;
    record(turn, side, event);
    if (move) record(turn, move.side, event);
  } else if (cmd === '-immune' && move && !move.landed && move.targetSide === side && move.side !== side && !args.some(tag => /\[from\] (?:psn|brn|confusion|tox)/i.test(tag))) {
    record(turn, move.side, `${name} was immune.`);
    record(turn, side, `${name} was immune to ${move.name}.`);
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
function markSpentPP(mon, moveName) {
  const key = id(moveName || '');
  if (!moveTypes.has(key)) return;
  mon.ppDrained.add(key);
  const previous = mon.revealed.get(key);
  if (previous) mon.revealed.set(key, { ...previous, ppUncertain: true });
}
function cannotMove(state, turn, args) {
  const side = slot(args[0]);
  if (!side) return;
  if (['ability: Armor Tail', 'ability: Queenly Majesty', 'ability: Dazzling', 'ability: Damp'].includes(args[1])) {
    // The first ident is the blocking ability holder. [of] names the interrupted attacker.
    const attacker = slot(args.find(arg => arg.startsWith('[of] '))?.slice(5));
    if (attacker) {
      rememberAbility(state.active[side], id(args[1].slice('ability: '.length)));
      record(turn, attacker, `${state.active[side].name} blocked ${clean(args[2])} with ${clean(args[1].slice(9))}.`);
      turn.current = null;
      return;
    }
  }
  const name = state.active[side].name;
  state.active[side].prepared = '';
  if (args[1] === 'nopp') markSpentPP(state.active[side], args[2]);
  const reason = { par: 'full paralysis', flinch: 'a flinch', slp: 'sleep', frz: 'freeze', recharge: 'recharge', confusion: 'a confusion self-hit',
    'move: Taunt': 'Taunt', 'ability: Truant': 'Truant' }[args[1]];
  const text = typeof reason === 'string' ? `${name} could not move due to ${reason}.` : `${name} could not move.`;
  if (['par', 'frz', 'confusion'].includes(args[1]) && turn.luck.size < 4) turn.luck.add(text);
  if (turn.incidental[side]) {
    delete turn.rows[side];
    delete turn.incidental[side];
  }
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
  const state = { active: { p1: pokemon(), p2: pokemon() }, remaining: { p1: null, p2: null }, teamSize: { p1: 0, p2: 0 },
    preview: { p1: [], p2: [] }, bench: { p1: new Map(), p2: new Map() }, screens: { p1: new Set(), p2: new Set() },
    pastMoves: { p1: new Set(), p2: new Set() }, ambiguousPP: { p1: new Set(), p2: new Set() },
    hazards: { p1: new Map(), p2: new Map() }, prior: new Map(), field: new Set(), weather: '', useTypes: false };
  let gen = '';
  let gametype = '';
  let turn;
  let complete = false;
  let started = false;
  let customRules = false;
  for (const raw of lines) {
    if (raw.length > 16384) reject('review-limit');
    if (raw[0] !== '|') continue;
    const [, cmd, ...args] = raw.trimEnd().split('|');
    if (cmd === 'split') reject('invalid-replay');
    if (!started && (cmd === '-reviewcustomrules' || (cmd === 'raw' &&
        /^<div class="infobox"><details class="readmore"(?: open)?><summary><strong>\d+ custom rules?:/i.test(args[0])))) {
      customRules = true;
    }
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
    else if (!started && cmd === 'poke' && SIDES.includes(args[0]) && state.preview[args[0]].length < 24) {
      state.preview[args[0]].push(id(clean((args[1] || '').split(',')[0])));
    } else if (!turn && cmd === 'teamsize' && SIDES.includes(args[0]) && /^\d{1,2}$/.test(args[1])) {
      state.remaining[args[0]] = +args[1];
      state.teamSize[args[0]] = +args[1];
    }
    else if (cmd === 'start') {
      started = true;
      state.useTypes = !customRules && standardTier.test(report.format);
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
        const event = `${state.active[side].name} fainted.`;
        record(turn, side, event);
        if (turn.current?.targetSide === side) record(turn, turn.current.side, event);
      } else if (cmd === 'upkeep' || cmd === '') {
        if (cmd === 'upkeep') turn.upkeep = true;
        turn.current = null;
      }
    }
  }
  if (!complete) reject('incomplete-replay');
  if (!players.p1 || !players.p2 || !gen || !gametype || !report.format) reject('invalid-replay');
  report.supported = gen === '9' && gametype === 'singles' && !customRules && standardTier.test(report.format);
  report.scope = report.supported ? 'Standard Gen 9 singles · public turn-by-turn review' :
    'Turn ratings cover recognized standard Gen 9 singles formats, including OU, Anything Goes and Random Battle. This format is outside that scope.';
  if (report.supported) finish(turn, report);
  else for (const side of SIDES) report.sides[side].turns = [];
  return summarize(report);
}

function speciesTyping(name) { return speciesTypes.get(id(name)); }

module.exports = { analyzeBattle, speciesTyping };
