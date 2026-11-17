'use strict';

// Simple practice bots: Random, Greedy and Heuristic. They run in the app, against the simulator on
// this computer, with no cloud server. Each one reads the bot seat's battle frames, keeps a small
// picture of the battle, and answers every |request| with a choice built from that request, so the
// choice is always legal.
//
// Move, species and type data come from the Pokemon Showdown simulator the app already ships
// (MIT). Nothing here comes from Foul Play.
//
//   random     a random usable move; now and then a random switch.
//   greedy     the move with the biggest estimated immediate damage; never switches by choice.
//   heuristic  simple rules: take a KO, switch out of bad matchups, set a hazard and status once,
//              heal when low, set up when safe, otherwise attack.
//
// Damage is a quick estimate (standard formula with stats, boosts, STAB, type effectiveness and an
// average roll); abilities and items are ignored apart from Levitate.

const path = require('node:path');
const { EventEmitter } = require('node:events');

const LOCAL_BOTS = Object.freeze({
  random: Object.freeze({ id: 'random', name: 'Random', account: 'RandomBot', local: true,
    description: 'Picks a random usable move and sometimes switches at random.' }),
  greedy: Object.freeze({ id: 'greedy', name: 'Greedy', account: 'GreedyBot', local: true,
    description: 'Always goes for the hardest-hitting move. Never switches by choice.' }),
  heuristic: Object.freeze({ id: 'heuristic', name: 'Heuristic', account: 'HeuristicBot', local: true,
    description: 'Takes KOs, switches out of bad matchups, sets hazards and status, heals when low.' }),
});

const SWITCH_CHANCE = 0.15; // Random: how often to switch when it could also attack.
const HAZARDS = ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'];
const STATUS_IMMUNE = { tox: ['Poison', 'Steel'], psn: ['Poison', 'Steel'], brn: ['Fire'], par: ['Electric'], slp: [], frz: ['Ice'] };
const POWDER_IMMUNE = ['Grass'];
const FIXED_DAMAGE = ['seismictoss', 'nightshade'];
const SELF_KO = ['explosion', 'selfdestruct', 'mistyexplosion', 'finalgambit', 'memento', 'healingwish', 'lunardance'];
const BOOSTS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
const DECIDE_DELAY_MS = 40; // Wait for the turn's log, which follows its |request|, before deciding.

const toId = text => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- Data ----------

const cache = new Map();

// Loads moves, species and the type chart from the simulator under `serverRoot`.
function loadData(serverRoot) {
  if (cache.has(serverRoot)) return cache.get(serverRoot);
  const dir = path.join(serverRoot, 'dist', 'data');
  const { Moves } = require(path.join(dir, 'moves.js'));
  const { Pokedex } = require(path.join(dir, 'pokedex.js'));
  const { TypeChart } = require(path.join(dir, 'typechart.js'));
  if (!Moves || !Pokedex || !TypeChart) throw new Error('The simulator data is incomplete.');
  const data = { moves: Moves, species: Pokedex, typechart: TypeChart };
  cache.set(serverRoot, data);
  return data;
}

function speciesData(data, name) {
  const id = toId(name);
  return data.species[id] || data.species[toId(String(name).split('-')[0])] || null;
}

// Multiplier for a move type against a list of defending types (1, 2, 4, 0.5, 0.25 or 0).
function typeModifier(data, moveType, types) {
  let modifier = 1;
  for (const type of types) {
    const taken = data.typechart[toId(type)]?.damageTaken?.[moveType];
    if (taken === 1) modifier *= 2;
    else if (taken === 2) modifier *= 0.5;
    else if (taken === 3) return 0;
  }
  return modifier;
}

// ---------- Battle picture ----------

function parseCondition(text) {
  const [hpText = '', status = ''] = String(text || '').split(' ');
  if (hpText === '0' || status === 'fnt') return { hp: 0, max: 100, status: null };
  const [hp, max] = hpText.split('/').map(Number);
  if (!Number.isFinite(hp)) return null;
  return { hp, max: Number.isFinite(max) && max > 0 ? max : 100, status: status || null };
}

