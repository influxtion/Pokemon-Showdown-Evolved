'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { extractProtocol, MESSAGES } = require('./battle-review-input');
const { analyzeBattle } = require('./battle-review-model');

try {
  const log = extractProtocol(workerData.text, workerData.type);
  parentPort.postMessage({ report: analyzeBattle(log) });
} catch (error) {
  parentPort.postMessage({ code: Object.hasOwn(MESSAGES, error?.code) ? error.code : 'review-failed' });
}
