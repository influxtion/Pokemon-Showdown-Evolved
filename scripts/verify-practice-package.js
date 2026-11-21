'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { verifyRuntime } = require('../app/practice-manifest');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'practice');
const ADAPTER = path.join(__dirname, 'practice');
// Releases carry only the simulator entry point; the build scripts are checked as sources.
const ADAPTER_FILES = ['server.cjs'];
const BUILD_FILES = ['build-server.cjs', 'build-client.cjs'];
const CLIENT_FILES = ['practice-client.html', 'practice-client.css', 'client-bootstrap.js'];

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function fileSha(file) { return sha(fs.readFileSync(file)); }

function configuredResource({ packager }, destination) {
  const entries = [packager.config.extraResources, packager.platformSpecificBuildOptions?.extraResources].flat();
  const matches = entries.filter(entry => entry && typeof entry === 'object' && entry.to === destination);
  if (matches.length !== 1 || !matches[0].from) throw new Error(`The package must define one ${destination} resource.`);
  return path.resolve(packager.projectDir || ROOT, matches[0].from);
}

function checkedRuntime(root, failureMessage) {
  const result = verifyRuntime(root);
  if (!result.ok) throw new Error(failureMessage);
  const bytes = fs.readFileSync(path.join(root, 'manifest.json'));
  if (sha(bytes) !== result.identity) throw new Error('Practice runtime changed during verification.');
  if (result.kind !== 'simulator') {
    throw new Error('Only a simulator runtime can be packaged. Rebuild with npm run build:practice.');
  }
  return { manifest: JSON.parse(bytes), identity: result.identity };
}

function verifySource(manifest) {
  for (const name of ['package.json', 'package-lock.json']) {
    const expected = fileSha(path.join(VENDOR, `server-${name}`));
    if (manifest.files[`server/${name}`]?.sha256 !== expected ||
        manifest.files[`sources/server-${name}`]?.sha256 !== expected) {
      throw new Error('Simulator dependencies changed after the runtime build. Rebuild before packaging.');
    }
  }
  for (const name of [...ADAPTER_FILES, ...BUILD_FILES]) {
    if (manifest.files[`sources/desktop-adapter/${name}`]?.sha256 !== fileSha(path.join(ADAPTER, name))) {
      throw new Error(`Practice adapter ${name} changed after the runtime build. Rebuild before packaging.`);
    }
  }
  for (const name of CLIENT_FILES) {
    const expected = fileSha(path.join(VENDOR, name));
    if (manifest.files[`sources/${name}`]?.sha256 !== expected || manifest.files[`client/${name}`]?.sha256 !== expected) {
      throw new Error(`Practice client ${name} changed after the runtime build. Rebuild before packaging.`);
    }
  }
}

function verifyAdapters(directory, manifest) {
  for (const name of ADAPTER_FILES) {
    const filename = path.join(directory, name);
    if (!fs.existsSync(filename) || !fs.lstatSync(filename).isFile() ||
        manifest.files[`sources/desktop-adapter/${name}`]?.sha256 !== fileSha(filename)) {
      throw new Error(`Practice adapter ${name} is missing or differs from the verified runtime source.`);
    }
  }
}

async function verifyPracticePackage(context) {
  // Optional first-launch installation still needs a complete, verified payload in the app.
  new (require('../app/showdex-install').ShowdexInstaller)(ROOT).payload();
  const root = configuredResource(context, 'practice');
  const { manifest, identity } = checkedRuntime(root,
    'Build and verify the local runtime with npm run build:practice before packaging.');
  verifySource(manifest);
  verifyAdapters(configuredResource(context, 'practice-adapter'), manifest);
  console.log(`Practice runtime verified for packaging: ${identity}`);
}

// From api/, the app ships what Foul Play play needs: the client and protocol, plus, for the
// opt-in local mode, the installer, pins, local server and worker (unpacked from app.asar for
// Python). Foul Play itself is downloaded only on request; nothing else from api/ may ship.
const METAMON_FILES = ['install.js', 'lock.json', 'requirements.txt', 'bootstrap.txt', 'worker.py', 'CODE-LICENSE', 'MODEL-LICENSE', 'MODEL-CARD', 'ATTRIBUTION.txt'];
const SHIPPED_API = ['metamon', ...METAMON_FILES.map(name => `metamon/${name}`), 'client.js', 'protocol.js', 'install.js', 'server.js', 'lock.json', 'worker', 'worker/foulplay_worker.py'];
const UNPACKED_API = ['worker', 'worker/foulplay_worker.py', 'metamon', 'metamon/worker.py'];

function listFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [name, ...listFiles(path.join(dir, entry.name), name)] : [name];
  });
}

function verifyApiFiles(resources) {
  const asar = require('@electron/asar');
  const api = asar.listPackage(path.join(resources, 'app.asar'))
    .map(entry => entry.replace(/\\/g, '/'))
    .filter(entry => entry.startsWith('/api/'))
    .map(entry => entry.slice('/api/'.length));
  const unexpected = api.filter(name => !SHIPPED_API.includes(name));
  if (unexpected.length) throw new Error(`The package must ship only api/${SHIPPED_API.join(', api/')}; found api/${unexpected.join(', api/')}.`);
  const missing = SHIPPED_API.filter(name => !api.includes(name));
  if (missing.length) throw new Error(`The package is missing api/${missing.join(', api/')}, which optional bot downloads need.`);
  const unpackedDir = path.join(resources, 'app.asar.unpacked', 'api');
  const unpacked = fs.existsSync(unpackedDir) ? listFiles(unpackedDir) : [];
  if (unpacked.length !== UNPACKED_API.length || UNPACKED_API.some(name => !unpacked.includes(name))) {
    throw new Error(`Only the Foul Play and Metamon Python workers may be unpacked from app.asar; found ${unpacked.join(', ') || 'nothing'}.`);
  }
}

async function verifyCopiedPracticePackage(context) {
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const { manifest, identity } = checkedRuntime(path.join(resources, 'practice'),
    'The copied Practice runtime failed integrity verification.');
  const sourceManifest = path.join(configuredResource(context, 'practice'), 'manifest.json');
  if (identity !== fileSha(sourceManifest)) throw new Error('Copied Practice runtime differs from the configured source.');
  verifySource(manifest);
  const adapters = path.join(resources, 'practice-adapter');
  verifyAdapters(adapters, manifest);
  if (fs.readdirSync(adapters).length !== ADAPTER_FILES.length) throw new Error('Copied Practice adapter has unexpected files.');
  verifyApiFiles(resources);
  console.log(`Copied Practice runtime and adapters verified: ${identity}`);
}

module.exports = verifyPracticePackage;
module.exports.verifyCopiedPracticePackage = verifyCopiedPracticePackage;

module.exports.verifyApiFiles = verifyApiFiles;
