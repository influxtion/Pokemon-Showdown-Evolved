'use strict';

// Installs the pinned Foul Play runtime: a standalone Python, Foul Play's source, its Python
// packages and poke-engine compiled with Terastallization. The same code runs on a server
// (`npm run setup`) and inside the desktop app (the one-click "Install Foul Play" button).
//
// Layout under `dir`:
//   current/            the runtime the server uses (python/, foul-play/, install.json)
//   staging/            a build in progress; renamed to current/ only once it passes its check
//   toolchain/          a private Rust toolchain, only if none was found; removed after a build

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
// Roughly how many crates cargo compiles for poke-engine; only used to move the progress bar.
const ENGINE_CRATES = 40;

const STEPS = Object.freeze([
  { id: 'python', label: 'Downloading Python', weight: 8 },
  { id: 'toolchain', label: 'Preparing the Rust compiler', weight: 17 },
  { id: 'source', label: 'Downloading Foul Play', weight: 3 },
  { id: 'packages', label: 'Installing Python packages', weight: 7 },
  { id: 'engine', label: 'Compiling the search engine', weight: 55 },
  { id: 'data', label: 'Downloading random battle sets', weight: 4 },
  { id: 'verify', label: 'Checking the engine', weight: 3 },
  { id: 'finish', label: 'Finishing up', weight: 3 },
]);
const TOTAL_WEIGHT = STEPS.reduce((sum, step) => sum + step.weight, 0);

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

// What is installed under `dir`, without running anything. `worker` overrides where the worker
// script is read from (a packaged app keeps it outside its archive).
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

async function download(entry, target, { signal, onFraction = () => {} }) {
  if (fs.existsSync(target) && await sha256File(target) === entry.sha256) return target;
  const response = await fetch(entry.url, { signal, redirect: 'follow' });
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
    throw new Error(`Checksum mismatch for ${path.basename(target)}. The download was corrupted or changed upstream.`);
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
  await run('tar', ['-xzf', archive, '-C', destination], { signal });
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
    PIP_DISABLE_PIP_VERSION_CHECK: '1' };

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

  next('verify');
  await run(python, ['-I', '-B', worker, '--check', '--source', path.join(where.staging, 'foul-play')], { env, signal, onLine: log });

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

async function remove(dir) {
  await fsp.rm(path.resolve(dir), { recursive: true, force: true });
}

async function main() {
  const { parseArgs } = require('node:util');
  const { values } = parseArgs({ options: { dir: { type: 'string', default: path.join(__dirname, 'runtime') },
    'keep-toolchain': { type: 'boolean' }, status: { type: 'boolean' } } });
  if (values.status) return console.log(JSON.stringify(inspect(values.dir), null, 2));
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

module.exports = { install, inspect, remove, paths, platformKey, pythonExecutable, LOCK_VERSION, STEPS, WORKER };
