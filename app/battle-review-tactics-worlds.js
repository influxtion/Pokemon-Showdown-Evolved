'use strict';

const { createHash } = require('node:crypto');
const { visibleProtocol } = require('./battle-review-input');

const FORMAT = 'gen9randombattle';
const STATS = ['atk', 'def', 'spa', 'spd', 'spe'];
const MAX_WORLD_TRIES = 48;
const WORLD_COUNT = 2;
const BANK_SIZE = 10;
const HISTORY_SEEDS = 96;
const BUDGET_REACHED = Symbol('simulation budget reached');

function checkDeadline(deadline) {
  if (Date.now() >= deadline) throw BUDGET_REACHED;
}

function seed(label, index) {
  const hash = createHash('sha256').update('practice-review-v1/' + label + '/' + index).digest();
  return [0, 2, 4, 6].map(offset => hash.readUInt16BE(offset));
}

function details(text) {
  const [species, ...attributes] = text.split(', ');
  const level = attributes.find(value => /^L\d+$/.test(value));
  return { species, level: level ? Number(level.slice(1)) : 100,
    gender: attributes.find(value => value === 'M' || value === 'F') || 'N', shiny: attributes.includes('shiny') };
}

// Random singles uses a neutral nature, 31 IVs and 85 EVs, with HP tuning and
// optional zero Attack/Speed. Reconstruct the spread, then verify every stat in the request.
function ownTeam(dex, request) {
  const team = [];
  for (const mon of request.side.pokemon) {
    const appearance = details(mon.details);
    const species = dex.species.get(appearance.species);
    const maxHP = Number(/\/(\d+)/.exec(mon.condition)?.[1]);
    if (!species.exists || !maxHP || mon.terastallized || !mon.baseAbility || !mon.teraType) return null;
    const evs = Object.fromEntries(['hp', ...STATS].map(stat => [stat, 85]));
    const ivs = Object.fromEntries(['hp', ...STATS].map(stat => [stat, 31]));
    for (const stat of ['atk', 'spe']) {
      const normal = Math.floor((2 * species.baseStats[stat] + 31 + 21) * appearance.level / 100) + 5;
      if (mon.stats?.[stat] !== normal) evs[stat] = ivs[stat] = 0;
    }
    while (evs.hp > 1) {
      const expected = Math.floor((2 * species.baseStats.hp + 31 + Math.floor(evs.hp / 4) + 100) * appearance.level / 100) + 10;
      if (expected <= maxHP) break;
      evs.hp -= 4;
    }
    team.push({ ...appearance, name: mon.ident.slice(4), evs, ivs, item: mon.item, ability: mon.baseAbility,
      moves: [...mon.moves], teraType: mon.teraType });
  }
  return team;
}

function menuSignature(request) {
  if (!request?.side?.pokemon || (!request.active?.[0]?.moves && !request.forceSwitch?.[0])) return '';
  const active = request.active?.[0] || {};
  return JSON.stringify([
    request.side.id, !!request.forceSwitch?.[0], active.canTerastallize || '', !!active.trapped, !!active.maybeTrapped,
    !!active.maybeDisabled, !!active.maybeLocked,
    (active.moves || []).map(move => [move.id, move.move, move.pp, move.maxpp, move.target, !!move.disabled]),
    request.side.pokemon.map(mon => [mon.ident, mon.details, mon.condition, !!mon.active,
      STATS.map(stat => mon.stats?.[stat]), mon.moves, mon.baseAbility, mon.item, mon.ability,
      mon.teraType, mon.terastallized || '', !!mon.reviving, !!mon.commanding]),
  ]);
}

function history(lines) {
  const start = lines.indexOf('|start');
  if (start < 0) return [];
  // Separators can be coalesced in a client's queue.
  return lines.slice(start).filter(line => line !== '|');
}

function matchesView(engine, battle, seat, observed, signature) {
  if (menuSignature(battle[seat].activeRequest) !== signature) return false;
  const channel = Number(seat[1]);
  const visible = engine.extractChannelMessages(battle.log.join('\n'), [channel])[channel];
  // Use the same user-channel HP rounding and allowlist as capture. The temporary
  // terminal marker lets the shared projection accept this incomplete prefix.
  const projected = visibleProtocol([...visible, '|tie'], 30000, 16384, 2097152).log;
  if (!projected) return false;
  const lines = history(projected.split('\n').slice(0, -1));
  return lines.length === observed.length && lines.every((line, i) => line === observed[i]);
}

// Anchor the first species draw, then run the full pinned team builder including
// its lead, roles, team details, moves, item and team compatibility constraints.
function opponentTeam(engine, appearance, attempt) {
  const generator = engine.Teams.getGenerator(FORMAT, seed('team', attempt));
  const species = generator.dex.species.get(appearance.species);
  const getPool = generator.getPokemonPool;
  let basePool;
  generator.getPokemonPool = function (...args) {
    const result = getPool.apply(this, args);
    const forms = result[0][species.baseSpecies];
    if (forms?.includes(species.id)) result[0][species.baseSpecies] = [species.id];
    basePool = result[1];
    return result;
  };
  const sample = generator.sampleNoReplace;
  generator.sampleNoReplace = function (pool) {
    if (pool === basePool) {
      basePool = null;
      const at = pool.indexOf(species.baseSpecies);
      if (at >= 0) return this.fastPop(pool, at);
    }
    return sample.call(this, pool);
  };
  const team = generator.getTeam();
  if (team.length !== 6 || engine.toID(team[0].species) !== species.id || team[0].level !== appearance.level) return null;
  // These cosmetic fields are public at entry; keep the actual displayed gender/shiny.
  team[0].gender = appearance.gender;
  team[0].shiny = appearance.shiny;
  return team;
}

