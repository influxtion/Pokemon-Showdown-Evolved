'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ShowdexInstaller } = require('../app/showdex-install');
const { ShowdexIntegration } = require('../app/showdex-integration');
const { Settings } = require('../app/settings');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showdex-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vendor = path.join(root, 'vendor');
  fs.mkdirSync(path.join(vendor, 'dist'), { recursive: true });
  const asset = 'window.showdexFixture = true;';
  fs.writeFileSync(path.join(vendor, 'dist', 'main.js'), asset);
  const manifestFile = path.join(vendor, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ version: '1.4.2', commit: '165abdb05ad08c5b286f71e21cc1907852efd76f',
    resourceProtocol: 'showdex', resourcePrefix: 'assets', assets: { 'main.js': createHash('sha256').update(asset).digest('hex') } }));
  for (const name of ['LICENSE', 'SOURCE.md', 'dist/showdex-source.tar.gz']) fs.writeFileSync(path.join(vendor, name), 'test source record');
  const profile = path.join(root, 'profile');
  return { vendor, profile, manifestFile, installer: new ShowdexInstaller(profile, { vendor }) };
}

test('installs only on request, verifies copied assets and retains source and license', async t => {
  const { installer, manifestFile } = fixture(t);
  installer.payload();
  assert.equal(fs.existsSync(installer.root), false);
  assert.deepEqual(await installer.install(), { ok: true });
  assert.equal(new ShowdexIntegration({ distDir: installer.target, manifestFile }).bundleInfo().installed, true);
  for (const name of ['LICENSE', 'SOURCE.md', 'showdex-source.tar.gz']) assert.ok(fs.existsSync(path.join(installer.target, name)));
  assert.equal(installer.installing, false);
  assert.deepEqual(await installer.install(), { ok: true });
  assert.deepEqual(fs.readdirSync(installer.root), ['1.4.2'], 'repeated opt-in reuses the verified copy');
});

test('rejects damaged payload and missing source without replacing an existing install', async t => {
  const { installer, vendor } = fixture(t);
  await installer.install();
  const original = fs.readFileSync(path.join(installer.target, 'main.js'), 'utf8');
  fs.writeFileSync(path.join(vendor, 'dist', 'main.js'), 'tampered');
  assert.equal((await installer.install()).ok, false);
  assert.equal(fs.readFileSync(path.join(installer.target, 'main.js'), 'utf8'), original);
  fs.writeFileSync(path.join(vendor, 'dist', 'main.js'), original);
  fs.unlinkSync(path.join(vendor, 'dist', 'showdex-source.tar.gz'));
  assert.equal((await installer.install()).ok, false);
});

test('failed copy preserves installed assets and removes incomplete staging; duplicate requests are blocked', async t => {
  const { installer, profile, vendor } = fixture(t);
  const first = installer.install();
  assert.equal((await installer.install()).ok, false);
  await first;
  fs.unlinkSync(path.join(installer.target, 'SOURCE.md'));
  const failing = new ShowdexInstaller(profile, { vendor, fileSystem: { ...fs,
    promises: { ...fs.promises, copyFile: async () => { throw new Error('disk full'); } } } });
  assert.equal((await failing.install()).ok, false);
  assert.equal(fs.existsSync(path.join(installer.target, 'main.js')), true);
  assert.equal(fs.readdirSync(installer.root).some(name => name.startsWith('.install-')), false);
});

test('first-launch choice persists, reset does not nag, and existing users are not prompted on upgrade', t => {
  const { profile } = fixture(t);
  const fresh = new Settings(profile);
  assert.equal(fresh.get('showdexPrompted'), false);
  assert.equal(fresh.set('showdexPrompted', 'yes'), false);
  fresh.set('showdexPrompted', true);
  assert.equal(new Settings(profile).get('showdexPrompted'), true);
  fresh.reset();
  assert.equal(fresh.get('showdexPrompted'), true);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeLayout: 'classic' }));
  assert.equal(new Settings(profile).get('showdexPrompted'), true);
});
