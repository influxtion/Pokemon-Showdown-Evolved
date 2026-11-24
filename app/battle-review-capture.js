'use strict';

// This file is also staged verbatim into the sandboxed practice client. The
// player projection and its validation in main use the same schema.
function battleReviewCapture() {
  const limit = 128;
  const roomId = /^battle-gen9randombattle-[0-9]{1,12}$/;
  const id = /^[a-z0-9]{1,48}$/;
  const label = /^[\p{L}\p{N} .'%:’♀♂-]{1,64}$/u;
  const type = /^(?:Normal|Fire|Water|Electric|Grass|Ice|Fighting|Poison|Ground|Flying|Psychic|Bug|Rock|Ghost|Dragon|Dark|Steel|Fairy|Stellar)$/;
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  const matches = (value, regex) => typeof value === 'string' && value.length <= 128 && regex.test(value);
  const list = (value, max) => Array.isArray(value) && value.length >= 1 && value.length <= max;
  const toId = value => typeof value === 'string' && value.length <= 64 ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';

  function pokemon(raw, side) {
    if (!raw || typeof raw.ident !== 'string' || raw.ident.length > 68 || !raw.ident.startsWith(side + ': ') ||
        !matches(raw.ident.slice(4), label) ||
        !matches(raw.details, /^[\p{L}\p{N} .'%:’♀♂-]{1,64}(?:, (?:L[1-9]\d{0,2}|[MF]|shiny|tera:[A-Za-z]+)){0,5}$/u) ||
        !matches(raw.condition, /^(?:0 fnt|[1-9]\d{0,3}\/[1-9]\d{0,3}(?: (?:brn|par|psn|tox|slp|frz))?)$/) ||
        typeof raw.active !== 'boolean' || !list(raw.moves, 4) || !raw.moves.every(move => matches(move, id)) ||
        !matches(raw.baseAbility, id) || !matches(raw.ability, id) || (raw.item !== '' && !matches(raw.item, id)) ||
        !matches(raw.teraType, type) || (raw.terastallized !== '' && !matches(raw.terastallized, type)) ||
        typeof raw.reviving !== 'boolean' || raw.commanding === true) return null;
    const stats = {};
    if (raw.condition !== '0 fnt') {
      const [hp, max] = raw.condition.split(' ')[0].split('/').map(Number);
      if (hp > max || max > 4096) return null;
    }
    for (const key of ['atk', 'def', 'spa', 'spd', 'spe']) {
      if (!integer(raw.stats?.[key], 1, 4096)) return null;
      stats[key] = raw.stats[key];
    }
    return { ident: raw.ident, details: raw.details, condition: raw.condition, active: raw.active,
      stats, moves: [...raw.moves], baseAbility: raw.baseAbility, ability: raw.ability, item: raw.item,
      teraType: raw.teraType, terastallized: raw.terastallized, reviving: raw.reviving };
  }

  function projectRequest(raw, side, name) {
    if (!raw || !['p1', 'p2'].includes(side) || raw.side?.id !== side || raw.side.name !== name ||
        !matches(name, /^[a-z][a-z0-9]{2,17}$/i) || !integer(raw.rqid, 1, 1000000) ||
        raw.wait || raw.teamPreview || raw.ally || !list(raw.side.pokemon, 6)) return null;
    const team = raw.side.pokemon.map(mon => pokemon(mon, side));
    if (team.includes(null) || !team[0].active || team.slice(1).some(mon => mon.active)) return null;
    const request = { rqid: raw.rqid, side: { id: side, name, pokemon: team } };
    for (const key of ['noCancel', 'update']) {
      if (raw[key] !== undefined && typeof raw[key] !== 'boolean') return null;
      if (raw[key] === true) request[key] = true;
    }
    if (raw.forceSwitch) {
      if (raw.active || !list(raw.forceSwitch, 1) || raw.forceSwitch[0] !== true) return null;
      request.forceSwitch = [true];
      return request;
    }
    if (!list(raw.active, 1)) return null;
    const menu = raw.active[0];
    if (!menu || !list(menu.moves, 4) || menu.canMegaEvo || menu.canMegaEvoX || menu.canMegaEvoY ||
        menu.canZMove || menu.canDynamax || menu.canUltraBurst || menu.maxMoves) return null;
    const active = { moves: [] };
    for (const move of menu.moves) {
      if (!move || !matches(move.id, id) || !matches(move.move, label)) return null;
      const item = { id: move.id, move: move.move };
      if (move.pp !== undefined || move.maxpp !== undefined) {
        if (!integer(move.maxpp, 1, 64) || !integer(move.pp, 0, move.maxpp)) return null;
        Object.assign(item, { pp: move.pp, maxpp: move.maxpp });
      }
      if (move.target !== undefined) {
        if (!matches(move.target, /^[a-zA-Z]{1,30}$/)) return null;
        item.target = move.target;
      }
      if (move.disabled !== undefined) {
        if (typeof move.disabled !== 'boolean') return null;
        item.disabled = move.disabled;
      }
      active.moves.push(item);
    }
    for (const key of ['trapped', 'maybeTrapped', 'maybeDisabled', 'maybeLocked']) {
      if (menu[key] !== undefined && typeof menu[key] !== 'boolean') return null;
      if (menu[key] === true) active[key] = true;
    }
    if (menu.canTerastallize !== undefined) {
      if (!matches(menu.canTerastallize, type)) return null;
      active.canTerastallize = menu.canTerastallize;
    }
    request.active = [active];
    return request;
  }

  function offered(request, choice) {
    if (!matches(choice, /^(?:move [1-4](?: terastallize)?|switch [1-6])$/)) return false;
    const [kind, index, tera] = choice.split(' ');
    const active = request.active?.[0];
    if (kind === 'move') {
      const move = active?.moves[Number(index) - 1];
      return Boolean(move && !move.disabled && move.pp !== 0 && (!tera || active.canTerastallize));
    }
    const mon = request.side.pokemon[Number(index) - 1];
    if (!mon) return false;
    if (request.forceSwitch && request.side.pokemon[0].reviving) return mon.condition === '0 fnt';
    return !mon.active && !active?.trapped && mon.condition !== '0 fnt';
  }

  // The pinned room server advances after every required choice. A new request
  // alone can instead be a retry or a rejoin. Require intervening gameplay;
  // after an undo, also require positive evidence of the final selection.
  function recorder(name) {
    const decisions = [];
    let current = null, skipped = 0, truncated = false, highId = 0, ended = false;
    function countSkip() { skipped = Math.min(1000000, skipped + 1); }
    function settle(resolved) {
      if (!current) return;
      if (resolved && current.progress && current.choice &&
          (!current.undo || (current.observed && current.tera === current.choice.endsWith(' terastallize')))) {
        if (decisions.length < limit) {
          decisions.push({ rqid: current.request.rqid, boundary: current.boundary, request: current.request, choice: current.choice });
        } else truncated = true;
      } else countSkip();
      current = null;
    }
    function receive(raw, sentChoice, boundary) {
      if (ended) return;
      const fresh = integer(raw?.rqid, highId + 1, 1000000);
      settle(fresh && !raw?.update && !sentChoice);
      if (!fresh) return;
      highId = raw.rqid;
      if (raw.wait) return;
      const request = !sentChoice && projectRequest(raw, raw.side?.id, name);
      if (!request || !integer(boundary, 0, 30000)) { countSkip(); return; }
      current = { request, boundary, choice: '', progress: false, observed: false, undo: false, tera: false };
    }
    function send(data) {
      if (!current || typeof data !== 'string') return;
      if (/^\/undo(?:\||$)/.test(data)) {
        if (current.progress) { settle(false); return; }
        current.undo = true;
        current.choice = '';
        return;
      }
      if (!/^\/(?:choose|move|switch|team|default|pass|forfeit|leavebattle|testfight)\b/i.test(data)) return;
      const match = data.length <= 100 && /^\/(?:choose )?((?:move|switch) [1-6](?: terastallize)?)\|(\d{1,7})$/.exec(data);
      if (current.choice || !match || Number(match[2]) !== current.request.rqid || !offered(current.request, match[1])) {
        settle(false);
        return;
      }
      current.choice = match[1];
    }
    function protocol(data) {
      if (ended || typeof data !== 'string' || data.startsWith('|request|')) return;
      if (data.length > 131072 || data.startsWith('|init|') || data.startsWith('|deinit|')) { settle(false); return; }
      if (!current) return;
      for (const line of data.split('\n')) {
        if (/^\|(?:error|callback|sentchoice|expire)(?:\||$)/.test(line)) { settle(false); return; }
        if (!current.choice && /^\|(?:-|turn\||detailschange\||replace\|)/.test(line)) { settle(false); return; }
        if (current.undo && line.startsWith('|-terastallize|') &&
            line.split('|', 3)[2] === current.request.side.pokemon[0].ident.replace(': ', 'a: ')) current.tera = true;
        if (/^\|(?:move|switch|cant|faint|drag)\|/.test(line)) {
          if (!current.choice) { settle(false); return; }
          current.progress = true;
          if (current.undo) {
            const [, event, actor, action] = line.split('|', 4);
            const [kind, slot] = current.choice.split(' ');
            const team = current.request.side.pokemon;
            const expected = kind === 'switch' ? team[Number(slot) - 1].ident : team[0].ident;
            if (actor === expected.replace(': ', 'a: ') && !line.includes('|[from]')) {
              if (event === 'switch' && kind === event) current.observed = true;
              if (event === 'move' && kind === event && toId(action) === current.request.active[0].moves[Number(slot) - 1].id) current.observed = true;
            }
          }
        }
        if (line.startsWith('|win|') || line === '|tie') { settle(true); ended = true; return; }
      }
    }
    function discardQueue() {
      settle(false);
      skipped = Math.min(1000000, skipped + decisions.length);
      decisions.length = 0;
    }
    return { receive, send, protocol, invalidate: () => settle(false), discardQueue,
      snapshot: () => ({ decisions, skipped, truncated }) };
  }

  function install(page, name) {
    const client = page.app, proto = page.BattleRoom?.prototype;
    if (!client || !proto || !matches(name, /^[a-z][a-z0-9]{2,17}$/i) ||
        !['receiveRequest', 'add'].every(key => typeof proto[key] === 'function') || typeof client.send !== 'function') return false;
    if (page.__sdPracticeDecisionHistory) return true;
    const rooms = new WeakMap();
    function inQueue(room) {
      const state = rooms.get(room);
      if (state && state.queue !== room.battle?.stepQueue) {
        state.history.discardQueue();
        state.queue = room.battle?.stepQueue;
      }
      return state?.history;
    }
    function ownRoom(room) {
      return roomId.test(room?.id) && client.rooms?.[room.id] === room && toId(client.user?.get('userid')) === toId(name);
    }
    const receive = proto.receiveRequest, add = proto.add, send = client.send;
    proto.receiveRequest = function (raw, sentChoice) {
      try {
        if (ownRoom(this)) {
          if (!inQueue(this)) rooms.set(this, { history: recorder(name), queue: this.battle.stepQueue });
          rooms.get(this).history.receive(raw, sentChoice, this.battle.stepQueue.length);
        }
      } catch { rooms.delete(this); }
      return receive.apply(this, arguments);
    };
    proto.add = function (data) {
      try {
        // The client may replace its queue on rejoin. Its old indices cannot be reused.
        if (typeof data === 'string' && data.startsWith('|init|')) inQueue(this)?.discardQueue();
        else inQueue(this)?.protocol(data);
      } catch { rooms.delete(this); }
      return add.apply(this, arguments);
    };
    client.send = function (data, id) {
      let room;
      try {
        let command = data;
        let destination = id;
        if (id === true && typeof data === 'string') {
          const sep = data.indexOf('|');
          if (sep > 0 && sep < 80) { destination = data.slice(0, sep); command = data.slice(sep + 1); }
        }
        if (typeof destination === 'string' && roomId.test(destination)) room = client.rooms[destination];
        const history = room && inQueue(room);
        if (history) {
          if (client.isDisconnected || client.socket?.readyState !== 1 || !ownRoom(room)) history.invalidate();
          else history.send(command);
        }
      } catch { if (room) rooms.delete(room); }
      try { return send.apply(this, arguments); }
      catch (error) { if (room) rooms.delete(room); throw error; }
    };
    Object.defineProperty(page, '__sdPracticeDecisionHistory', { value: room => {
      if (!ownRoom(room) || !(room.battle?.ended || room.battleEnded)) return null;
      return inQueue(room)?.snapshot() || null;
    } });
    return true;
  }

  // Re-project at both ends of the sandbox boundary. The public log is scanned
  // once to derive the turn and verify strictly ordered, pre-result offsets.
  function sanitize(raw, side, log, mapped) {
    if (!raw || !['p1', 'p2'].includes(side) || !Array.isArray(raw.decisions) || raw.decisions.length > limit ||
        !integer(raw.skipped, 0, 1000000) || typeof raw.truncated !== 'boolean') return null;
    const lines = log.split('\n');
    if (!lines.includes('|gen|9') || !lines.includes('|gametype|singles') ||
        !lines.includes('|tier|[Gen 9] Random Battle') || lines.includes('|-reviewcustomrules|')) return null;
    const name = lines.find(line => line.startsWith('|player|' + side + '|'))?.split('|')[3];
    let last = -1, rqid = 0, index = 0, turn = 0, skipped = raw.skipped;
    const decisions = [];
    for (const row of raw.decisions) {
      const boundary = mapped ? mapped.get(row?.boundary) : row?.boundary;
      if (!integer(boundary, last + 1, lines.length - 1) || !integer(row?.rqid, rqid + 1, 1000000) ||
          row.request?.rqid !== row.rqid) return null;
      for (; index < boundary; index++) {
        if (/^\|turn\|\d{1,4}$/.test(lines[index])) turn = Number(lines[index].slice(6));
        if (lines[index] === '|tie' || lines[index].startsWith('|win|')) return null;
      }
      last = boundary;
      rqid = row.rqid;
      const request = projectRequest(row.request, side, name);
      if (!request || !offered(request, row.choice)) return null;
      if (!turn) { skipped = Math.min(1000000, skipped + 1); continue; }
      decisions.push({ rqid, turn, boundary, request, choice: row.choice });
    }
    return { version: 1, format: 'gen9randombattle', side, decisions, skipped, truncated: raw.truncated };
  }
  return { install, sanitize, recorder, limit };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { battleReviewCapture };
