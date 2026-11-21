"use strict";

const os = require('node:os');
const fs = require('node:fs');
const MB = 1024 * 1024;

// Honor an exposed Linux container CPU quota in addition to CPU affinity.
function cpuCount(read = file => fs.readFileSync(file, 'utf8'), parallelism = os.availableParallelism()) {
  let cpus = parallelism;
  try {
    const [quota, period] = read('/sys/fs/cgroup/cpu.max').trim().split(/\s+/).map(Number);
    if (quota > 0 && period > 0) cpus = Math.min(cpus, quota / period);
  } catch {
    try {
      const quota = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
      const period = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
      if (quota > 0 && period > 0) cpus = Math.min(cpus, quota / period);
    } catch { /* Bare host or a different cgroup mount; affinity remains the bound. */ }
  }
  return cpus;
}

function hostResources({ cpus = cpuCount(), total = os.totalmem(), constrained = process.constrainedMemory(),
  available = () => process.availableMemory(), env = process.env } = {}) {
  const memoryMb = Math.floor(Math.min(total, constrained > 0 ? constrained : total) / MB);
  const reserveMb = Math.max(1024, Math.ceil(memoryMb / 4));
  const read = (name, fallback) => {
    if (env[name] === undefined || env[name] === '') return fallback;
    if (!/^[1-9]\d*$/.test(env[name]) || !Number.isSafeInteger(Number(env[name]))) throw new Error(`${name} must be a positive whole number.`);
    return Number(env[name]);
  };
  const threads = Math.min(read('MAX_TOTAL_THREADS', 256), Math.max(1, Math.floor(cpus * 0.75)));
  const memory = Math.min(read('BOT_MEMORY_MB', memoryMb), Math.max(0, memoryMb - reserveMb));
  return { threads, memoryMb: memory, reserveMb,
    foulplayMb: Math.max(512, read('FOULPLAY_MEMORY_MB', 512)),
    metamonMb: Math.max(2048, read('METAMON_MEMORY_MB', 2048)),
    availableMb: () => Math.max(0, Math.floor(available() / MB)) };
}

module.exports = { hostResources, cpuCount };


if (require.main === module) {
  const budget = hostResources();
  console.log(JSON.stringify({ ...budget, availableMb: budget.availableMb() }, null, 2));
}
