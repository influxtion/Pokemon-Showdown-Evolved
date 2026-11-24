'use strict';

const { speciesTyping } = require('./battle-review-model');
const { ordinaryAttackType, ordinaryFactor, abilityImmunities, abilities } = require('./battle-review-comparisons');
const variableMoveTypes = new Set(['normalize', 'refrigerate', 'galvanize', 'aerilate', 'pixilate', 'liquidvoice', 'trace']);
const modifierNames = { levitate: 'Levitate', flashfire: 'Flash Fire', wellbakedbody: 'Well-Baked Body',
  waterabsorb: 'Water Absorb', stormdrain: 'Storm Drain', dryskin: 'Dry Skin', lightningrod: 'Lightning Rod',
  voltabsorb: 'Volt Absorb', motordrive: 'Motor Drive', eartheater: 'Earth Eater', sapsipper: 'Sap Sipper',
  airballoon: 'Air Balloon', ironball: 'Iron Ball', ringtarget: 'Ring Target' };

// Track the current stint only. A move from another switch-in, a called move, or a
// future reveal cannot become evidence for the current opponent's reply.
function defensiveMatchups(side) {
  const foe = side === 'p1' ? 'p2' : 'p1';
  let opponent = '', actor = '', attack = null, turn = 0, ownTypingChanged = false;
  let changedAbility = false, gravity = false, grounded = false;
  function observe(line) {
    const [, event, ident, value] = line.split('|', 4);
    if (event === 'turn') { turn = Number(ident); return; }
    if (ident === 'move: Gravity') {
      if (event === '-fieldstart') gravity = true;
      if (event === '-fieldend') gravity = false;
    }
    if (event === '-ability' || event === '-endability' || (event === '-activate' &&
        /(?:Skill Swap|Role Play|Wandering Spirit|Mummy|Lingering Aroma|Receiver|Power of Alchemy|Trace)/i.test(line))) changedAbility = true;
    if (ident?.startsWith(foe + 'a: ')) {
      if (['switch', 'drag', 'replace', 'detailschange', '-formechange', '-transform', 'faint'].includes(event)) {
        opponent = ['switch', 'drag', 'replace', 'detailschange'].includes(event) ? (value || '').split(',')[0] : '';
        actor = ident;
        attack = null;
        if (event === 'switch' || event === 'drag') changedAbility = false;
      } else if (event === 'move' && value && actor === ident && opponent && !line.includes('|[from]')) {
        const type = ordinaryAttackType(value.toLowerCase().replace(/[^a-z0-9]/g, ''));
        if (type) attack = { opponent, move: value, type, turn };
      }
    }
    if (ident?.startsWith(side + 'a: ')) {
      if (event === 'switch' || event === 'drag') { ownTypingChanged = false; grounded = false; }
      else if (['replace', 'detailschange', '-formechange', '-transform'].includes(event) ||
          (event === '-start' && /^(typechange|typeadd)$/.test(value))) ownTypingChanged = true;
      if (event === '-start' && /^(?:move: )?(?:Smack Down|Ingrain)$/i.test(value)) grounded = true;
    }
  }
  function compare(request) {
    const active = request.active?.[0];
    if (!attack || !opponent || changedAbility || !active || active.maybeTrapped || active.maybeDisabled || active.maybeLocked) return null;
    const possible = abilities({ name: opponent });
    if (!possible.length || possible.some(ability => variableMoveTypes.has(ability)) ||
        (['Fighting', 'Normal'].includes(attack.type) && possible.some(a => a === 'scrappy' || a === 'mindseye')) ||
        (attack.type === 'Ground' && (grounded || gravity))) return null;
    const defenders = [];
    const team = request.side.pokemon;
    function add(action, types, mon) {
      const factor = ordinaryFactor(attack.type, types);
      if (factor == null) return;
      const modifiers = [];
      if (abilityImmunities.get(mon.ability) === attack.type) modifiers.push(mon.ability);
      if ((attack.type === 'Ground' && ['airballoon', 'ironball'].includes(mon.item)) ||
          (factor === 0 && mon.item === 'ringtarget')) modifiers.push(mon.item);
      defenders.push({ action, types: types.join('/'), factor, modifiers: modifiers.map(id => modifierNames[id]).join(', ') });
    }
    for (const mon of team) {
      if (mon.condition === '0 fnt' || (!mon.active && active.trapped)) continue;
      const species = mon.details.split(',')[0];
      const typing = mon.terastallized && mon.terastallized !== 'Stellar' ? [mon.terastallized] : speciesTyping(species);
      if (!mon.active || !ownTypingChanged) add(mon.active ? 'Stay with ' + species : 'Switch to ' + species, typing, mon);
      if (mon.active && active.canTerastallize && active.canTerastallize !== 'Stellar') {
        add('Tera ' + active.canTerastallize, [active.canTerastallize], mon);
      }
    }
    if (new Set(defenders.map(record => record.factor)).size < 2) return null;
    return { ...attack, defenders };
  }
  return { observe, compare };
}

module.exports = { defensiveMatchups };
