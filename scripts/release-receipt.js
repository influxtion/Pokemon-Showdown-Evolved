'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (sourceCommit !== process.env.MAIN_SOURCE_SHA) throw new Error('Release receipt source mismatch.');
const files = {};
for (const folder of ['out/windows', 'out/macos', 'out/linux']) {
  if (!fs.existsSync(folder)) continue;
  for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!item.isFile() || !/\.(exe|blockmap|yml|dmg|zip|AppImage)$/.test(item.name)) continue;
    const file = path.join(folder, item.name);
    files[file.replace(/\\/g, '/')] = { bytes: fs.statSync(file).size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  }
}
if (!Object.keys(files).length) throw new Error('No release artifacts to record.');
fs.writeFileSync('out/release-receipt.json', JSON.stringify({ sourceCommit, version: require('../package.json').version,
  electron: require('../package.json').devDependencies.electron, platform: process.platform, arch: process.arch, files }, null, 2) + '\n');
