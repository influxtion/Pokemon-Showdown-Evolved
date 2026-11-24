'use strict';

const path = require('node:path');
const { extractProtocol } = require('../../app/battle-review-input');
const { battleReviewCapture } = require('../../app/battle-review-capture');
const simulatorRoot = path.resolve(__dirname, '../../vendor/practice/dist/server');

// The test driver can play both seats. Only the selected player's request and the spectator
// protocol leave this function. The app never receives either generated roster or its seed.
function practiceGame(index = 1, maxDecisions = 160, side = 'p1') {
  const { Battle, Teams, Dex } = require(path.join(simulatorRoot, 'dist/sim'));
  const { extractChannelMessages } = require(path.join(simulatorRoot, 'dist/sim/battle'));
  const seed = n => [2222 + index, 652 + n, 413 + index * 5, 983 + n * 7];
  const roster = n => Teams.generate('gen9randombattle', { seed: seed(n) });
  const b = new Battle({ formatid: 'gen9randombattle', seed: seed(3),
    p1: { name: 'PlayerOne', team: roster(1) }, p2: { name: 'PlayerTwo', team: roster(2) } });
  const decisions = [];
  const publicLines = () => extractChannelMessages(b.log.join('\n'), [0])[0];
  function choose(request, number) {
    if (request.forceSwitch) {
      const revive = request.side.pokemon.some(mon => mon.reviving);
      const slot = request.side.pokemon.findIndex(mon => !mon.active && !mon.reviving && Boolean(mon.condition.endsWith(' fnt')) === revive);
      return 'switch ' + (slot + 1);
    }
    const choices = request.active[0].moves.map((move, slot) => ({ move, slot }))
      .filter(({ move }) => !move.disabled && move.pp !== 0);
    const attacks = choices.filter(({ move }) => Dex.moves.get(move.id).category !== 'Status');
    const options = attacks.length ? attacks : choices;
    return 'move ' + (options[number % options.length].slot + 1);
  }
  try {
    for (let step = 0; step < maxDecisions && !b.ended; step++) {
      const requests = Object.fromEntries(['p1', 'p2'].map(key => [key, structuredClone(b[key].activeRequest)]));
      const choices = {};
      for (const key of ['p1', 'p2']) {
        const req = requests[key];
        if (!req || req.wait) continue;
        choices[key] = choose(req, index + step);
      }
      if (choices[side]) {
        const request = requests[side];
        request.rqid = step + 1;
        const prefix = extractProtocol([...publicLines(), '|tie'].join('\n'), 'log');
        decisions.push({ turn: b.turn, rqid: request.rqid, boundary: prefix.split('\n').length - 1,
          request, choice: choices[side] });
      }
      for (const [key, choice] of Object.entries(choices)) {
        if (!b.choose(key, choice)) throw new Error('Practice fixture submitted an unavailable choice');
      }
    }
    if (!b.ended) b.win(b.p1);
    const log = extractProtocol(publicLines().join('\n'), 'log');
    const capture = battleReviewCapture().sanitize({ decisions, truncated: false, skipped: 0 }, side, log);
    if (!capture) throw new Error('Practice fixture failed the player projection');
    return { log, side, capture };
  } finally { b.destroy(); }
}

module.exports = { practiceGame, simulatorRoot };

// Reproduce the full-game coverage sample without an account, client or inference service.
if (require.main === module) {
  const { BattleReviewInput } = require('../../app/battle-review-input');
  (async () => {
    for (let index = 1; index <= 8; index++) {
      const game = practiceGame(index);
      const service = new BattleReviewInput({ simulatorRoot, capture: () => game });
      const start = Date.now();
      const result = await service.review({ kind: 'practice', roomId: 'battle-gen9randombattle-1' });
      if (!result.ok) throw new Error(result.error);
      const report = service.status().report;
      const seat = report.sides[game.side];
      const menus = seat.turns.flatMap(row => (row.requests || []).map(menu => ({ turn: row.turn, menu })));
      const skipped = {};
      for (const { menu } of menus) {
        if (menu.reason) skipped[menu.reason] = (skipped[menu.reason] || 0) + 1;
      }
      console.log(JSON.stringify({ index, turns: report.turnCount, elapsedMs: Date.now() - start,
        ...seat.practice, simulatedTurns: menus.filter(r => r.menu.tactics).map(r => r.turn),
        lateTypeMatchups: menus.filter(r => r.turn > 4 && r.menu.matchup).length, skipped }));
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
