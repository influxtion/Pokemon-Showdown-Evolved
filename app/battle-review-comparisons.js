'use strict';

const data = require('./battle-review-data.json');
const attacks = new Map();
const nativeAbilities = new Map();
const chart = new Map(Object.entries(data.typeChart).map(([type, groups]) =>
  [type, groups.map(names => new Set(names.split(' ')))]));
for (const [key, names] of Object.entries(data.attacks)) {
  const [category, power, accuracy, pp, flags, effect] = key.split(' ');
  for (const name of names.split(' ')) attacks.set(name, { category, power: Number(power), accuracy, pp: Number(pp), flags, effect });
}
for (const [type, names] of Object.entries(data.moves)) {
  for (const name of names.split(' ')) if (attacks.has(name)) attacks.get(name).type = type;
}
for (const [abilities, names] of Object.entries(data.abilities)) {
  for (const name of names.split(' ')) nativeAbilities.set(name, abilities.split('/'));
}

const abilityImmunities = new Map(Object.entries({
  flashfire: 'Fire', wellbakedbody: 'Fire', waterabsorb: 'Water', stormdrain: 'Water', dryskin: 'Water',
  lightningrod: 'Electric', voltabsorb: 'Electric', motordrive: 'Electric', eartheater: 'Ground',
  levitate: 'Ground', sapsipper: 'Grass',
}));
const unstableTypes = new Set(['normalize', 'refrigerate', 'galvanize', 'aerilate', 'pixilate', 'liquidvoice']);
const bypass = new Set(['moldbreaker', 'teravolt', 'turboblaze']);
const ghostBypass = new Set(['scrappy', 'mindseye']);

function abilities(mon) {
  if (mon.abilitySuppressed || mon.transformed || (mon.changedAbility && !mon.ability)) return [];
  return mon.ability ? [mon.ability] : nativeAbilities.get(mon.name.toLowerCase().replace(/[^a-z0-9]/g, '')) || [];
}

function ordinaryFactor(type, types) {
  if (!chart.has(type) || !types?.length || !types.every(defense => chart.has(defense))) return null;
  const [weak, resist, immune] = chart.get(type);
  return types.reduce((value, defense) => value * (immune.has(defense) ? 0 : weak.has(defense) ? 2 : resist.has(defense) ? 0.5 : 1), 1);
}

function matchup(move, actor, target, observed) {
  const factor = ordinaryFactor(move.type, target.types);
  const attackers = abilities(actor);
  const defenders = abilities(target);
  if (factor === null || !attackers.length || !defenders.length || attackers.some(ability => unstableTypes.has(ability))) return '';
  if (target.item && defenders.includes('klutz')) return '';
  if (move.type === 'Ground' && target.item === 'airballoon') return 'blocked';
  const results = new Set();
  for (const attacker of attackers) {
    for (const defender of defenders) {
      if (['disguise', 'iceface', 'neutralizinggas'].includes(defender) || attacker === 'neutralizinggas') return '';
      const ignoresAbility = bypass.has(attacker) && target.item !== 'abilityshield';
      const blockedByAbility = abilityImmunities.get(defender) === move.type || (defender === 'wonderguard' && factor <= 1) ||
        (defender === 'bulletproof' && move.flags.split(',').includes('bullet')) ||
        (defender === 'soundproof' && move.flags.split(',').includes('sound')) ||
        (defender === 'windrider' && move.flags.split(',').includes('wind'));
      if (blockedByAbility && !ignoresAbility && !(defender === 'levitate' && target.item === 'ironball')) {
        // An unrevealed Iron Ball can ground Levitate; a prior immunity or a known item resolves that ambiguity.
        results.add(defender !== 'levitate' || target.itemKnown || observed ? 'blocked' : '');
      } else if (blockedByAbility && ignoresAbility && !target.itemKnown) {
        results.add(''); // Ability Shield can prevent the bypass.
      } else if (factor === 0) {
        const bypassesGhost = ghostBypass.has(attacker) && ['Fighting', 'Normal'].includes(move.type);
        if (bypassesGhost || target.item === 'ringtarget' || (move.type === 'Ground' && target.item === 'ironball')) results.add('open');
        else results.add(target.itemKnown || observed ? 'blocked' : '');
      } else {
        results.add('open');
      }
    }
  }
  return results.size === 1 ? [...results][0] : '';
}

function strongerMove(a, b, actor) {
  if (a.type !== b.type || a.flags !== b.flags || a.effect !== 'plain' || b.effect !== 'plain' ||
      a.accuracy !== b.accuracy || a.power === b.power || actor.tera) return null;
  // Technician can reverse the ordering. A hidden Metronome can reward only one of the two moves.
  if (abilities(actor).includes('technician') && Math.min(a.power, b.power) <= 60) return null;
  if (!actor.itemKnown || actor.item === 'metronome') return null;
  return a.power > b.power ? a : b;
}

function compareAttacks(side, action, scene) {
  const foe = side === 'p1' ? 'p2' : 'p1';
  const actor = scene.active[side];
  const target = scene.active[foe];
  const selected = attacks.get(action.key);
  if (!selected || !scene.useTypes || action.targetSide !== foe || action.teraType || actor.transformed || target.transformed ||
      !actor.types || !target.types || actor.possibleIllusion || target.possibleIllusion ||
      actor.choiceLock || actor.prepared || target.prepared || actor.encore ||
      abilities(actor).includes('gorillatactics') || scene.field.size || scene.screens[side].size || scene.screens[foe].size ||
      actor.volatile.size || target.volatile.size || actor.abilitySuppressed || target.abilitySuppressed ||
      Object.values(actor.boosts).some(Boolean) || Object.values(target.boosts).some(Boolean)) return null;
  const knownImmunity = key => Boolean(scene.prior.get(side + key)?.immune);
  const selectedRoute = matchup(selected, actor, target, knownImmunity(action.key));
  if (!selectedRoute) return null;
  const comparisons = [];
  for (const [key, previous] of actor.revealed) {
    const other = attacks.get(key);
    if (key === action.key || !other || selected.category !== other.category || previous.ppUncertain ||
        2 * previous.uses >= other.pp) continue;
    const route = matchup(other, actor, target, knownImmunity(key));
    if (!route) continue;
    if (route !== selectedRoute) {
      comparisons.push({ kind: 'immunity', better: selectedRoute === 'open', alternative: previous.name, turn: previous.turn });
    } else if (route === 'open') {
      const stronger = strongerMove(selected, other, actor);
      if (stronger) comparisons.push({ kind: 'power', better: selected === stronger, alternative: previous.name,
        turn: previous.turn, selectedPower: selected.power, otherPower: other.power, accuracy: selected.accuracy });
    }
  }
  // A middle option can beat one revealed move and lose to another. A single verdict would hide that trade.
  if (new Set(comparisons.map(pair => pair.better)).size !== 1) return null;
  return comparisons[0];
}

function ordinaryAttackType(moveId) { return attacks.get(moveId)?.type; }

module.exports = { compareAttacks, ordinaryFactor, ordinaryAttackType, abilities, abilityImmunities };
