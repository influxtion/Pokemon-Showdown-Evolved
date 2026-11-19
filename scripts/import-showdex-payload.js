'use strict';

// Import only the platform-independent, pinned assets from an already verified package.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const archive = process.argv[2];
if (!archive) throw new Error('Pass the app.asar from the hash-verified Windows release');
const vendor = path.resolve(__dirname, '../vendor/showdex');
const manifest = JSON.parse(fs.readFileSync(path.join(vendor, 'manifest.json'), 'utf8'));
assert.deepEqual(JSON.parse(asar.extractFile(archive, 'vendor/showdex/manifest.json').toString('utf8')), manifest);
fs.mkdirSync(path.join(vendor, 'dist'), { recursive: true });
for (const name of [...Object.keys(manifest.assets), 'showdex-source.tar.gz']) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error('Invalid Showdex asset path');
  fs.writeFileSync(path.join(vendor, 'dist', name), asar.extractFile(archive, `vendor/showdex/dist/${name}`));
}
new (require('../app/showdex-install').ShowdexInstaller)(vendor).payload();
console.log('Imported the exact pinned Showdex assets and corresponding source archive.');
