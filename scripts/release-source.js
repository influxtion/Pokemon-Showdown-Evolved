'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function releaseMatrix(platforms) {
  if (!['windows-linux', 'macos', 'all'].includes(platforms)) throw new Error('Unknown release platforms.');
  const desktop = [{ runner: 'windows-2025', arch: 'x64', id: 'Windows-x64' },
    { runner: 'ubuntu-24.04', arch: 'x64', id: 'Linux-x64' }];
  const mac = [{ runner: 'macos-15', arch: 'arm64', id: 'macOS-arm64' },
    { runner: 'macos-15-intel', arch: 'x64', id: 'macOS-x64' }];
  return { include: platforms === 'all' ? [...desktop, ...mac] : platforms === 'macos' ? mac : desktop };
}

function verifyReleaseSource({ head, main, dirty, version, requested }) {
  if (!/^[a-f0-9]{40}$/.test(head) || head !== main || dirty) throw new Error('Release source must be a clean fetched main checkout.');
  if (!/^\d+\.\d+\.\d+$/.test(requested) || requested !== version) throw new Error('Release version must match package.json on approved main.');
}

function main() {
  const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const sha = git(['rev-parse', 'HEAD']);
  const version = require('../package.json').version;
  verifyReleaseSource({ head: sha, main: git(['rev-parse', 'refs/remotes/origin/main']),
    dirty: git(['status', '--porcelain', '--untracked-files=no']), version, requested: process.env.RELEASE_VERSION });
  const matrix = releaseMatrix(process.env.RELEASE_PLATFORMS);
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync('out/main-source-provenance.json', JSON.stringify({ sourceRef: 'main', sourceCommit: sha,
    version, workflowCommit: process.env.WORKFLOW_SHA, matrix }, null, 2) + '\n');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\nmatrix=${JSON.stringify(matrix)}\n`);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Application source: main at ${sha}; version ${version}.\n`);
}

if (require.main === module) main();
module.exports = { releaseMatrix, verifyReleaseSource };
