'use strict';

// Installs the pinned Foul Play runtime: standalone Python, Foul Play's source and packages,
// poke-engine built with Terastallization, and Random Battle and OU data. Used by the API server
// (`npm run setup`) and by the app when a player opts in. The worker never downloads anything.
// `npm run refresh-ou` moves the OU pins to the newest data, by hand.
//
// Layout under `dir`:
//   current/    the runtime in use (python/, foul-play/, install.json)
//   staging/    a build in progress; becomes current/ once it passes its check
//   toolchain/  a private Rust toolchain if none was found; removed after a build

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const lock = require('./lock.json');

// Changes whenever any pin changes, so an older install is reported as needing an update.
const LOCK_VERSION = crypto.createHash('sha256').update(JSON.stringify(lock)).digest('hex').slice(0, 16);
const WORKER = path.join(__dirname, 'worker', 'foulplay_worker.py');
// Use Windows' bsdtar: Git Bash's GNU tar comes first on PATH and reads `C:\...` as a remote host.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
// Roughly how many crates cargo compiles for poke-engine; only used to move the progress bar.
const ENGINE_CRATES = 40;

const STEPS = Object.freeze([
  { id: 'python', label: 'Downloading Python', weight: 8 },
  { id: 'toolchain', label: 'Preparing the Rust compiler', weight: 17 },
  { id: 'source', label: 'Downloading Foul Play', weight: 3 },
  { id: 'packages', label: 'Installing Python packages', weight: 7 },
  { id: 'engine', label: 'Compiling the search engine', weight: 55 },
  { id: 'data', label: 'Downloading set data and usage stats', weight: 4 },
  { id: 'verify', label: 'Checking the engine', weight: 3 },
  { id: 'finish', label: 'Finishing up', weight: 3 },
]);
const TOTAL_WEIGHT = STEPS.reduce((sum, step) => sum + step.weight, 0);
// Formats the worker checks after a build; each must load without a download.
const FORMATS = Object.freeze(['gen9randombattle', 'gen9ou']);
// Where Foul Play looks for each OU file, relative to fp/data. Usage stats drop their "info"
// header, as Foul Play's cache does.
const OU_FILES = Object.freeze({
  usageStats: ['smogon_stats_cache', 'gen9ou-0.json'],
  showdownSets: ['pkmn_sets_cache', 'gen9ou', 'showdown_sets.json'],
  fullSets: ['pkmn_sets_cache', 'gen9ou', 'pokemon_full_sets.json'],
  replayMoves: ['pkmn_sets_cache', 'gen9ou', 'replay_moves.json'],
});

function platformKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (!lock.python.builds[key] || !lock.rust.builds[key]) throw new Error(`Foul Play can't be installed on ${platform} ${arch} yet.`);
  return key;
}

function pythonExecutable(pythonRoot, platform = process.platform) {
  return platform === 'win32' ? path.join(pythonRoot, 'python.exe') : path.join(pythonRoot, 'bin', 'python3');
}

function paths(dir, worker = WORKER) {
  const current = path.join(dir, 'current');
  return { current, staging: path.join(dir, 'staging'), toolchain: path.join(dir, 'toolchain'),
    python: pythonExecutable(path.join(current, 'python')), source: path.join(current, 'foul-play'),
    manifest: path.join(current, 'install.json'), worker };
}

// What is installed under `dir`, without running anything. `worker` overrides the worker path
// (a packaged app keeps it outside app.asar).
function inspect(dir, worker = WORKER) {
  const where = paths(dir, worker);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(where.manifest, 'utf8')); } catch { /* Not installed. */ }
  const installed = Boolean(manifest && manifest.version === 1 && fs.existsSync(where.python) &&
    fs.existsSync(path.join(where.source, 'fp', 'run_battle.py')));
  return { installed, current: installed && manifest.lock === LOCK_VERSION, lock: LOCK_VERSION,
    revision: installed ? manifest.foulPlay : null, installedAt: installed ? manifest.installedAt : null,
    python: where.python, source: where.source, worker: where.worker };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

