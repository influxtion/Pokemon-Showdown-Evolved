'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertMacRelease, notarizationCredentials } = require('../scripts/mac-release');
const { releaseMatrix, verifyReleaseSource } = require('../scripts/release-source');
const { applicationMenu } = require('../app/application-menu');

const options = { hardenedRuntime: true, notarize: true, forceCodeSigning: true };
const auth = { APPLE_KEYCHAIN_PROFILE: 'fixture-profile' };

test('Mac release rejects missing credentials, non-Mac hosts and disabled signing protections', () => {
  assert.throws(() => assertMacRelease(options, {}, 'darwin'), /credentials/);
  assert.throws(() => assertMacRelease(options, auth, 'win32'), /macOS/);
  for (const extra of [{ identity: '-' }, { identity: null }, { hardenedRuntime: false }, { notarize: false }, { forceCodeSigning: false }]) {
    assert.throws(() => assertMacRelease({ ...options, ...extra }, auth, 'darwin'));
  }
  assert.throws(() => assertMacRelease(options, { ...auth, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, 'darwin'));
  assert.deepEqual(assertMacRelease(options, auth, 'darwin'), { keychainProfile: 'fixture-profile' });
});

test('notarization supports complete Apple ID, API key or keychain credentials without incomplete fallback', () => {
  assert.throws(() => notarizationCredentials({ ...auth, APPLE_ID: 'test@example.com' }), /APPLE_APP_SPECIFIC_PASSWORD/);
  assert.throws(() => notarizationCredentials({ APPLE_API_KEY: 'key.p8' }), /APPLE_API_KEY_ID/);
  assert.deepEqual(notarizationCredentials({ APPLE_ID: 'test@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'fixture', APPLE_TEAM_ID: 'team' }),
    { appleId: 'test@example.com', appleIdPassword: 'fixture', teamId: 'team' });
  assert.deepEqual(notarizationCredentials({ APPLE_API_KEY: 'key.p8', APPLE_API_KEY_ID: 'id', APPLE_API_ISSUER: 'issuer' }),
    { appleApiKey: 'key.p8', appleApiKeyId: 'id', appleApiIssuer: 'issuer' });
});

test('release source must be clean fetched main at the approved package version', () => {
  const value = { head: 'a'.repeat(40), main: 'a'.repeat(40), dirty: '', version: '1.0.0', requested: '1.0.0' };
  assert.doesNotThrow(() => verifyReleaseSource(value));
  for (const extra of [{ head: 'b'.repeat(40) }, { dirty: ' M app/main.js' }, { requested: '0.4.0' }, { requested: '1.0.0; bad' }]) {
    assert.throws(() => verifyReleaseSource({ ...value, ...extra }));
  }
  assert.equal(releaseMatrix('windows-linux').include.some(x => x.id.startsWith('macOS')), false);
  assert.deepEqual(releaseMatrix('macos').include.map(x => x.arch), ['arm64', 'x64']);
  assert.equal(releaseMatrix('all').include.length, 4);
  assert.throws(() => releaseMatrix('unexpected'));
});

test('Mac menu keeps native editing and quit roles and routes tab closes separately from window closes', () => {
  const actions = [];
  const menu = applicationMenu('darwin', { name: 'Test', shortcut: action => actions.push(action), closeWindow: () => actions.push('window') });
  assert.ok(menu.some(x => x.role === 'editMenu'));
  assert.ok(menu[0].submenu.some(x => x.role === 'quit'));
  menu.find(x => x.label === 'File').submenu[0].click();
  menu.find(x => x.label === 'File').submenu[1].click();
  assert.deepEqual(actions, [{ type: 'close' }, 'window']);
  assert.equal(applicationMenu('win32', {}), null);
});
