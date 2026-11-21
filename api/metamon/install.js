'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { download, extract, run, pythonExecutable, promoteRuntime } = require('../install');
const pythonLock = require('../lock.json').python;
const lock = require('./lock.json');

const ASSETS = __dirname;
const WORKER = path.join(ASSETS, 'worker.py');
const IDENTITY = crypto.createHash('sha256').update(JSON.stringify(lock)).update(fs.readFileSync(path.join(ASSETS, 'requirements.txt'))).update(fs.readFileSync(path.join(ASSETS, 'bootstrap.txt'))).digest('hex');

class MetamonRuntime extends EventEmitter {
  constructor({ dir, platform = `${process.platform}-${process.arch}`, worker = WORKER } = {}) {
    super();
    this.dir = path.resolve(dir);
    this.platform = platform;
    this.worker = worker;
    this.current = path.join(this.dir, 'current');
    this.installing = null;
    this.progress = '';
    this.error = '';
  }

  inspect() {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(this.current, 'install.json'), 'utf8')); } catch { /* Not installed. */ }
    const python = pythonExecutable(path.join(this.current, 'python'));
    const installed = Boolean(manifest?.version === 1 && fs.existsSync(python) &&
      fs.existsSync(path.join(this.current, 'model.pt')) && fs.existsSync(path.join(this.current, 'metamon/metamon/rl/pretrained.py')));
    return { installed, current: installed && manifest.identity === IDENTITY, python, root: this.current, worker: this.worker, formats: ['gen9ou'] };
  }

  status() {
    const value = this.inspect();
    return { installed: value.installed, current: value.current, supported: Boolean(lock.torch[this.platform] && pythonLock.builds[this.platform]),
      installing: Boolean(this.installing), progress: this.progress, error: this.error, model: lock.model.name };
  }

  install() {
    if (this.installing) return this.installing;
    if (!this.status().supported) return Promise.resolve({ ok: false, error: 'Metamon is not available for this system yet.' });
    this.controller = new AbortController();
    this.error = '';
    this.installing = this.prepare(this.controller.signal).then(() => ({ ok: true }), error => {
      if (this.controller.signal.aborted) return { ok: false, cancelled: true };
      this.error = error.message;
      return { ok: false, error: this.error };
    }).finally(() => { this.installing = null; this.progress = ''; this.emit('change'); });
    return this.installing;
  }

  async prepare(signal) {
    const staging = path.join(this.dir, 'staging');
    const downloads = path.join(this.dir, 'downloads');
    // All removal targets are fixed children of this server's dedicated runtime directory.
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });
    const report = text => { this.progress = text; this.emit('change'); };
    const fetchFile = async (entry, name, label) => {
      report(label);
      return download(entry, path.join(downloads, name), { signal,
        onFraction: fraction => { this.progress = `${label} ${Math.floor(fraction * 100)}%`; } });
    };
    const pythonArchive = await fetchFile(pythonLock.builds[this.platform], 'python.tar.gz', 'Downloading Python');
    await extract(pythonArchive, staging, signal);
    const python = pythonExecutable(path.join(staging, 'python'));
    const env = { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PIP_NO_INPUT: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' };
    const pip = args => run(python, ['-I', '-m', 'pip', 'install', '--no-warn-script-location', ...args], { env, signal });
    report('Installing local runtime dependencies');
    // Exact versions and accepted artifact hashes; no unpinned dependency resolution.
    for (const name of ['bootstrap.txt', 'requirements.txt']) {
      const target = path.join(staging, name);
      await fsp.copyFile(path.join(ASSETS, name), target);
      await pip(['--no-deps', '--no-build-isolation', '--require-hashes', '-r', target]);
    }
    const torch = lock.torch[this.platform];
    const torchName = decodeURIComponent(new URL(torch.url).pathname.split('/').at(-1));
    const wheel = await fetchFile(torch, torchName, 'Downloading CPU inference engine');
    await pip(['--no-deps', wheel]);
    for (const [name, source] of Object.entries(lock.sources)) {
      const archive = await fetchFile(source, `${name}.tar.gz`, `Downloading ${name} source`);
      await extract(archive, staging, signal);
      const destination = path.join(staging, name);
      await fsp.rename(path.join(staging, source.folder), destination);
      if (name !== 'metamon') await pip(['--no-deps', '--no-build-isolation', destination]);
    }
    const model = await fetchFile(lock.model, 'model.pt', 'Downloading Kakuna model');
    await fsp.copyFile(model, path.join(staging, 'model.pt'));
    await fsp.copyFile(path.join(ASSETS, 'MODEL-LICENSE'), path.join(staging, 'MODEL-LICENSE'));
    await fsp.writeFile(path.join(staging, 'SOURCE.json'), JSON.stringify(lock, null, 2) + '\n');
    report('Checking Metamon on CPU');
    await run(python, ['-I', '-B', this.worker, '--runtime', staging, '--check'], { env, signal });
    signal.throwIfAborted();
    await fsp.writeFile(path.join(staging, 'install.json'), JSON.stringify({ version: 1, identity: IDENTITY, model: 'Kakuna', installedAt: new Date().toISOString() }));
    await promoteRuntime({ current: this.current, staging });
    await fsp.rm(downloads, { recursive: true, force: true });
  }

  cancel() { this.controller?.abort(new Error('Download cancelled.')); return { ok: true }; }

  async remove() {
    if (this.installing) return { ok: false, error: 'Cancel the download first.' };
    for (const name of ['current', 'staging', 'downloads']) await fsp.rm(path.join(this.dir, name), { recursive: true, force: true });
    this.error = ''; this.emit('change');
    return { ok: true };
  }

}

module.exports = { MetamonRuntime, WORKER, IDENTITY };

if (require.main === module) {
  const { parseArgs } = require('node:util');
  const { values } = parseArgs({ options: { dir: { type: 'string' }, status: { type: 'boolean' } } });
  const runtime = new MetamonRuntime({ dir: values.dir || process.env.METAMON_RUNTIME_DIR || path.join(__dirname, '../metamon-runtime') });
  if (values.status) console.log(JSON.stringify(runtime.status(), null, 2));
  else {
    runtime.on('change', () => { if (runtime.progress) console.log(runtime.progress); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => runtime.cancel());
    runtime.install().then(result => { if (!result.ok) { console.error(result.error || 'Cancelled'); process.exitCode = 1; } else console.log('Metamon installed.'); });
  }
}
