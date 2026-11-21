'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const asar = require('@electron/asar');
const { verifyApiFiles } = require('../scripts/verify-practice-package');
const root = path.join(__dirname, '..');
test('bot package includes pinned download metadata and notices, with only Python adapters unpacked', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-package-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const resources = path.join(dir, 'resources'); fs.mkdirSync(resources);
  const config = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  const files = config.files.filter(value => value.startsWith('api/'));
  assert.ok(files.every(file => !file.includes('*')), 'explicit allowlist prevents model/runtime bundling');
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(source, file));
  }
  const archive = path.join(resources, 'app.asar');
  await asar.createPackageWithOptions(source, archive, { unpack: '**/{worker/**,metamon/worker.py}' });
  verifyApiFiles(resources);
  assert.ok(config.asarUnpack.includes('api/metamon/worker.py'));
  assert.equal(fs.readFileSync(path.join(resources, 'app.asar.unpacked/api/metamon/worker.py'), 'utf8'), fs.readFileSync(path.join(root, 'api/metamon/worker.py'), 'utf8'));
  const credit = asar.extractFile(archive, path.join('api', 'metamon', 'CODE-LICENSE')).toString();
  assert.match(credit, /UT Robot Perception and Learning Lab/);
  assert.match(asar.extractFile(archive, path.join('api', 'metamon', 'MODEL-CARD')).toString(), /license: apache-2.0/);
  fs.writeFileSync(path.join(source, 'api/metamon/model.pt'), 'accidental model');
  const bad = path.join(dir, 'bad'); fs.mkdirSync(bad);
  await asar.createPackageWithOptions(source, path.join(bad, 'app.asar'), { unpack: '**/{worker/**,metamon/worker.py}' });
  assert.throws(() => verifyApiFiles(bad), /model.pt/);
});