function parseDetails(text) {
  const parts = String(text || '').split(', ');
  const level = parts.map(part => /^L(\d+)$/.exec(part)?.[1]).find(Boolean);
  return { species: parts[0], level: level ? Number(level) : 100 };
}

// "p1a: Garchomp" -> { side: 'p1', name: 'Garchomp' }
function parseIdent(text) {
  const match = /^(p[12])[a-z]?: ?(.*)$/.exec(String(text || ''));
  return match ? { side: match[1], name: match[2] } : null;
}

// Tracks what the bot has seen of both sides from the battle log.
class Tracker {
  constructor() {
    this.turn = 0;
    this.sides = { p1: this.side(), p2: this.side() };
  }

  side() { return { active: null, mons: {}, conditions: {} }; }

  mon(ident) {
    const parsed = parseIdent(ident);
    if (!parsed) return null;
    const side = this.sides[parsed.side];
    side.mons[parsed.name] ||= { name: parsed.name, species: parsed.name, level: 100, hp: 100, max: 100, status: null,
      boosts: {}, moves: new Set(), ability: null, tera: null };
    return side.mons[parsed.name];
  }

  line(line) {
    const parts = line.split('|');
    const kind = parts[1];
    const args = parts.slice(2);
    switch (kind) {
      case 'turn': { const turn = Number(args[0]); if (Number.isInteger(turn)) this.turn = turn; break; }
      case 'switch': case 'drag': case 'replace': {
        const mon = this.mon(args[0]);
        if (!mon) break;
        Object.assign(mon, parseDetails(args[1]));
        mon.boosts = {};
        this.condition(mon, args[2]);
        this.sides[parseIdent(args[0]).side].active = mon.name;
        break;
      }
      case 'detailschange': { const mon = this.mon(args[0]); if (mon) Object.assign(mon, parseDetails(args[1])); break; }
      case '-formechange': { const mon = this.mon(args[0]); if (mon && args[1]) mon.species = args[1]; break; }
      case '-damage': case '-heal': case '-sethp': { const mon = this.mon(args[0]); if (mon) this.condition(mon, args[1]); break; }
      case 'faint': { const mon = this.mon(args[0]); if (mon) mon.hp = 0; break; }
      case '-status': { const mon = this.mon(args[0]); if (mon) mon.status = args[1] || null; break; }
      case '-curestatus': { const mon = this.mon(args[0]); if (mon) mon.status = null; break; }
      case '-boost': case '-unboost': {
        const mon = this.mon(args[0]);
        const amount = Number(args[2]);
        if (mon && BOOSTS.includes(args[1]) && Number.isFinite(amount)) {
          const value = (mon.boosts[args[1]] || 0) + (kind === '-boost' ? amount : -amount);
          mon.boosts[args[1]] = Math.max(-6, Math.min(6, value));
        }
        break;
      }
      case '-setboost': {
        const mon = this.mon(args[0]);
        const amount = Number(args[2]);
        if (mon && BOOSTS.includes(args[1]) && Number.isFinite(amount)) mon.boosts[args[1]] = Math.max(-6, Math.min(6, amount));
        break;
      }
      case '-clearboost': { const mon = this.mon(args[0]); if (mon) mon.boosts = {}; break; }
      case '-clearnegativeboost': {
        const mon = this.mon(args[0]);
        if (mon) for (const key of Object.keys(mon.boosts)) if (mon.boosts[key] < 0) delete mon.boosts[key];
        break;
      }
      case '-clearallboost': for (const side of Object.values(this.sides)) for (const mon of Object.values(side.mons)) mon.boosts = {}; break;
      case '-terastallize': { const mon = this.mon(args[0]); if (mon) mon.tera = args[1] || null; break; }
      case '-ability': { const mon = this.mon(args[0]); if (mon && args[1]) mon.ability = toId(args[1]); break; }
      case 'move': { const mon = this.mon(args[0]); if (mon && args[1]) mon.moves.add(toId(args[1])); break; }
      case '-sidestart': case '-sideend': {
        const side = this.sides[/^(p[12])/.exec(args[0] || '')?.[1]];
        const condition = toId(String(args[1] || '').replace(/^move: /, ''));
        if (side && condition) {
          if (kind === '-sidestart') side.conditions[condition] = (side.conditions[condition] || 0) + 1;
          else delete side.conditions[condition];
        }
        break;
      }
      default: break;
    }
  }

