'use strict';

// Two full battles against Foul Play through the practice inference API, without Electron:
// a real simulator, the real bridge (PracticeSession) and a real API server and worker.
// A scripted player challenges, plays "/choose default" every turn, and rematches once.
//
//   node tests/practice-api-live.cjs --runtime <foul play install dir>     (a stand-in API on loopback)
//   node tests/practice-api-live.cjs --url https://host [--key KEY]       (a deployed API)
// Add --opponent foulplay-medium|foulplay-casual for a weaker level, or --format gen9ou --team <export>
// for OU, where both sides use that team (the player plays it too).
// The simulator comes from vendor/practice/dist (npm run build:practice).

const assert = require('node:assert/strict');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { WebSocket } = require('ws');
const { PracticeSession } = require('../app/practice-session');
const crypto = require('node:crypto');
const { CloudEngine } = require('../app/practice-engines');
const { inspect } = require('../api/install');
const { createApiServer } = require('../api/server');
const { PracticeTeams } = require('../app/practice-teams');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const { values } = parseArgs({ options: { runtime: { type: 'string' }, url: { type: 'string' }, key: { type: 'string' },
  preset: { type: 'string', default: 'quiet' }, opponent: { type: 'string', default: 'foulplay' },
  format: { type: 'string', default: 'gen9randombattle' }, team: { type: 'string' } } });
if (!values.runtime === !values.url) throw new Error('Pass --runtime <dir> (a Foul Play install) or --url <deployed API>.');
const simulatorRoot = path.join(root, 'vendor/practice/dist');
const FORMAT = values.format;
// OU: one team, checked the way the app checks teams, used for both sides.
const team = FORMAT === 'gen9randombattle' ? null
  : new PracticeTeams({ root: simulatorRoot }).check(FORMAT, 'export', fs.readFileSync(path.resolve(values.team || ''), 'utf8'));
if (team && !team.ok) throw new Error(team.error);

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
      socket.send(`|/utm ${connection.team || 'null'}`);
      socket.send(`|/challenge ${connection.bot}, ${FORMAT}`);
    }
    if (text.includes('|popup|')) console.error(text);
    if (!lines[0].startsWith('>battle-')) return;
    const room = lines[0].slice(1);
    for (const line of lines) {
      if (line.startsWith('|request|') && line.length > 9) {
        const request = JSON.parse(line.slice(9));
        if (!request.wait) socket.send(`${room}|${request.teamPreview ? '/team 123456' : '/choose default'}|${request.rqid}`);
      }
      if (line.startsWith('|win|') || line === '|tie') {
        results.push(line);
        resolveBattle?.(line);
        socket.send(`|/leave ${room}`);
      }
    }
  });
  return { socket, battle, rematch() { socket.send(`|/utm ${connection.team || 'null'}`); socket.send(`|/challenge ${connection.bot}, ${FORMAT}`); } };
}

async function finished(session) {
  for (let i = 0; i < 100 && !session.status().battle?.finished; i++) await new Promise(resolve => setTimeout(resolve, 50));
  return session.status();
}

async function main() {
  // With --runtime, the same server the cloud runs starts here on loopback with an API key.
  let service = null;
  let target = { url: values.url, key: values.key || null };
  if (values.runtime) {
    const runtime = inspect(path.resolve(values.runtime));
    assert.equal(runtime.installed, true, 'Foul Play is not installed in --runtime');
    const key = crypto.randomBytes(32).toString('hex');
    service = createApiServer({ runtime, apiKey: key });
    target = { url: await service.listen(), key };
  }
  const cloud = new CloudEngine(target);
  const session = new PracticeSession({ root: simulatorRoot, scripts: path.join(root, 'scripts/practice'),
    target: () => cloud.target(),
    verify: () => ({ promise: Promise.resolve({ ok: true }), cancel() {} }), installed: () => true });
  const decisions = [];
  let thinking = false;
  session.on('change', status => {
    // One decision is one thinking -> chosen transition (a battle ending mid-search does not count).
    const now = Boolean(status.battle?.thinking);
    if (thinking && !now && !status.battle?.finished) decisions.push(status.battle.elapsedMs);
    thinking = now;
  });
  const timeout = setTimeout(() => { console.error('Timed out', session.status()); process.exit(1); }, 600000);
  const ready = new Promise(resolve => session.once('ready', resolve));
  const started = await session.start({ opponent: values.opponent, preset: values.preset, format: FORMAT,
    ...(team ? { teams: { player: team.packed, bot: team.packed, botExport: team.exported } } : {}) });
  assert.equal(started.ok, true, started.error);
  const connection = await ready;
  assert.equal(session.status().state, 'ready');
  console.log(`Practice ready (${values.url ? 'deployed API' : 'loopback API'}, ${session.status().threads} search thread(s)); playing two ${FORMAT} battles against ${values.opponent}.`);

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
  await service?.close();
  clearTimeout(timeout);
  assert.equal(session.status().state, 'idle');
  console.log('OK');
}

main().catch(error => { console.error(error); process.exit(1); });
