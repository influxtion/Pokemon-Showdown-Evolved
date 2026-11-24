'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { extractProtocol, MESSAGES } = require('./battle-review-input');
const { analyzeBattle } = require('./battle-review-model');

try {
  const log = extractProtocol(workerData.text, workerData.type);
  const report = analyzeBattle(log);
  if (workerData.practice && report.supported && report.format === '[Gen 9] Random Battle') {
    require('./battle-review-practice').attachPracticeReview(report, log, workerData.practice);
  }
  parentPort.postMessage({ report });
} catch (error) {
  parentPort.postMessage({ code: Object.hasOwn(MESSAGES, error?.code) ? error.code : 'review-failed' });
}