  condition(mon, text) {
    const value = parseCondition(text);
    if (!value) return;
    mon.hp = value.hp;
    mon.max = value.max;
    if (value.hp === 0) mon.status = null;
    else mon.status = value.status;
  }
}

// Random Battle sets use 84 EVs and 31 IVs in every stat with a neutral nature.
function estimateStats(base, level) {
  const stat = value => Math.floor((2 * value + 31 + 21) * level / 100);
  return { hp: stat(base.hp) + level + 10, atk: stat(base.atk) + 5, def: stat(base.def) + 5,
    spa: stat(base.spa) + 5, spd: stat(base.spd) + 5, spe: stat(base.spe) + 5 };
}

function typesOf(data, speciesName, tera) {
  if (tera && tera !== 'Stellar') return [tera];
  return speciesData(data, speciesName)?.types || [];
}

// The bot's own Pokemon, from the request (exact) plus boosts from the log.
function ownView(data, pokemon, slot, tracked) {
  const { species, level } = parseDetails(pokemon.details);
  const condition = parseCondition(pokemon.condition) || { hp: 0, max: 1, status: null };
  const tera = pokemon.terastallized || null;
  return { name: tracked?.name || species, slot, species, level, types: typesOf(data, species, tera),
    baseTypes: typesOf(data, species, null), stats: { hp: condition.max, ...(pokemon.stats || {}) },
    hp: condition.hp, maxhp: condition.max, status: condition.status, boosts: { ...(tracked?.boosts || {}) },
    moves: (pokemon.moves || []).map(toId), ability: toId(pokemon.ability || pokemon.baseAbility),
    teraType: pokemon.teraType || null, terastallized: Boolean(tera) };
}

// The opponent's active Pokemon, with stats estimated from its species and level.
function foeView(data, mon) {
  if (!mon) return null;
  const species = speciesData(data, mon.species);
  const stats = estimateStats(species?.baseStats || { hp: 80, atk: 80, def: 80, spa: 80, spd: 80, spe: 80 }, mon.level);
  return { name: mon.name, species: mon.species, level: mon.level, types: typesOf(data, mon.species, mon.tera),
    baseTypes: typesOf(data, mon.species, null), stats, hp: stats.hp * mon.hp / mon.max, maxhp: stats.hp,
    status: mon.status, boosts: { ...mon.boosts }, moves: [...mon.moves], ability: mon.ability,
    teraType: mon.tera, terastallized: Boolean(mon.tera) };
}

// What the picker sees: both active Pokemon, the bot's party by request slot, and the opponent's hazards.
function battleView(data, tracker, request) {
  const mine = request.side?.id === 'p1' || request.side?.id === 'p2' ? request.side.id : 'p2';
  const theirs = mine === 'p1' ? 'p2' : 'p1';
  const party = {};
  let me = null;
  (request.side?.pokemon || []).forEach((pokemon, index) => {
    const tracked = tracker.sides[mine].mons[parseIdent(pokemon.ident)?.name];
    const view = ownView(data, pokemon, index + 1, tracked);
    party[index + 1] = view;
    if (pokemon.active) me = view;
  });
  const foeSide = tracker.sides[theirs];
  const foe = foeView(data, foeSide.mons[foeSide.active]);
  return { turn: tracker.turn, me, foe, party, foeConditions: { ...foeSide.conditions } };
}

// ---------- Legal options ----------

// Usable moves (by id and request position) and switch slots from a |request|, and whether Tera is available.
function legalOptions(request) {
  const forced = Boolean(request.forceSwitch?.[0]);
  const active = forced ? {} : request.active?.[0] || {};
  const moves = [];
  (active.moves || []).forEach((move, index) => {
    if (move.disabled || (typeof move.pp === 'number' && move.pp <= 0 && move.maxpp)) return;
    const id = toId(move.id || move.move);
    if (id) moves.push({ id, index: index + 1 });
  });
  const trapped = Boolean(active.trapped || active.maybeTrapped);
  const switches = [];
  if (forced || !trapped) {
    (request.side?.pokemon || []).forEach((pokemon, index) => {
      const condition = String(pokemon.condition || '');
      if (!pokemon.active && !condition.endsWith(' fnt') && condition !== '0 fnt') switches.push(index + 1);
    });
  }
  return { moves, switches, canTera: Boolean(active.canTerastallize) };
}

