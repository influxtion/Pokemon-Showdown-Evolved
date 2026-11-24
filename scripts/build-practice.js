'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { buildServer } = require('./practice/build-server.cjs');
const { buildClient, clientRevision, clientDataRevision } = require('./practice/build-client.cjs');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor/practice');
const CACHE = path.join(ROOT, 'out/practice');
// The app ships the local Showdown simulator and battle client; bots connect to it as players.
const APP_RUNTIME = path.join(VENDOR, 'dist');
const ADAPTER_SOURCES = ['server.cjs', 'build-server.cjs', 'build-client.cjs'];

function run(executable, args, options = {}) {
  return execFileSync(executable, args, { cwd: ROOT, windowsHide: true, stdio: 'inherit',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...options });
}

function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function insideWorkspace(target) {
  const existing = fs.existsSync(target) ? fs.realpathSync(target) : path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
  const relative = path.relative(fs.realpathSync(ROOT), existing);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Build path must stay inside the workspace.');
  return existing;
}

function inventory(directory) {
  const files = {};
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Runtime contains an unexpected symbolic link.');
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) {
        const file = path.join(directory, name);
        files[name] = { sha256: sha(file), size: fs.statSync(file).size };
      } else throw new Error('Runtime contains an unsupported file type.');
    }
  }
  visit('');
  return files;
}

function preserveSources(pending) {
  const sourceDir = path.join(pending, 'sources');
  fs.mkdirSync(sourceDir);
  for (const [name, source] of [
    ['showdown-client', path.join(ROOT, 'out/practice-client-source')],
    ['showdown-server', path.join(ROOT, 'out/practice-server-source')],
    ['showdown-client-data', path.join(ROOT, 'out/practice-client-source/caches/pokemon-showdown')],
  ]) run('git', ['-C', source, 'archive', '--format=tar', '--output', path.join(sourceDir, `${name}.tar`), 'HEAD']);
  fs.copyFileSync(__filename, path.join(sourceDir, 'build-practice.js'));
  fs.copyFileSync(path.join(ROOT, 'app/battle-review-capture.js'), path.join(sourceDir, 'battle-review-capture.js'));
  const adapter = path.join(sourceDir, 'desktop-adapter');
  fs.mkdirSync(adapter);
  for (const name of ADAPTER_SOURCES) fs.copyFileSync(path.join(ROOT, 'scripts/practice', name), path.join(adapter, name));
  for (const file of fs.readdirSync(VENDOR)) {
    const source = path.join(VENDOR, file);
    if (fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(sourceDir, file));
  }
}

async function main() {
  if (!['win32', 'darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('Practice runtime builds require Windows, macOS or Linux on x64 or arm64.');
  }
  const args = process.argv.slice(2);
  if (args.some(argument => argument !== '--stage-only')) throw new Error('Usage: node scripts/build-practice.js [--stage-only]');
  const stageOnly = args.includes('--stage-only');
  const dist = APP_RUNTIME;
  let keepPending = false;
  fs.mkdirSync(path.dirname(dist), { recursive: true });
  const pending = path.join(path.dirname(dist), `pending-${Date.now()}`);
  insideWorkspace(pending);
  try {
    console.log('Building the local simulator…');
    const server = buildServer(path.join(pending, 'server'));
    console.log('Building the sandboxed battle client…');
    buildClient(path.join(pending, 'client'));
    preserveSources(pending);
    const manifest = { version: 3, kind: 'simulator', platform: process.platform, arch: process.arch,
      server, client: { revision: clientRevision, dataRevision: clientDataRevision }, files: inventory(pending) };
    fs.writeFileSync(path.join(pending, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const { verifyRuntime } = require('../app/practice-manifest');
    const verification = verifyRuntime(pending);
    if (!verification.ok) throw new Error(verification.error);
    if (stageOnly) {
      keepPending = true;
      console.log(`Verified candidate retained at ${pending}; manifest ${verification.identity}`);
      return;
    }
    fs.mkdirSync(CACHE, { recursive: true });
    const previous = path.join(CACHE, `previous-runtime-${Date.now()}`);
    insideWorkspace(pending);
    insideWorkspace(previous);
    if (fs.existsSync(dist)) { insideWorkspace(dist); fs.renameSync(dist, previous); }
    try { fs.renameSync(pending, dist); } catch (error) {
      if (fs.existsSync(previous) && !fs.existsSync(dist)) fs.renameSync(previous, dist);
      throw error;
    }
    console.log(`Built and verified the practice simulator runtime at ${path.relative(ROOT, dist)}: ${Object.keys(manifest.files).length} files; manifest ${verification.identity}`);
  } finally {
    if (!keepPending && fs.existsSync(pending)) {
      insideWorkspace(pending);
      fs.rmSync(pending, { recursive: true, force: true });
    }
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { inventory, insideWorkspace, APP_RUNTIME };