async function download(entry, target, { signal, onFraction = () => {}, fetcher = fetch } = {}) {
  if (fs.existsSync(target) && await sha256File(target) === entry.sha256) return target;
  const response = await fetcher(entry.url, { signal, redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${new URL(entry.url).hostname}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const partial = `${target}.partial`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const out = fs.createWriteStream(partial);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
      if (total) onFraction(Math.min(1, received / total));
    }
    await new Promise((resolve, reject) => out.end(error => (error ? reject(error) : resolve())));
  } catch (error) {
    out.destroy();
    await fsp.rm(partial, { force: true });
    throw error;
  }
  if (hash.digest('hex') !== entry.sha256) {
    await fsp.rm(partial, { force: true });
    throw new Error(`Checksum mismatch for ${path.basename(target)}. The download was corrupted or changed upstream.` +
      (entry.refresh ? ' If it changed upstream, run "npm run refresh-ou" and commit the new pins.' : ''));
  }
  await fsp.rename(partial, target);
  return target;
}

// Runs a command, streaming each output line to `onLine`. Rejects with the last lines on failure.
function run(executable, args, { cwd, env, signal, onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = '';
      stream.on('data', data => {
        buffer += data.toString('utf8');
        let index;
        while ((index = buffer.search(/\r?\n|\r/)) !== -1) {
          const line = buffer.slice(0, index).trimEnd();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          tail.push(line);
          if (tail.length > 30) tail.shift();
          onLine(line);
        }
      });
    }
    child.once('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(signal.reason);
      if (code === 0) return resolve();
      const error = new Error(`${path.basename(executable)} exited with code ${code}`);
      error.output = tail.join('\n');
      reject(error);
    });
  });
}

function probe(executable, args, env) {
  return run(executable, args, { env }).then(() => true, () => false);
}

async function extract(archive, destination, signal) {
  await fsp.mkdir(destination, { recursive: true });
  // bsdtar ships with Windows 10+, and tar with every Linux and macOS install.
  await run(TAR, ['-xzf', archive, '-C', destination], { signal });
}