// ---------- Estimates ----------

function boosted(value, stage = 0) {
  const s = Math.max(-6, Math.min(6, Math.trunc(stage) || 0));
  return s >= 0 ? value * (2 + s) / 2 : value * 2 / (2 - s);
}

function stat(mon, key) { return boosted(mon.stats?.[key] || 100, mon.boosts?.[key]); }

function effectiveness(data, moveType, defender) {
  if (moveType === 'Ground' && defender.ability === 'levitate') return 0;
  return typeModifier(data, moveType, defender.types);
}

function rawDamage(attacker, defender, power, category, foulPlay = false) {
  const attack = foulPlay ? stat(defender, 'atk') : stat(attacker, category === 'Physical' ? 'atk' : 'spa');
  const defense = stat(defender, category === 'Physical' ? 'def' : 'spd');
  return ((2 * attacker.level / 5 + 2) * power * attack / Math.max(1, defense)) / 50 + 2;
}

// Expected HP the move takes off the defender (0 for status moves and immunities).
function estimateDamage(data, attacker, defender, moveId, tera = false) {
  if (!attacker || !defender) return 0;
  const move = data.moves[moveId];
  if (!move || (move.category !== 'Physical' && move.category !== 'Special')) return 0;
  const modifier = effectiveness(data, move.type, defender);
  if (modifier === 0) return 0;
  if (FIXED_DAMAGE.includes(moveId)) return attacker.level;
  let power = move.basePower || 60; // Weight-, speed- and HP-based moves: assume a middling hit.
  if (Array.isArray(move.multihit)) power *= (move.multihit[0] + move.multihit[1]) / 2;
  else if (typeof move.multihit === 'number') power *= move.multihit;
  let damage = rawDamage(attacker, defender, power, move.category, moveId === 'foulplay');
  const stab = (attacker.baseTypes || attacker.types).includes(move.type) || attacker.types.includes(move.type) ||
    (tera && attacker.teraType === move.type);
  if (stab) damage *= 1.5;
  if (attacker.status === 'brn' && move.category === 'Physical') damage *= 0.5;
  const hit = typeof move.accuracy === 'number' ? move.accuracy / 100 : 1;
  return damage * modifier * 0.925 * hit;
}

const hpShare = mon => (mon && mon.maxhp ? mon.hp / mon.maxhp : 0);

// Estimated damage as a share of the defender's current HP, capped at a KO (1).
function damageShare(data, attacker, defender, moveId, tera = false) {
  if (!defender || defender.hp <= 0) return 0;
  return Math.min(1, estimateDamage(data, attacker, defender, moveId, tera) / defender.hp);
}

// How hard `foe` can hit `mon`: its best revealed attack, or an 80-power STAB move of its better attacking stat.
function threat(data, foe, mon) {
  if (!foe || !mon || mon.hp <= 0) return 0;
  let best = 0;
  for (const moveId of foe.moves) best = Math.max(best, damageShare(data, foe, mon, moveId));
  const category = stat(foe, 'atk') >= stat(foe, 'spa') ? 'Physical' : 'Special';
  for (const type of foe.types) {
    const modifier = effectiveness(data, type, mon);
    if (modifier === 0) continue;
    const damage = rawDamage(foe, mon, 80, category) * 1.5 * modifier * 0.925;
    best = Math.max(best, Math.min(1, damage / mon.hp));
  }
  return best;
}

// { share, move, tera } for the move with the biggest estimated damage.
function bestAttack(data, attacker, defender, moveIds, canTera = false) {
  let best = { share: 0, move: null, tera: false };
  for (const moveId of moveIds) {
    for (const tera of canTera ? [false, true] : [false]) {
      const share = damageShare(data, attacker, defender, moveId, tera);
      if (share > best.share + 1e-9) best = { share, move: moveId, tera };
    }
  }
  return best;
}

