import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const moduleSource = await readFile(new URL('../packet-tracer/helper.js', import.meta.url), 'utf8');

test('queues 24 one-packet checks and retries a missed response without reusing old output', () => {
  const context = {};
  runInNewContext(moduleSource, context);
  const names = Array.from({ length: 24 }, (_, index) => `Bench${index + 1}`);
  const checks = names.slice(1).map(to => ({ from: names[0], to, ok: false }));
  checks.push({ from: names[23], to: names[0], ok: false });
  const sent = [];
  const endpoints = Object.fromEntries(names.map((name, index) => {
    let output = '';
    const terminal = {
      getOutput: () => output,
      enterCommand(command) {
        const match = /^ping -n 1 (10\.0\.0\.\d+)$/.exec(command);
        assert.ok(match);
        const address = match[1];
        const noReply = sent.length === 0;
        sent.push({ name, address });
        output += `\nPing statistics for ${address}:\n    Packets: Sent = 1, Received = ${noReply ? 0 : 1}, Lost = ${noReply ? 1 : 0}`;
      },
    };
    return [name, { ipv4: `10.0.0.${index + 1}`, device: { getCommandLine: () => terminal } }];
  }));
  const job = { pingQueue: checks.slice(), pingAttempts: Object.create(null), endpoints };
  context.pollPings(job);
  assert.deepEqual(sent.map(check => check.name), ['Bench1', 'Bench24']);
  for (let tick = 0; tick < 24; tick++) context.pollPings(job);
  assert.ok(checks.every(check => check.ok));
  assert.equal(sent.length, 25);
  assert.deepEqual(sent.at(-1), sent[0]);
});
