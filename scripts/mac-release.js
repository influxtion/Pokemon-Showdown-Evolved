'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Match electron-builder's supported notarization credential routes. Never log values.
function notarizationCredentials(env = process.env) {
  if (env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD) {
    if (!env.APPLE_ID || !env.APPLE_APP_SPECIFIC_PASSWORD || !env.APPLE_TEAM_ID) {
      throw new Error('Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID for notarization.');
    }
    return { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID };
  }
  if (env.APPLE_API_KEY || env.APPLE_API_KEY_ID || env.APPLE_API_ISSUER) {
    if (!env.APPLE_API_KEY || !env.APPLE_API_KEY_ID || !env.APPLE_API_ISSUER) {
      throw new Error('Set APPLE_API_KEY (a .p8 file path), APPLE_API_KEY_ID and APPLE_API_ISSUER for notarization.');
    }
    return { appleApiKey: env.APPLE_API_KEY, appleApiKeyId: env.APPLE_API_KEY_ID, appleApiIssuer: env.APPLE_API_ISSUER };
  }
  if (env.APPLE_KEYCHAIN_PROFILE) {
    return { keychainProfile: env.APPLE_KEYCHAIN_PROFILE, ...(env.APPLE_KEYCHAIN ? { keychain: env.APPLE_KEYCHAIN } : {}) };
  }
  throw new Error('Mac release requires notarization credentials; unsigned or unnotarized fallback is disabled.');
}

function assertMacRelease(options, env = process.env, platform = process.platform) {
  if (platform !== 'darwin') throw new Error('Build Developer ID releases on macOS.');
  if (options.identity === '-' || options.identity === null || env.CSC_NAME === '-' || env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    throw new Error('Mac release requires a Developer ID Application identity; ad-hoc/disabled signing is not allowed.');
  }
  if (options.hardenedRuntime !== true || options.notarize !== true || options.forceCodeSigning !== true) {
    throw new Error('Mac release requires hardenedRuntime, notarize and forceCodeSigning.');
  }
  return notarizationCredentials(env);
}

function checked(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error(`${command} release verification failed: ${result.stderr || 'see signing environment'}`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

// Runs after app signing/notarization and after DMG/ZIP generation. ZIP contains the
// stapled app; DMG needs its own ticket. --publish never remains a separate constraint.
async function finishMacRelease(result) {
  const dmgs = result.artifactPaths.filter(file => file.endsWith('.dmg'));
  if (!dmgs.length) return [];
  if (process.platform !== 'darwin') throw new Error('Mac verification requires macOS.');
  const credentials = notarizationCredentials();
  const { notarize } = require('@electron/notarize');
  for (const file of dmgs) {
    await notarize({ appPath: path.resolve(file), ...credentials });
    checked('xcrun', ['stapler', 'validate', file]);
    checked('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', file]);
  }
  const apps = [];
  for (const folder of fs.readdirSync(result.outDir, { withFileTypes: true }).filter(x => x.isDirectory() && /^mac(?:-|$)/.test(x.name))) {
    const dir = path.join(result.outDir, folder.name);
    for (const name of fs.readdirSync(dir).filter(x => x.endsWith('.app'))) apps.push(path.join(dir, name));
  }
  if (!apps.length) throw new Error('No signed app was found for final Mac verification.');
  for (const app of apps) {
    checked('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    const signature = checked('codesign', ['--display', '--verbose=4', app]);
    if (!signature.includes('Authority=Developer ID Application:') || !/flags=.*runtime/.test(signature) || !/Timestamp=/.test(signature)) {
      throw new Error('Final app lacks Developer ID authority, hardened runtime or a secure timestamp.');
    }
    checked('xcrun', ['stapler', 'validate', app]);
    checked('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
    fs.writeFileSync(path.join(result.outDir, `${path.basename(path.dirname(app))}-signature.txt`), signature);
  }
  // These reports stay with review artifacts, not public releases.
  return [];
}

module.exports = { notarizationCredentials, assertMacRelease, finishMacRelease };
