"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { hostResources, cpuCount } = require('../resources');
const MB = 1024 * 1024;
test('host budgets preserve CPU and RAM headroom and honor container memory limits', () => {
  const value = hostResources({ cpus: 8, total: 16384 * MB, constrained: 4096 * MB, available: () => 3000 * MB, env: {} });
  assert.equal(value.threads, 6);
  assert.equal(value.memoryMb, 3072);
  assert.equal(value.reserveMb, 1024);
  assert.equal(value.availableMb(), 3000);
  assert.equal(value.metamonMb, 2048);
});
test('overrides can tighten budgets but cannot erase detected headroom or minimum worker reservations', () => {
  const value = hostResources({ cpus: 4, total: 8192 * MB, constrained: 0,
    env: { MAX_TOTAL_THREADS: '100', BOT_MEMORY_MB: '999999', METAMON_MEMORY_MB: '1' } });
  assert.equal(value.threads, 3); assert.equal(value.memoryMb, 6144); assert.equal(value.metamonMb, 2048);
  assert.equal(hostResources({ cpus: 1, total: 512 * MB, constrained: 0, env: {} }).memoryMb, 0);
  assert.throws(() => hostResources({ env: { MAX_TOTAL_THREADS: 'bad' } }), /positive whole number/);
});
test('CPU quota detection handles v2, v1 and absent quota without exceeding affinity', () => {
  assert.equal(cpuCount(() => '200000 100000', 8), 2);
  assert.equal(cpuCount(() => 'max 100000', 8), 8);
  assert.equal(cpuCount(file => { if (file.endsWith('cpu.max')) throw Error(); return file.endsWith('quota_us') ? '100000' : '100000'; }, 8), 1);
  assert.equal(cpuCount(() => { throw Error(); }, 4), 4);
});
