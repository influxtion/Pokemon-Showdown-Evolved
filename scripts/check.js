'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const dir of ['app', 'renderer', 'scripts', 'tests', 'api']) {
  for (const file of fs.readdirSync(path.join(__dirname, '..', dir), { recursive: true })) {
    // api/runtime is Foul Play's local install (npm run api:setup), not project code.
    if (!/\.(?:js|cjs)$/.test(file) || file.startsWith('node_modules') || (dir === 'api' && file.startsWith('runtime'))) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(__dirname, '..', dir, file)], { stdio: 'inherit' });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) process.exit(1);
  }
}
