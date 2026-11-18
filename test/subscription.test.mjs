import assert from 'node:assert/strict';
import test from 'node:test';
import { readTopologyResponse } from '../lib/subscription.mjs';

function streamed(...chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      controller.close();
    },
  }));
}

function data(event) {
  return `data: ${JSON.stringify(event)}\r\n\r\n`;
}

test('reads a completed topology across stream and UTF-8 boundaries', async () => {
  const first = Buffer.from(data({ type: 'response.output_text.delta', delta: '{"name":"Oficina Ñ"}' }));
  const boundary = first.indexOf(Buffer.from('Ñ')) + 1;
  const response = streamed(first.subarray(0, boundary), first.subarray(boundary, first.length - 1),
    '\n' + data({ type: 'response.completed' }));
  assert.deepEqual(await readTopologyResponse(response), { name: 'Oficina Ñ' });
});

test('requires a completion event before accepting topology JSON', async () => {
  const response = streamed(data({ type: 'response.output_text.delta', delta: '{"name":"Example"}' }));
  await assert.rejects(() => readTopologyResponse(response), /ended before the topology completed/);
});

test('surfaces a subscription limit reported after streaming starts', async () => {
  const response = streamed(data({ type: 'response.created' }), data({
    type: 'response.failed',
    response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
  }));
  await assert.rejects(() => readTopologyResponse(response), /ChatGPT plan usage limit/);
});
