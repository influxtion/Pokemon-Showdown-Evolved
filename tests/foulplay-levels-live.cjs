'use strict';

// Plays bots against each other on the private simulator to check that the Foul Play levels are
// clearly apart (Casual beats Heuristic, Medium beats Casual, Hard beats Medium), and that OU
// battles finish. Foul Play runs as workers from a local install of the practice API runtime;
// the simple bots run in this process. Development only: nothing here ships in the app.
//
//   node tests/foulplay-levels-live.cjs --runtime api/runtime [--games 20] [--parallel 4] [--threads 2]
//     [--pair casual:heuristic] [--pair medium:casual] ...      (default: the three pairings above)
//     [--format gen9ou --team tests/fixtures/ou-team.txt]      (OU: both sides use this team)
// The simulator comes from vendor/practice/dist (npm run build:practice).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { parseArgs } = require('node:util');
const { WebSocket } = require('ws');
const { inspect } = require('../api/install');
const { LocalBot, loadData } = require('../app/simple-bots');

const root = path.join(__dirname, '..');
const { values } = parseArgs({ options: { runtime: { type: 'string' }, games: { type: 'string', default: '20' },
  parallel: { type: 'string', default: '4' }, threads: { type: 'string', default: '2' }, pair: { type: 'string', multiple: true },
  format: { type: 'string', default: 'gen9randombattle' }, team: { type: 'string' } } });
if (!values.runtime) throw new Error('Pass --runtime <dir> (a Foul Play install from npm run api:setup).');
const runtime = inspect(path.resolve(values.runtime));
assert.equal(runtime.installed, true, 'Foul Play is not installed in --runtime');
const simulatorRoot = path.join(root, 'vendor/practice/dist');
const FORMAT = values.format;
const LEVELS = ['hard', 'medium', 'casual'];
const SIMPLE = ['heuristic', 'greedy', 'random'];
const teamText = values.team ? fs.readFileSync(path.resolve(values.team), 'utf8') : null;
if (FORMAT !== 'gen9randombattle' && !teamText) throw new Error('OU needs --team <Showdown export>.');
const { Teams } = require(path.join(simulatorRoot, 'server/dist/sim'));
const packed = teamText ? Teams.pack(Teams.import(teamText)) : 'null';

function lines(stream, onEvent) {
  let buffer = '';
  stream.on('data', data => {
    buffer += data;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try { onEvent(JSON.parse(line)); } catch { /* Not an event. */ }
    }
  });
}

// One side's brain: a Foul Play worker at a level, or a simple bot. Emits `choice`.
function engine(kind, account) {
  if (SIMPLE.includes(kind)) return new LocalBot({ kind, data: loadData(path.join(simulatorRoot, 'server')) });
  const brain = new EventEmitter();
  const child = spawn(runtime.python, ['-I', '-B', runtime.worker, '--source', runtime.source, '--threads', values.threads,
    '--level', kind, '--format', FORMAT, '--account', account], { stdio: ['pipe', 'pipe', 'pipe'] });
  // Upstream diagnostics, kept only to explain a crash.
  const tail = [];
  child.stderr.on('data', data => { tail.push(...String(data).split('\n').filter(Boolean)); tail.splice(0, Math.max(0, tail.length - 12)); });
  brain.closed = false;
  if (teamText) child.stdin.write(`${JSON.stringify({ type: 'team', data: teamText })}\n`);
  brain.ready = new Promise((resolve, reject) => {
    lines(child.stdout, event => {
      if (event.type === 'ready') resolve();
      else if (event.type === 'error') reject(new Error(`${kind} worker failed: ${event.code}`));
      else if (event.type === 'choice') brain.emit('choice', event);
    });
    child.once('exit', code => {
      const error = new Error(`${kind} worker exited (${code}):\n${tail.join('\n')}`);
      reject(error);
      // Mid-match, a dead worker would leave its battle waiting forever.
      if (!brain.closed) brain.emit('crash', error);
    });
  });
  child.stdin.on('error', () => {});
  brain.send = frame => { if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: 'frame', data: frame })}\n`); };
  brain.close = () => { brain.closed = true; child.stdin.end(); child.kill(); };
  return brain;
}

function simulator() {
  const token = crypto.randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [path.join(root, 'scripts/practice/server.cjs'), '--server-root',
    path.join(simulatorRoot, 'server'), '--port', '0', '--token', token], { stdio: ['pipe', 'pipe', 'ignore'] });
  return { child, token, port: new Promise(resolve => lines(child.stdout, event => { if (event.type === 'ready') resolve(event.port); })) };
}

// Logs in as `account`, forwards battle frames to its engine and the engine's choices back.
function seat({ port, token, account, brain, onEnd }) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/showdown/websocket?token=${token}`, { maxPayload: 2 ** 22 });
  let named;
  const ready = new Promise(resolve => { named = resolve; });
  let room = null;
  brain.on('choice', choice => { if (choice.room === room) socket.send(`${room}|${choice.choice}${choice.rqid ? `|${choice.rqid}` : ''}`); });
  socket.on('message', data => {
    const text = data.toString();
    const all = text.split('\n');
    if (text.includes('|challstr|')) socket.send(`|/trn ${account},0,`);
    if (all.some(line => line.startsWith(`|updateuser| ${account}|1|`))) named();
    for (const line of all) {
      const parts = line.split('|');
      if (parts[1] === 'pm' && parts[4] === `/challenge ${FORMAT}` && parts[3].trim() === account) {
        socket.send(`|/utm ${packed}`);
        socket.send(`|/accept ${parts[2].trim()}`);
      }
      if (parts[1] === 'popup') console.error(`${account}: ${line}`);
    }
    if (!all[0].startsWith(`>battle-${FORMAT}-`)) return;
    const id = all[0].slice(1);
    if (all.includes('|init|battle')) room = id;
    if (id !== room) return;
    brain.send(text);
    const end = all.find(line => line.startsWith('|win|') || line === '|tie');
    if (end) {
      socket.send(`|/leave ${room}`);
      room = null;
      onEnd(end === '|tie' ? null : end.slice(5));
    }
  });
  return { socket, ready, challenge(opponent) { socket.send(`|/utm ${packed}`); socket.send(`|/challenge ${opponent}, ${FORMAT}`); } };
}