// Uses an existing cargo if there is one; otherwise installs a private, pinned toolchain.
async function toolchain(where, key, { signal, onFraction, onLog }) {
  const home = os.homedir();
  const userCargo = path.join(home, '.cargo', 'bin');
  const base = { ...process.env, PATH: [process.env.PATH, userCargo].filter(Boolean).join(path.delimiter) };
  if (await probe('cargo', ['--version'], base)) {
    onLog('Using the Rust toolchain already on this computer.');
    return { env: base, private: false };
  }
  if (process.platform !== 'win32' && !await probe('cc', ['--version'], base)) {
    throw new Error(process.platform === 'darwin'
      ? 'A C compiler is needed to build the engine. Run "xcode-select --install", then try again.'
      : 'A C compiler is needed to build the engine. Install one (for example "sudo apt install build-essential"), then try again.');
  }
  const build = lock.rust.builds[key];
  const cargoHome = path.join(where.toolchain, 'cargo');
  const rustupHome = path.join(where.toolchain, 'rustup');
  const env = { ...process.env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome,
    PATH: [path.join(cargoHome, 'bin'), process.env.PATH].filter(Boolean).join(path.delimiter) };
  if (await probe(path.join(cargoHome, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'), ['--version'], env)) {
    return { env, private: true };
  }
  const init = path.join(where.toolchain, process.platform === 'win32' ? 'rustup-init.exe' : 'rustup-init');
  await download(build, init, { signal, onFraction: fraction => onFraction(fraction * 0.3) });
  await fsp.chmod(init, 0o755);
  let components = 0;
  await run(init, ['-y', '--no-modify-path', '--profile', 'minimal', '--default-toolchain', lock.rust.toolchain,
    ...(build.host ? ['--default-host', build.host] : [])], { env, signal, onLine: line => {
    onLog(line);
    if (/installing component/i.test(line)) onFraction(0.3 + 0.7 * Math.min(1, ++components / 3));
  } });
  return { env, private: true };
}

async function install({ dir, onProgress = () => {}, onLog = () => {}, signal, keepToolchain = false, worker = WORKER } = {}) {
  if (!dir) throw new Error('Choose an install directory.');
  dir = path.resolve(dir);
  const key = platformKey();
  const where = paths(dir);
  let stepIndex = 0;
  const report = (fraction = 0, detail = '') => {
    const done = STEPS.slice(0, stepIndex).reduce((sum, step) => sum + step.weight, 0);
    const step = STEPS[stepIndex];
    onProgress({ step: step.id, label: step.label, index: stepIndex, steps: STEPS.length, detail,
      fraction: Math.min(1, (done + step.weight * Math.max(0, Math.min(1, fraction))) / TOTAL_WEIGHT) });
  };
  const next = id => { stepIndex = STEPS.findIndex(step => step.id === id); report(0); };
  const log = line => onLog(String(line).slice(0, 500));

  await fsp.rm(where.staging, { recursive: true, force: true });
  await fsp.mkdir(path.join(where.staging, 'downloads'), { recursive: true });
  const downloads = path.join(where.staging, 'downloads');

  next('python');
  const pythonArchive = await download(lock.python.builds[key], path.join(downloads, 'python.tar.gz'),
    { signal, onFraction: fraction => report(fraction * 0.85, 'Downloading') });
  report(0.9, 'Extracting');
  await extract(pythonArchive, where.staging, signal);
  const python = pythonExecutable(path.join(where.staging, 'python'));

  next('toolchain');
  const rust = await toolchain(where, key, { signal, onFraction: fraction => report(fraction), onLog: log });
  const env = { ...rust.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PIP_NO_INPUT: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    // Cargo's default of one optimizing rustc per CPU thread can exhaust memory and crash the build.
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || String(Math.min(4, os.availableParallelism())) };

  next('source');
  const sourceArchive = await download(lock.foulPlay, path.join(downloads, 'foul-play.tar.gz'),
    { signal, onFraction: fraction => report(fraction * 0.8) });
  await extract(sourceArchive, where.staging, signal);
  await fsp.rename(path.join(where.staging, `foul-play-${lock.foulPlay.revision}`), path.join(where.staging, 'foul-play'));

  next('packages');
  let collected = 0;
  await run(python, ['-I', '-m', 'pip', 'install', '--no-warn-script-location', ...lock.packages], { env, signal, onLine: line => {
    log(line);
    if (/^Collecting /.test(line)) report(Math.min(0.9, ++collected / lock.packages.length), line.slice(11));
  } });

  next('engine');
  let crates = 0;
  await run(python, ['-I', '-m', 'pip', 'install', '-v', '--no-warn-script-location', '--no-cache-dir',
    `--no-binary=${lock.engine.package}`, `${lock.engine.package}==${lock.engine.version}`,
    `--config-settings=build-args=--features ${lock.engine.features} --no-default-features`], { env, signal, onLine: line => {
    log(line);
    const crate = /^\s*Compiling (\S+)/.exec(line);
    if (crate) report(Math.min(0.95, ++crates / ENGINE_CRATES), crate[1]);
  } });

  next('data');
  const cache = path.join(where.staging, 'foul-play', 'fp', 'data', 'pkmn_sets_cache');
  await download(lock.randomSets, path.join(cache, 'gen9randombattle.json'), { signal, onFraction: fraction => report(fraction * 0.9) });
  await download(lock.randomSetsLicense, path.join(cache, 'randbats-LICENSE'), { signal });
  await installOuData(path.join(where.staging, 'foul-play', 'fp', 'data'), downloads,
    { signal, onFraction: fraction => report(0.9 + fraction * 0.1, 'OU') });

  next('verify');
  for (const format of FORMATS) {
    await run(python, ['-I', '-B', worker, '--check', '--format', format, '--source', path.join(where.staging, 'foul-play')],
      { env, signal, onLine: log });
  }

  next('finish');
  await fsp.rm(downloads, { recursive: true, force: true });
  await fsp.writeFile(path.join(where.staging, 'install.json'), JSON.stringify({ version: 1, lock: LOCK_VERSION,
    foulPlay: lock.foulPlay.revision, python: lock.python.version, engine: lock.engine.version,
    installedAt: new Date().toISOString() }, null, 2) + '\n');
  const old = path.join(dir, `old-${crypto.randomBytes(4).toString('hex')}`);
  if (fs.existsSync(where.current)) await fsp.rename(where.current, old);
  await fsp.rename(where.staging, where.current);
  await fsp.rm(old, { recursive: true, force: true });
  if (rust.private && !keepToolchain) await fsp.rm(where.toolchain, { recursive: true, force: true });
  report(1, 'Done');
  return inspect(dir, worker);
}

// Downloads the pinned OU files and puts each where Foul Play would have cached it.
async function installOuData(dataDir, downloads, { signal, onFraction = () => {}, fetcher = fetch, pins = lock.ouData } = {}) {
  const names = Object.keys(OU_FILES);
  for (const [index, name] of names.entries()) {
    const entry = { ...pins[name], refresh: true };
    const file = await download(entry, path.join(downloads, `ou-${name}.json`), { signal, fetcher });
    const target = path.join(dataDir, ...OU_FILES[name]);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (name === 'usageStats') {
      const stats = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!stats || typeof stats.data !== 'object' || !stats.data) throw new Error('The OU usage stats are not in the expected shape.');
      await fsp.writeFile(target, JSON.stringify(stats.data));
    } else {
      JSON.parse(await fsp.readFile(file, 'utf8'));
      await fsp.copyFile(file, target);
    }
    onFraction((index + 1) / names.length);
  }
}

// `npm run refresh-ou`: points lock.json's OU pins at the newest usage stats and current set data.
// Check the result, commit lock.json, then run `npm run setup` on the server.
async function refreshOuData({ fetcher = fetch, now = new Date(), lockFile = path.join(__dirname, 'lock.json'), onLog = () => {} } = {}) {
  const hash = async url => {
    const response = await fetcher(url, { redirect: 'follow' });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    JSON.parse(bytes.toString('utf8'));
    return crypto.createHash('sha256').update(bytes).digest('hex');
  };
  const next = { ...lock.ouData };
  // Smogon publishes a month's stats early in the next month; fall back a month if not yet out.
  for (let back = 1; back <= 3; back++) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const url = `https://www.smogon.com/stats/${month}/chaos/gen9ou-0.json`;
    const sha256 = await hash(url);
    if (sha256) { next.usageStats = { month, url, sha256 }; break; }
  }
  if (next.usageStats === lock.ouData.usageStats) onLog('No newer usage stats were found; keeping the current month.');
  for (const name of ['showdownSets', 'fullSets', 'replayMoves']) {
    const sha256 = await hash(lock.ouData[name].url);
    if (!sha256) throw new Error(`Could not download ${lock.ouData[name].url}`);
    next[name] = { url: lock.ouData[name].url, sha256 };
  }
  const text = await fsp.readFile(lockFile, 'utf8');
  const updated = JSON.parse(text);
  updated.ouData = next;
  await fsp.writeFile(lockFile, `${JSON.stringify(updated, null, 2)}\n`);
  return next;
}

