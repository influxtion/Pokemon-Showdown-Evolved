'use strict';

// Enforce the limit while receiving bytes, before allocating the entire response.
async function boundedJson(response, limit = 65536) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Response too large.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

module.exports = { boundedJson };
