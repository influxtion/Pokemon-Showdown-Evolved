'use strict';
// Real Electron practice games against Foul Play through a stand-in for the cloud API server.
// Needs `npm run api:setup` (or BOT_TEST_FOULPLAY_DIR) first.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
console.log('Testing Foul Play (cloud API stand-in)');
const env = { ...process.env, SHOWDOWN_DESKTOP_BACKGROUND: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [path.resolve(__dirname, '../../tests/practice-desktop.cjs')], {
  stdio: 'inherit', env, windowsHide: true, timeout: 300000,
});
if (result.status !== 0) process.exitCode = 1;