async function remove(dir) {
  await fsp.rm(path.resolve(dir), { recursive: true, force: true });
}

async function main() {
  const { parseArgs } = require('node:util');
  const { values } = parseArgs({ options: { dir: { type: 'string', default: path.join(__dirname, 'runtime') },
    'keep-toolchain': { type: 'boolean' }, status: { type: 'boolean' }, 'refresh-ou': { type: 'boolean' } } });
  if (values.status) return console.log(JSON.stringify(inspect(values.dir), null, 2));
  if (values['refresh-ou']) {
    const pins = await refreshOuData({ onLog: line => console.error(line) });
    console.log(`OU pins updated: usage stats ${pins.usageStats.month}. Commit lock.json, then run "npm run setup".`);
    return;
  }
  let last = '';
  const runtime = await install({ dir: values.dir, keepToolchain: values['keep-toolchain'],
    onProgress: ({ label, index, steps, fraction, detail }) => {
      const line = `[${String(Math.round(fraction * 100)).padStart(3)}%] ${index + 1}/${steps} ${label}${detail ? ` · ${detail}` : ''}`;
      if (line !== last) console.error((last = line));
    },
    onLog: line => { if (process.env.INSTALL_VERBOSE) console.error(`  ${line}`); } });
  console.log(`Foul Play installed in ${path.dirname(runtime.source)}`);
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  if (error.output) console.error(error.output);
  process.exitCode = 1;
});

module.exports = { install, inspect, remove, paths, platformKey, pythonExecutable, installOuData, refreshOuData,
  LOCK_VERSION, STEPS, WORKER, FORMATS, OU_FILES };
