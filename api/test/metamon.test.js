'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MetamonRuntime, IDENTITY } = require('../metamon/install');
const { pythonExecutable } = require('../install');
function runtime(t, platform) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metamon-runtime-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new MetamonRuntime({ dir, platform });
}
test('Metamon requires its own complete install and reports old identities', t => {
  const r = runtime(t);
  assert.equal(r.inspect().installed, false);
  for (const file of [pythonExecutable(path.join(r.current, 'python')), path.join(r.current, 'model.pt'), path.join(r.current, 'metamon/metamon/rl/pretrained.py')]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture');
  }
  fs.writeFileSync(path.join(r.current, 'install.json'), JSON.stringify({ version: 1, identity: 'old' }));
  assert.equal(r.inspect().installed, true);
  assert.equal(r.inspect().current, false);
  fs.writeFileSync(path.join(r.current, 'install.json'), JSON.stringify({ version: 1, identity: IDENTITY }));
  assert.equal(r.inspect().current, true);
  assert.deepEqual(r.inspect().formats, ['gen9ou']);
});
test('unsupported Metamon platforms cannot install; removal is scoped and blocked during setup', async t => {
  const r = runtime(t, 'unsupported');
  assert.equal((await r.install()).ok, false);
  for (const name of ['current', 'staging', 'downloads', 'keep']) fs.mkdirSync(path.join(r.dir, name));
  r.installing = Promise.resolve();
  assert.equal((await r.remove()).ok, false);
  r.installing = null;
  assert.deepEqual(await r.remove(), { ok: true });
  assert.deepEqual(fs.readdirSync(r.dir), ['keep']);
});

test('local Metamon requires macOS 14 on Apple Silicon and has no Intel Mac wheel', t => {
  const r = runtime(t, 'darwin-arm64');
  r.systemRelease = '22.6.0';
  assert.equal(r.status().supported, false);
  assert.match(r.status().unsupportedReason, /macOS 14/);
  r.systemRelease = '23.0.0';
  assert.equal(r.status().supported, true);
  r.platform = 'darwin-x64';
  assert.equal(r.status().supported, false);
});