const accountFor = (kind, side) => `${kind.replace(/[^a-z]/g, '').slice(0, 10)}${side}`.replace(/^./, c => c.toUpperCase());

// Plays `games` battles between a and b on one simulator, alternating who challenges.
async function match(a, b, games) {
  const sim = simulator();
  const port = await sim.port;
  const names = [accountFor(a, 'A'), accountFor(b, 'B')];
  const brains = [engine(a, names[0]), engine(b, names[1])];
  await Promise.all(brains.map(brain => brain.ready));
  let resolveGame;
  const seats = names.map((account, index) => seat({ port, token: sim.token, account, brain: brains[index],
    onEnd: winner => { if (index === 0) resolveGame(winner); } }));
  await Promise.all(seats.map(value => value.ready));
  const score = { [a]: 0, [b]: 0, tie: 0 };
  let crashed;
  const crash = new Promise((_resolve, reject) => { crashed = reject; });
  crash.catch(() => {});
  for (const brain of brains) brain.on('crash', crashed);
  for (let game = 0; game < games; game++) {
    const result = Promise.race([new Promise(resolve => { resolveGame = resolve; }), crash]);
    const challenger = game % 2;
    seats[challenger].challenge(names[1 - challenger]);
    const winner = await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('timeout'), 900000))]);
    if (winner === 'timeout') throw new Error(`${a} vs ${b}: a battle did not finish`);
    if (winner === names[0]) score[a]++; else if (winner === names[1]) score[b]++; else score.tie++;
  }
  for (const value of seats) value.socket.terminate();
  for (const brain of brains) brain.close();
  sim.child.kill();
  return score;
}

async function main() {
  const pairs = (values.pair || ['casual:heuristic', 'medium:casual', 'hard:medium']).map(value => value.split(':'));
  for (const pair of pairs) {
    assert.ok(pair.length === 2 && pair.every(kind => LEVELS.includes(kind) || SIMPLE.includes(kind)), `Unknown pairing: ${pair}`);
  }
  const games = Number(values.games);
  const parallel = Math.max(1, Number(values.parallel));
  for (const [a, b] of pairs) {
    const started = Date.now();
    const shares = Array.from({ length: parallel }, (_, index) => Math.floor(games / parallel) + (index < games % parallel ? 1 : 0))
      .filter(Boolean);
    const scores = await Promise.all(shares.map(count => match(a, b, count)));
    const total = scores.reduce((sum, score) => ({ [a]: sum[a] + score[a], [b]: sum[b] + score[b], tie: sum.tie + score.tie }),
      { [a]: 0, [b]: 0, tie: 0 });
    console.log(JSON.stringify({ format: FORMAT, pair: `${a} vs ${b}`, ...total, games,
      winRate: Math.round((100 * total[a]) / games), seconds: Math.round((Date.now() - started) / 1000) }));
  }
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
