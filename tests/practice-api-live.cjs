'use strict';

// Two full battles against Foul Play through the practice inference API, without Electron:
// a real simulator, the real bridge (PracticeSession) and a real local API server and worker.
// A scripted player challenges, plays "/choose default" every turn, and rematches once.
//
//   node tests/practice-api-live.cjs --runtime <foul play install dir>
// The simulator comes from out/bots/config.json (npm run bots:setup) or vendor/laplace/dist.

const assert = require('node:assert/strict');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { WebSocket } = require('ws');
const { PracticeSession } = require('../app/practice-session');
const { LocalEngine } = require('../app/practice-engines');
const { readBotConfig } = require('../app/bot-config');

const root = path.join(__dirname, '..');
const { values } = parseArgs({ options: { runtime: { type: 'string' }, preset: { type: 'string', default: 'quiet' } } });
if (!values.runtime) throw new Error('Pass --runtime <dir> (a Foul Play install from api/install.js).');
const config = readBotConfig(path.join(root, 'out/bots/config.json'));
const simulatorRoot = config?.root || path.join(root, 'vendor/laplace/dist');

function player(connection) {
  const socket = new WebSocket(`ws://127.0.0.1:${connection.port}/showdown/websocket?token=${connection.token}`);
  const results = [];
  let resolveBattle;
  const battle = () => new Promise(resolve => { resolveBattle = resolve; });
  socket.on('message', data => {
    const text = data.toString();
    const lines = text.split('\n');
    if (text.includes('|challstr|')) socket.send(`|/trn ${connection.human},0,`);
    if (lines.some(line => line.startsWith(`|updateuser| ${connection.human}|1|`))) {
      socket.send('|/utm null');
      socket.send(`|/challenge ${connection.bot}, gen9randombattle`);
    }
    if (!lines[0].startsWith('>battle-')) return;
    const room = lines[0].slice(1);
    for (const line of lines) {
      if (line.startsWith('|request|') && line.length > 9) {
        const request = JSON.parse(line.slice(9));
        if (!request.wait) socket.send(`${room}|/choose default|${request.rqid}`);
      }
      if (line.startsWith('|win|') || line === '|tie') {
        results.push(line);
        resolveBattle?.(line);
        socket.send(`|/leave ${room}`);
      }
    }
  });
  return { socket, battle, rematch() { socket.send('|/utm null'); socket.send(`|/challenge ${connection.bot}, gen9randombattle`); } };
}

async function finished(session) {
  for (let i = 0; i < 100 && !session.status().battle?.finished; i++) await new Promise(resolve => setTimeout(resolve, 50));
  return session.status();
}

async function main() {
  const local = new LocalEngine({ dir: path.resolve(values.runtime) });
  assert.equal(local.status().installed, true, 'Foul Play is not installed in --runtime');
  const session = new PracticeSession({ root: simulatorRoot, scripts: path.join(root, 'scripts/laplace'),
    engines: engine => { assert.equal(engine, 'local'); return local.target(); },
    verify: () => ({ promise: Promise.resolve({ ok: true }), cancel() {} }), installed: () => true });
  const decisions = [];
  session.on('change', status => {
    if (status.battle?.elapsedMs !== undefined && !status.battle.thinking) decisions.push(status.battle.elapsedMs);
  });
  const timeout = setTimeout(() => { console.error('Timed out', session.status()); process.exit(1); }, 600000);
  const ready = new Promise(resolve => session.once('ready', resolve));
  const started = await session.start({ opponent: 'foulplay', preset: values.preset, engine: 'local' });
  assert.equal(started.ok, true, started.error);
  const connection = await ready;
  assert.equal(session.status().state, 'ready');
  assert.equal(session.status().threads, 1);
  console.log('Practice ready; playing two battles against Foul Play.');

  const human = player(connection);
  const first = await human.battle();
  const firstStatus = await finished(session);
  assert.equal(firstStatus.battle.finished, true);
  assert.ok(['win', 'loss', 'tie'].includes(firstStatus.battle.result));
  assert.ok(firstStatus.battle.turn > 1, 'the battle should last several turns');
  console.log(`Battle 1: ${first} after ${firstStatus.battle.turn} turns, result for the player: ${firstStatus.battle.result}`);

  human.rematch();
  const second = await human.battle();
  const secondStatus = await finished(session);
  assert.equal(secondStatus.battle.finished, true);
  console.log(`Battle 2: ${second} after ${secondStatus.battle.turn} turns`);
  assert.ok(decisions.length > 10, 'Foul Play should have made many decisions');
  const sorted = [...decisions].sort((a, b) => a - b);
  console.log(`${decisions.length} decisions, median ${sorted[Math.floor(sorted.length / 2)]} ms`);

  session.stop();
  human.socket.close();
  await local.dispose();
  clearTimeout(timeout);
  assert.equal(session.status().state, 'idle');
  console.log('OK');
}

main().catch(error => { console.error(error); process.exit(1); });
