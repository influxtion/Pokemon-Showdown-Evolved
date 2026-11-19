'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inspectRuntime, verifyRuntime } = require('../app/practice-manifest');

const REQUIRED = ['server/dist/server/index.js', 'client/practice-client.html'];
const INVALID = { ok: false, code: 'invalid', error: 'Practice runtime failed integrity verification.' };
const MISSING = { ok: false, code: 'missing', error: 'Practice runtime is not installed.' };

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-manifest-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'runtime');
  const filename = path.join(root, 'manifest.json');
  const manifest = { version: 3, kind: 'simulator', platform: process.platform, arch: process.arch, files: {} };
  const add = (name, contents) => {
    const target = path.join(root, name);
    const bytes = Buffer.from(contents);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    manifest.files[name] = { size: bytes.length, sha256: sha256(bytes) };
  };
  const save = () => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(filename, bytes);
    return bytes;
  };
  for (const name of REQUIRED) add(name, 'placeholder');
  save();
  return { base, root, filename, manifest, add, save };
}

test('verifies every runtime file and identifies the exact manifest bytes', t => {
  const { root, manifest, add, save } = fixture(t);
  add('client/style/empty.css', '');
  add('server/data/large.bin', Buffer.alloc(2 * 1024 ** 2 + 17, 7));
  manifest.build = { extra: ['informational metadata'] };
  const bytes = save();
  assert.deepEqual(inspectRuntime(root), { ok: true });
  assert.deepEqual(verifyRuntime(root), { ok: true, kind: 'simulator', identity: sha256(bytes) });
});

test('a simulator runtime needs its server and client, and other kinds are rejected', t => {
  const { root, manifest, save } = fixture(t);
  manifest.kind = 'laplace';
  save();
  assert.deepEqual(verifyRuntime(root), INVALID, 'the retired Laplace harness kind is rejected');
  manifest.kind = 'other';
  save();
  assert.deepEqual(verifyRuntime(root), INVALID, 'unknown runtime kinds are rejected');
  manifest.kind = 'simulator';
  manifest.version = 2;
  save();
  assert.deepEqual(verifyRuntime(root), INVALID, 'runtimes from before the split must be rebuilt');
});

test('full verification catches same-size corruption after a successful check', t => {
  const { root } = fixture(t);
  assert.equal(verifyRuntime(root).ok, true);
  fs.writeFileSync(path.join(root, REQUIRED[0]), 'Placeholder');
  assert.deepEqual(inspectRuntime(root), { ok: true }, 'status inspection does not hash payload files');
  assert.deepEqual(verifyRuntime(root), INVALID);
});

test('rejects a runtime built for another operating system or architecture', t => {
  const { root, manifest, save } = fixture(t);
  manifest.platform = process.platform === 'linux' ? 'darwin' : 'linux';
  save();
  assert.deepEqual(verifyRuntime(root), INVALID);
  manifest.platform = process.platform;
  manifest.arch = process.arch === 'x64' ? 'arm64' : 'x64';
  save();
  assert.deepEqual(verifyRuntime(root), INVALID);
});

test('rejects missing or extra payload files and missing required manifest entries', t => {
  const { root, manifest, add, save } = fixture(t);
  fs.unlinkSync(path.join(root, REQUIRED[1]));
  assert.deepEqual(verifyRuntime(root), INVALID);
  add(REQUIRED[1], 'restored');
  fs.writeFileSync(path.join(root, 'client', 'undeclared.js'), 'extra');
  save();
  assert.deepEqual(verifyRuntime(root), INVALID);
  fs.unlinkSync(path.join(root, 'client', 'undeclared.js'));
  delete manifest.files[REQUIRED[1]];
  save();
  assert.deepEqual(inspectRuntime(root), INVALID);
  assert.deepEqual(verifyRuntime(root), INVALID);
});

test('rejects noncanonical and ambiguous Windows runtime paths', t => {
  const { root, manifest, save } = fixture(t);
  const entry = manifest.files[REQUIRED[0]];
  for (const name of [
    '../outside', 'python/../outside', 'python/./extra', '/absolute', 'C:/absolute',
    '\\server\\share\\file', 'python\\extra', 'python//extra', 'python/extra/',
    'python/extra:stream', 'python/extra. ', 'python/NUL.dll',
    'SERVER/DIST/SERVER/INDEX.JS', 'MANIFEST.JSON',
  ]) {
    manifest.files[name] = entry;
    save();
    assert.deepEqual(inspectRuntime(root), INVALID, name);
    assert.deepEqual(verifyRuntime(root), INVALID, name);
    delete manifest.files[name];
  }
});

test('rejects an escaped directory and a linked runtime root', t => {
  const { base, root, manifest, save } = fixture(t);
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'payload'), 'outside');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(outside, path.join(root, 'linked'), linkType);
  manifest.files['linked/payload'] = { size: 7, sha256: sha256('outside') };
  save();
  assert.deepEqual(verifyRuntime(root), INVALID);
  const alias = path.join(base, 'alias');
  fs.symlinkSync(root, alias, linkType);
  assert.deepEqual(inspectRuntime(alias), INVALID);
  assert.deepEqual(verifyRuntime(alias + path.sep), INVALID);
});

test('reports a missing manifest and invalidates cached inspection when it changes', t => {
  const { base, root, filename, manifest, save } = fixture(t);
  assert.deepEqual(inspectRuntime(path.join(base, 'absent')), MISSING);
  assert.deepEqual(verifyRuntime(path.join(base, 'absent')), MISSING);
  assert.deepEqual(inspectRuntime(root), { ok: true });
  manifest.version = 1;
  save();
  fs.utimesSync(filename, new Date(0), new Date(0));
  assert.deepEqual(inspectRuntime(root), INVALID);
  assert.deepEqual(verifyRuntime(root), INVALID);
  fs.unlinkSync(filename);
  assert.deepEqual(inspectRuntime(root), MISSING);
  assert.deepEqual(verifyRuntime(root), MISSING);
});

test('bounds manifest bytes, declared entries, and total payload size', t => {
  const { root, filename, manifest, save } = fixture(t);
  fs.truncateSync(filename, 8 * 1024 ** 2 + 1);
  assert.deepEqual(inspectRuntime(root), INVALID);
  assert.deepEqual(verifyRuntime(root), INVALID);

  const required = { ...manifest.files };
  const entry = { size: 0, sha256: sha256('') };
  for (let index = Object.keys(required).length; index <= 40000; index++) {
    manifest.files[`extra/${index}`] = entry;
  }
  save();
  assert.deepEqual(inspectRuntime(root), INVALID);
  assert.deepEqual(verifyRuntime(root), INVALID);

  manifest.files = required;
  manifest.files['oversized.bin'] = { size: 4 * 1024 ** 3, sha256: sha256('') };
  save();
  assert.deepEqual(inspectRuntime(root), INVALID);
  assert.deepEqual(verifyRuntime(root), INVALID);
});
