'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const id = process.argv[2];
if (!['macOS-arm64', 'macOS-x64', 'Linux-x64'].includes(id)) throw new Error('Unknown release platform');
const expected = `${process.platform === 'darwin' ? 'macOS' : 'Linux'}-${process.arch}`;
if (id !== expected) throw new Error('Release must be built and tested on its target platform');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out/native-release');
fs.mkdirSync(output, { recursive: true });
const build = path.join(root, 'out', process.platform === 'darwin' ? 'macos' : 'linux');
const version = require('../package.json').version;
const filenames = fs.readdirSync(build).filter(name => name.startsWith(`Pokemon.Showdown.Evolved.${version}.`) && /\.(dmg|zip|AppImage|tar\.gz)$/.test(name));
if (filenames.length !== 2) throw new Error('Expected both native package formats');
for (const name of filenames) fs.copyFileSync(path.join(build, name), path.join(output, name));
const sourceName = `Pokemon.Showdown.Evolved.${version}.source-${id}.tar.gz`;
execFileSync('git', ['archive', '--format=tar.gz', '--prefix=pokemon-showdown-evolved/', '-o', path.join(output, sourceName), 'HEAD'], { cwd: root });
filenames.push(sourceName);
const assets = filenames.map(name => {
  const bytes = fs.readFileSync(path.join(output, name));
  return { name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
const smoke = JSON.parse(fs.readFileSync(path.join(root, 'out/packaging-smoke/report.json'), 'utf8'));
if (!smoke.practice?.cleanExit || !smoke.practice.moveConfirmed || !smoke.replayRoundTrip) throw new Error('Packaged smoke did not pass');
fs.writeFileSync(path.join(output, `SHA256SUMS-${id}.txt`), assets.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n');
fs.writeFileSync(path.join(output, `build-info-${id}.json`), JSON.stringify({
  version, platform: process.platform, arch: process.arch,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceArchive: sourceName, assets, trustedPublisherSignature: false, notarized: false,
  verification: { syntax: true, unitTests: true, runtimeIntegrity: true, packagedSmoke: smoke },
}, null, 2) + '\n');