function openingWorlds(engine, lines, decision, deadline = Infinity) {
  const { request } = decision;
  const seat = request.side.id;
  const foe = seat === 'p1' ? 'p2' : 'p1';
  const observed = history(lines);
  const entry = observed.find(line => line.startsWith('|switch|' + foe + 'a: '));
  if (!entry || !observed.includes('|turn|1') || observed.at(-1) !== '|turn|1') return [];
  const appearance = details(entry.split('|')[3]);
  const myTeam = ownTeam(engine.Dex, request);
  if (!myTeam) return [];
  const signature = menuSignature(request);
  const worlds = [];
  for (let attempt = 0; worlds.length < BANK_SIZE && attempt < MAX_WORLD_TRIES; attempt++) {
    checkDeadline(deadline);
    const team = opponentTeam(engine, appearance, attempt);
    if (!team) continue;
    const battle = new engine.Battle({ formatid: FORMAT, seed: seed('opening', attempt),
      [seat]: { name: request.side.name || 'Player', team: structuredClone(myTeam) },
      [foe]: { name: 'Opponent', team } });
    try {
      if (matchesView(engine, battle, seat, observed, signature)) worlds.push(JSON.stringify(battle.toJSON()));
    } finally {
      battle.destroy();
    }
  }
  return worlds;
}

function submitBoth(battle, seat, choice, reply) {
  const foe = seat === 'p1' ? 'p2' : 'p1';
  return battle.choose(seat, choice) && battle.choose(foe, reply);
}

function previousReply(engine, battle, seat, events) {
  const foe = seat === 'p1' ? 'p2' : 'p1';
  if (!battle[foe].requestState) return 'wait';
  const primary = events.filter(line => line.startsWith('|move|' + foe + 'a: ') && !line.includes('|[from]'));
  if (!battle[foe].activeRequest.forceSwitch && primary.length === 1) {
    const move = engine.toID(primary[0].split('|')[3]);
    const slot = battle[foe].activeRequest.active[0].moves.findIndex(entry => entry.id === move);
    if (slot < 0) return '';
    const tera = events.some(line => line.startsWith('|-terastallize|' + foe + 'a: '));
    return 'move ' + (slot + 1) + (tera ? ' terastallize' : '');
  }
  if (!battle[foe].activeRequest.forceSwitch && primary.length) return '';
  const switches = events.filter(line => line.startsWith('|switch|' + foe + 'a: '));
  if (switches.length !== 1) return '';
  const shown = switches[0].split('|')[3];
  const slot = battle[foe].activeRequest.side.pokemon.findIndex(mon => !mon.active && mon.details === shown);
  return slot < 0 ? '' : 'switch ' + (slot + 1);
}

// A later position is accepted only if replaying both prior choices in each
// hypothetical world reproduces the entire public prefix AND the new own request.
function advanceWorlds(engine, lines, decision, previous, deadline = Infinity) {
  const observed = history(lines);
  if (!previous || decision.turn < previous.turn || decision.turn > previous.turn + 1 ||
      observed.length <= previous.view.length || previous.view.some((line, i) => line !== observed[i])) return [];
  if (!decision.request.forceSwitch && observed.at(-1) !== '|turn|' + decision.turn) return [];
  const recent = observed.slice(previous.view.length);
  const seat = decision.request.side.id;
  const signature = menuSignature(decision.request);
  const worlds = [];
  for (const state of previous.worlds) {
    checkDeadline(deadline);
    const sample = engine.Battle.fromJSON(state);
    let reply;
    try { reply = previousReply(engine, sample, seat, recent); } finally { sample.destroy(); }
    if (!reply) continue;
    for (let i = 0; i < HISTORY_SEEDS; i++) {
      if (i % 8 === 0) checkDeadline(deadline);
      const battle = engine.Battle.fromJSON(state);
      try {
        battle.prng = new engine.PRNG(seed('prior-' + decision.turn, i));
        const accepted = reply === 'wait' ? battle.choose(seat, previous.choice) : submitBoth(battle, seat, previous.choice, reply);
        if (!accepted || battle.turn !== decision.turn) continue;
        if (!matchesView(engine, battle, seat, observed, signature)) continue;
        worlds.push(JSON.stringify(battle.toJSON()));
        break;
      } finally {
        battle.destroy();
      }
    }
  }
  return worlds;
}

module.exports = { WORLD_COUNT, seed, history, openingWorlds, advanceWorlds, submitBoth, checkDeadline, BUDGET_REACHED };
