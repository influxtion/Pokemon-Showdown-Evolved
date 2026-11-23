'use strict';

const { pathToFileURL } = require('node:url');
const path = require('node:path');

const PAGES = ['index.html', 'play.html', 'stats.html', 'replays.html', 'battle-review.html', 'practice.html', 'practice-battle.html', 'settings.html', 'resources.html'];

function launcherUrl(value, directory) {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return PAGES.some(page => url.href === pathToFileURL(path.join(directory, page)).href);
  } catch { return false; }
}

function launcherFrame(event, contents, directory) {
  return Boolean(contents && event.sender === contents && event.senderFrame &&
    event.senderFrame === contents.mainFrame && launcherUrl(event.senderFrame.url, directory));
}

function httpsHost(value, hosts) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname);
  } catch { return false; }
}

function denyPermissions(session) {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  session.setDevicePermissionHandler(() => false);
}

module.exports = { launcherUrl, launcherFrame, httpsHost, denyPermissions };