// Positive when `mon` hits `foe` harder than it gets hit.
function matchup(data, mon, foe) {
  return bestAttack(data, mon, foe, mon.moves).share - threat(data, foe, mon);
}

// ---------- Picker ----------

class Picker {
  constructor(kind, data, rng = Math.random) {
    if (!Object.hasOwn(LOCAL_BOTS, kind)) throw new Error(`Unknown bot: ${kind}`);
    Object.assign(this, { kind, data, rng });
    this.reset();
  }

  reset() {
    this.usedOnce = new Set(); // Hazards and status moves already tried this battle, by Pokemon and move.
    this.lastSwitchTurn = -10;
  }

  pick(list) { return list[Math.floor(this.rng() * list.length) % list.length]; }

  // Returns { move, tera } or { slot }, where `move` is a move id from the request.
  choose(view, request) {
    const options = legalOptions(request);
    if (!options.moves.length && !options.switches.length) return null;
    const option = this[this.kind](view, options.moves.map(move => move.id), options.switches, options.canTera);
    if (option.slot !== undefined) this.lastSwitchTurn = view.turn;
    return option;
  }

  bestSwitch(view, switches) {
    let best = null;
    for (const slot of switches) {
      const mon = view.party[slot];
      const score = mon && view.foe ? matchup(this.data, mon, view.foe) : -1;
      if (!best || score > best.score) best = { slot, score };
    }
    return best?.slot;
  }

  random(view, moves, switches) {
    if (switches.length && (!moves.length || this.rng() < SWITCH_CHANCE)) return { slot: this.pick(switches) };
    return { move: this.pick(moves) };
  }

  greedy(view, moves, switches) {
    if (!moves.length) return { slot: this.bestSwitch(view, switches) };
    const best = bestAttack(this.data, view.me, view.foe, moves);
    return { move: best.move || this.pick(moves) };
  }

  heuristic(view, moves, switches, canTera) {
    const { me, foe, turn } = view;
    if (!moves.length) return { slot: this.bestSwitch(view, switches) };
    const data = this.data;
    const attack = bestAttack(data, me, foe, moves, canTera);
    const myHp = hpShare(me);
    const danger = threat(data, foe, me);

    // 1. Take a KO when one is likely.
    if (attack.move && attack.share >= 1) {
      return { move: attack.move, tera: attack.tera && !this.teraWasteful(attack, me, foe) };
    }

    // 2. Switch out of a bad matchup (not twice in a row, and only to something clearly better).
    if (switches.length && turn - this.lastSwitchTurn > 1 && danger >= 0.6 && attack.share < 0.35) {
      const slot = this.bestSwitch(view, switches);
      if (slot !== undefined && matchup(data, view.party[slot], foe) > attack.share - danger + 0.3) return { slot };
    }

    const key = me?.name || '';
    // 3. Heal when low and not about to be knocked out anyway.
    if (myHp < 0.45 && danger < myHp) {
      const heal = moves.find(id => data.moves[id]?.heal && data.moves[id]?.target === 'self');
      if (heal) return { move: heal };
    }

    // 4. Lay a hazard once, early, while the opponent has Pokemon to send in.
    for (const id of moves) {
      if (HAZARDS.includes(id) && !view.foeConditions[id] && !this.usedOnce.has(`${key}|${id}`) && danger < 0.5) {
        this.usedOnce.add(`${key}|${id}`);
        return { move: id };
      }
    }

    // 5. Status an unstatused opponent once, when attacking would not do much.
    if (foe && !foe.status && attack.share < 0.5) {
      for (const id of moves) {
        const move = data.moves[id];
        if (!move || move.category !== 'Status' || !move.status || this.usedOnce.has(`${key}|${id}`)) continue;
        if (foe.types.some(type => (STATUS_IMMUNE[move.status] || []).includes(type))) continue;
        if (effectiveness(data, move.type, foe) === 0) continue;
        if (move.flags?.powder && foe.types.some(type => POWDER_IMMUNE.includes(type))) continue;
        this.usedOnce.add(`${key}|${id}`);
        return { move: id };
      }
    }

    // 6. Set up when healthy and not under pressure, up to +2.
    if (myHp > 0.7 && danger < 0.35) {
      for (const id of moves) {
        const move = data.moves[id];
        const boosts = move?.boosts || {};
        const keys = Object.keys(boosts);
        if (move?.target === 'self' && keys.length && keys.every(k => boosts[k] > 0) &&
            keys.every(k => (me.boosts[k] || 0) < 2)) return { move: id };
      }
    }

    // 7. Otherwise attack, saving self-KO moves for when this Pokemon is nearly done.
    const usable = moves.filter(id => !SELF_KO.includes(id) || myHp < 0.25);
    const best = bestAttack(data, me, foe, usable.length ? usable : moves, canTera);
    if (best.move) return { move: best.move, tera: best.tera && !this.teraWasteful(best, me, foe) };
    return { move: this.pick(moves) };
  }

