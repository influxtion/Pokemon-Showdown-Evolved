'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { launcherUrl, launcherFrame, httpsHost, denyPermissions } = require('../app/security');
const { boundedJson } = require('../app/bounded-json');
const root = path.resolve(__dirname, '../renderer');
const url = pathToFileURL(path.join(root, 'index.html')).href;

test('IPC accepts only the known launcher main frame', () => {
  const frame = { url };
  const contents = { mainFrame: frame };
  assert(launcherFrame({ sender: contents, senderFrame: frame }, contents, root));
  assert(!launcherFrame({ sender: {}, senderFrame: frame }, contents, root));
  assert(!launcherFrame({ sender: contents, senderFrame: { url } }, contents, root));
  assert(launcherUrl(`${url}?review=123#anchor`, root));
  for (const bad of ['https://evil.example/index.html', url.replace('index.html', 'unexpected.html'),
    url.replace('/renderer/', '/renderer-evil/'), url.replace('index.html', '../app/main.js'), 'file://attacker/share/index.html']) {
    assert(!launcherUrl(bad, root), bad);
  }
});

test('remote navigation rejects lookalikes, credentials and alternate ports', () => {
  const hosts = ['play.pokemonshowdown.com'];
  assert(httpsHost('https://play.pokemonshowdown.com/', hosts));
  for (const bad of ['http://play.pokemonshowdown.com', 'https://play.pokemonshowdown.com.evil.test',
    'https://evil.pokemonshowdown.com', 'https://user@play.pokemonshowdown.com',
    'https://play.pokemonshowdown.com:444', 'file:///tmp/test']) assert(!httpsHost(bad, hosts), bad);
});

test('all browser and device permissions fail closed', () => {
  let check, request, device;
  denyPermissions({ setPermissionCheckHandler: fn => { check = fn; },
    setPermissionRequestHandler: fn => { request = fn; }, setDevicePermissionHandler: fn => { device = fn; } });
  for (const name of ['media', 'geolocation', 'notifications', 'clipboard-read', 'unknown-future-permission']) {
    assert.equal(check(null, name), false);
    request(null, name, allowed => assert.equal(allowed, false));
  }
  assert.equal(device({ deviceType: 'usb' }), false);
});

test('JSON response limits cancel oversized streams before reading to completion', async () => {
  assert.deepEqual(await boundedJson(Response.json({ ok: true })), { ok: true });
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled = true; } });
  await assert.rejects(boundedJson(new Response(body), 2048), /too large/);
  assert(cancelled);
  await assert.rejects(boundedJson(new Response('not json')));
});
