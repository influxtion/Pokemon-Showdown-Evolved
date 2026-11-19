'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ShowdexIntegration } = require('./showdex-integration');

const VENDOR = path.join(__dirname, '..', 'vendor', 'showdex');
// The payload stays inert until the user opts in. Only pinned, flat asset names are copied.
class ShowdexInstaller {
  constructor(dir, { vendor = VENDOR, fileSystem = fs } = {}) {
    this.fs = fileSystem;
    this.vendor = vendor;
    this.root = path.join(dir, 'showdex');
    this.target = path.join(this.root, '1.4.2');
    this.manifestFile = path.join(vendor, 'manifest.json');
    this.installing = false;
  }

  payload() {
    const source = new ShowdexIntegration({ distDir: path.join(this.vendor, 'dist'), manifestFile: this.manifestFile });
    if (!source.bundleInfo().installed) throw new Error('The Showdex install files are missing or damaged. Reinstall the app to try again.');
    for (const file of ['LICENSE', 'SOURCE.md', 'dist/showdex-source.tar.gz']) {
      if (!this.fs.statSync(path.join(this.vendor, file)).isFile()) throw new Error('Showdex source files are missing.');
    }
    return source;
  }

  async install() {
    if (this.installing) return { ok: false, error: 'Showdex is already being installed.' };
    this.installing = true;
    let staging;
    try {
      const source = this.payload();
      const existing = new ShowdexIntegration({ distDir: this.target, manifestFile: this.manifestFile });
      if (existing.bundleInfo().installed && ['LICENSE', 'SOURCE.md', 'showdex-source.tar.gz'].every(name =>
        this.fs.existsSync(path.join(this.target, name)))) return { ok: true };
      await this.fs.promises.mkdir(this.root, { recursive: true });
      staging = await this.fs.promises.mkdtemp(path.join(this.root, '.install-'));
      for (const name of Object.keys(source.manifest.assets)) {
        await this.fs.promises.copyFile(path.join(source.distDir, name), path.join(staging, name));
      }
      for (const [from, to] of [['LICENSE', 'LICENSE'], ['SOURCE.md', 'SOURCE.md'], ['dist/showdex-source.tar.gz', 'showdex-source.tar.gz']]) {
        await this.fs.promises.copyFile(path.join(this.vendor, from), path.join(staging, to));
      }
      const installed = new ShowdexIntegration({ distDir: staging, manifestFile: this.manifestFile });
      if (!installed.bundleInfo().installed) throw new Error('Showdex verification failed. Try installing again.');
      // Keep an old copy intact if replacing it fails. Corrupt copies are retained for inspection.
      let previous;
      if (this.fs.existsSync(this.target)) {
        previous = `${this.target}.previous-${randomUUID()}`;
        await this.fs.promises.rename(this.target, previous);
      }
      try { await this.fs.promises.rename(staging, this.target); }
      catch (error) {
        if (previous) await this.fs.promises.rename(previous, this.target);
        throw error;
      }
      staging = null;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message?.startsWith('The Showdex') || error.message?.startsWith('Showdex ')
        ? error.message : 'Showdex could not be installed. Check free disk space and try again.' };
    } finally {
      // mkdtemp returns a newly created directory directly beneath this installer's fixed root.
      if (staging && path.dirname(staging) === this.root && path.basename(staging).startsWith('.install-')) {
        try { await this.fs.promises.rm(staging, { recursive: true, force: true }); } catch { /* Retry can use a fresh staging directory. */ }
      }
      this.installing = false;
    }
  }
}

module.exports = { ShowdexInstaller };