  // Terastallize only when it changes the outcome: the plain move would not have done as well.
  teraWasteful(attack, me, foe) {
    const plain = damageShare(this.data, me, foe, attack.move);
    return plain >= 1 || attack.share - plain < 0.15;
  }
}

// The Showdown command for an option, using the move's position in the request.
function command(option, request) {
  if (!option) return '/choose default';
  if (option.slot !== undefined) return `/choose switch ${option.slot}`;
  const index = (request.active?.[0]?.moves || []).findIndex(move => toId(move.id || move.move) === option.move);
  if (index < 0) return '/choose default';
  return `/choose move ${index + 1}${option.tera ? ' terastallize' : ''}`;
}

// ---------- Bot seat ----------

// Plays the bot's seat. Same shape as the cloud API socket that PracticeSession uses for Foul Play:
// send(frame) in; 'choice' { room, choice, rqid, elapsedMs } and 'close' { error } out.
class LocalBot extends EventEmitter {
  constructor({ kind, data, rng = Math.random, delayMs = DECIDE_DELAY_MS }) {
    super();
    this.picker = new Picker(kind, data, rng);
    Object.assign(this, { kind, data, delayMs, room: null, tracker: new Tracker(), request: null, timer: null, closed: false });
    this.ready = Promise.resolve({ type: 'ready', bot: kind, threads: 1, searchMs: 0 });
  }

  send(text) {
    if (this.closed) return;
    const lines = String(text).split('\n');
    if (!lines[0].startsWith('>')) return;
    const room = lines[0].slice(1);
    if (lines.includes('|init|battle')) {
      // A new battle (or rematch): forget the last one.
      Object.assign(this, { room, tracker: new Tracker(), request: null });
      this.picker.reset();
    }
    if (room !== this.room) return;
    for (const line of lines.slice(1)) {
      if (line.startsWith('|request|')) {
        let request = null;
        try { request = JSON.parse(line.slice(9)); } catch { /* Ignore a request that does not parse. */ }
        if (request && !request.wait) Object.assign(this, { request, since: Date.now() });
      } else if (line.startsWith('|error|[Invalid choice]') || line.startsWith('|error|[Unavailable choice]')) {
        // Should not happen; never leave the player waiting.
        this.emitChoice('/choose default', this.lastRqid);
      } else if (line.startsWith('|win|') || line === '|tie') {
        this.request = null;
      } else {
        this.tracker.line(line);
      }
    }
    if (this.request) this.schedule();
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.decide(), this.delayMs);
    this.timer.unref?.();
  }

  decide() {
    const request = this.request;
    if (!request || this.closed) return;
    this.request = null;
    let choice = '/choose default';
    try {
      if (!request.teamPreview) {
        const option = this.picker.choose(battleView(this.data, this.tracker, request), request);
        choice = command(option, request);
      }
    } catch { /* Fall back to the simulator's default choice rather than stalling the battle. */ }
    this.lastRqid = request.rqid;
    this.emitChoice(choice, request.rqid);
  }

  emitChoice(choice, rqid) {
    this.emit('choice', { room: this.room, choice, rqid, elapsedMs: Date.now() - (this.since || Date.now()) });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.emit('close', {});
  }
}

module.exports = { LOCAL_BOTS, LocalBot, Picker, Tracker, loadData, legalOptions, battleView, command,
  estimateDamage, threat, typeModifier };
