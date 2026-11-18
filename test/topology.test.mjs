import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTopology, topologySchema } from '../lib/topology.mjs';

function lab(overrides = {}) {
  return {
    name: 'Office LAN',
    switchName: 'SW-1',
    subnet: '192.168.10.0/24',
    pcs: [{ name: 'PC-1', ipv4: null }, { name: 'PC-2', ipv4: '192.168.10.1' }],
    pings: [{ from: 'pc-1', to: 'PC-2' }],
    unsupported: [],
    ...overrides,
  };
}

test('reserves explicit IPs before assigning addresses and generates switch ports', () => {
  const input = lab();
  assert.deepEqual(normalizeTopology(input), {
    schemaVersion: 1,
    name: 'Office LAN',
    switchName: 'SW-1',
    subnet: '192.168.10.0/24',
    mask: '255.255.255.0',
    pcs: [
      { name: 'PC-1', ipv4: '192.168.10.2', switchPort: 'FastEthernet0/1' },
      { name: 'PC-2', ipv4: '192.168.10.1', switchPort: 'FastEthernet0/2' },
    ],
    pings: [{ from: 'PC-1', to: 'PC-2' }],
  });
  assert.equal(input.pcs[0].ipv4, null);
});

test('assigns all 24 FastEthernet ports and rejects a 25th PC', () => {
  const pcs = Array.from({ length: 24 }, (_, index) => ({ name: `PC-${index + 1}`, ipv4: null }));
  const result = normalizeTopology(lab({ pcs, pings: null }));
  assert.deepEqual(result.pcs[23], {
    name: 'PC-24', ipv4: '192.168.10.24', switchPort: 'FastEthernet0/24',
  });
  assert.deepEqual(result.pings, []);
  assert.throws(() => normalizeTopology(lab({ pcs: [...pcs, { name: 'Extra', ipv4: null }] })), /1–24 PCs/);
  assert.throws(() => normalizeTopology(lab({ pcs: [] })), /1–24 PCs/);
});

test('handles the exact host capacity of a /30 subnet', () => {
  const pcs = [{ name: 'One', ipv4: null }, { name: 'Two', ipv4: null }];
  const input = lab({ subnet: '10.0.0.4/30', pcs, pings: [] });
  const result = normalizeTopology(input);
  assert.equal(result.mask, '255.255.255.252');
  assert.deepEqual(result.pcs.map(({ ipv4 }) => ipv4), ['10.0.0.5', '10.0.0.6']);
  assert.deepEqual(result.pings, []);
  assert.throws(() => normalizeTopology({ ...input, pcs: [...pcs, { name: 'Three', ipv4: null }] }), /too few usable/);
});

test('rejects wrong networks, unsuitable masks, and invalid host addresses', () => {
  const invalid = [
    { subnet: '192.168.10.1/24', error: /host bits/ },
    { subnet: '192.168.10.0/32', error: /prefix/ },
    { subnet: '192.168.300.0/24', error: /octet above/ },
    { ipv4: '192.168.10.0', error: /usable host/ },
    { ipv4: '192.168.10.255', error: /usable host/ },
    { ipv4: '192.168.11.5', error: /usable host/ },
    { ipv4: '192.168.10.03', error: /dotted-decimal/ },
    { subnet: '127.0.0.0/24', ipv4: '127.0.0.10', error: /usable host/ },
    { subnet: '224.0.0.0/24', ipv4: '224.0.0.10', error: /usable host/ },
  ];
  for (const { subnet = '192.168.10.0/24', ipv4 = null, error } of invalid) {
    assert.throws(() => normalizeTopology(lab({ subnet, pcs: [{ name: 'One', ipv4 }], pings: [] })), error);
  }
});

test('rejects duplicate IPv4 addresses and case-insensitive device name collisions', () => {
  assert.throws(() => normalizeTopology(lab({ pcs: [
    { name: 'One', ipv4: '192.168.10.3' }, { name: 'Two', ipv4: '192.168.10.3' },
  ] })), /Duplicate IPv4 address/);
  assert.throws(() => normalizeTopology(lab({ pcs: [
    { name: 'One', ipv4: null }, { name: 'one', ipv4: null },
  ] })), /Duplicate device name/);
  assert.throws(() => normalizeTopology(lab({ switchName: 'pc-1' })), /Duplicate device name/);
});

test('rejects invalid device names and pings that cannot verify lab connectivity', () => {
  assert.throws(() => normalizeTopology(lab({ switchName: 'Office Switch' })), /Switch name/);
  assert.throws(() => normalizeTopology(lab({ pings: [{ from: 'SW-1', to: 'PC-2' }] })), /two PCs/);
  assert.throws(() => normalizeTopology(lab({ pings: [{ from: 'PC-1', to: 'pc-1' }] })), /two different PCs/);
  assert.throws(() => normalizeTopology(lab({ pings: [
    { from: 'PC-1', to: 'PC-2' }, { from: 'pc-1', to: 'pc-2' },
  ] })), /repeats the ping/);
});

test('accepts up to 24 ping checks, matching the Packet Tracer module', () => {
  const pcs = Array.from({ length: 6 }, (_, index) => ({ name: `PC-${index + 1}`, ipv4: null }));
  const pings = pcs.flatMap(({ name: from }) => pcs.filter(({ name }) => name !== from)
    .map(({ name: to }) => ({ from, to })));
  assert.equal(normalizeTopology(lab({ pcs, pings: pings.slice(0, 24) })).pings.length, 24);
  assert.throws(() => normalizeTopology(lab({ pcs, pings: pings.slice(0, 25) })), /up to 24 ping checks/);
});

test('rejects unsupported requirements and fields outside the input schema', () => {
  assert.throws(() => normalizeTopology(lab({ unsupported: ['DHCP'] })), /Unsupported features: DHCP/);
  assert.throws(() => normalizeTopology(lab({ config: 'ping' })), /unexpected field: config/);
  assert.throws(() => normalizeTopology(lab({ pcs: [{ name: 'One' }] })), /missing ipv4/);
  assert.equal(topologySchema.additionalProperties, false);
  assert.deepEqual(topologySchema.required, Object.keys(topologySchema.properties));
});
