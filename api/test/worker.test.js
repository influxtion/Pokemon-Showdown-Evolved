'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { paths } = require('../install');
const runtimePython = paths(path.join(__dirname, '../runtime')).python;
const python = process.env.PRACTICE_TEST_PYTHON || (fs.existsSync(runtimePython)
  ? runtimePython : process.platform === 'win32' ? 'python' : 'python3');

test('Python worker bounds queued input and preserves frame order', t => {
  const result = spawnSync(python, ['-I', '-B', path.join(__dirname, 'worker_test.py')], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  if (result.error?.code === 'ENOENT' && !process.env.PRACTICE_TEST_PYTHON) {
    t.skip('No local runtime or system Python interpreter available');
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
