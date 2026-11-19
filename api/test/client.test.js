'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InferenceClient } = require('../client');

test('API client stops oversized streamed replies before downloading the rest', async () => {
  let pulls = 0;
  let cancelled = false;
  const client = new InferenceClient({ url: 'http://127.0.0.1:9', fetcher: async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(32768)); },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(client.info(), { code: 'invalid-reply', message: 'The practice server sent an unexpectedly large reply.' });
  assert.equal(cancelled, true);
  assert.ok(pulls <= 4, 'bounded read plus at most one prefetched chunk');
});

test('API client counts UTF-8 bytes and rejects missing or malformed JSON', async () => {
  for (const body of [JSON.stringify('é'.repeat(33000)), 'invalid', null]) {
    const client = new InferenceClient({ url: 'http://127.0.0.1:9', fetcher: async () => new Response(body) });
    await assert.rejects(client.info(), { code: 'invalid-reply' });
  }
});
