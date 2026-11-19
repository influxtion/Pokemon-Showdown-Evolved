'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
const yaml = require('js-yaml');

test('patched build glob dependencies preserve package inclusion and exclusion rules', () => {
  const root = path.resolve(__dirname, '..');
  const config = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  const filter = new FileMatcher(root, path.join(root, 'out'), value => value, config.files).createFilter();
  const file = { isDirectory: () => false };
  for (const name of ['app/main.js', 'renderer/index.html', 'vendor/showdex/LICENSE', 'vendor/showdex/dist/main.js', 'vendor/showdex/dist/showdex-source.tar.gz']) {
    assert.equal(filter(path.join(root, name), file), true, name);
  }
  for (const name of ['app/example.test.js', 'app/nested/tests/fixture.js', 'out/private.json', 'tests/security.test.js']) {
    assert.equal(filter(path.join(root, name), file), false, name);
  }
  const universalRequire = createRequire(require.resolve('@electron/universal'));
  const { minimatch } = universalRequire('minimatch');
  assert.equal(minimatch('nested/native.node', '*.node', { matchBase: true }), true);
  assert.equal(minimatch('nested/private.json', '*.node', { matchBase: true }), false);
});
