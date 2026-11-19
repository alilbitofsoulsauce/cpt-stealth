import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeRoutedTopology, routedTopologySchema } from '../lib/routed-topology.mjs';

function site(name, subnet, overrides = {}) {
  return {
    name, routerName: `R-${name}`, switchName: `SW-${name}`,
    vlans: [{ id: 10, name: 'Users', subnet, gateway: null, pcs: [{ name: `PC-${name}`, ipv4: null }] }],
    ...overrides,
  };
}

function link(from, to, subnet = '10.255.0.0/30', overrides = {}) {
  return { from, to, subnet, fromIpv4: null, toIpv4: null, ...overrides };
}

function lab(overrides = {}) {
  return {
    kind: 'routed', name: 'Branch network',
    sites: [site('HQ', '192.168.10.0/24'), site('Branch', '192.168.20.0/24')],
    wanLinks: [link('HQ', 'Branch')],
    pings: [{ from: 'pc-hq', to: 'PC-Branch' }], unsupported: [],
    ...overrides,
  };
}

test('normalizes two sites, static gateways, WAN ports, and remote VLAN routes', () => {
  const input = lab();
  const original = structuredClone(input);
  const normalized = normalizeRoutedTopology(input);
  assert.equal(normalized.schemaVersion, 2);
  assert.deepEqual(normalized.sites[0], {
    name: 'HQ', routerName: 'R-HQ', switchName: 'SW-HQ',
    vlans: [{ id: 10, name: 'Users', subnet: '192.168.10.0/24', network: '192.168.10.0',
      mask: '255.255.255.0', gateway: '192.168.10.1',
      pcs: [{ name: 'PC-HQ', ipv4: '192.168.10.2', switchPort: 'FastEthernet0/1' }] }],
    routes: [{ network: '192.168.20.0', mask: '255.255.255.0', nextHop: '10.255.0.2' }],
  });
  assert.deepEqual(normalized.wanLinks, [{
    from: 'HQ', to: 'Branch', subnet: '10.255.0.0/30', network: '10.255.0.0', mask: '255.255.255.252',
    fromIpv4: '10.255.0.1', toIpv4: '10.255.0.2', fromPort: 'GigabitEthernet0/1', toPort: 'GigabitEthernet0/1',
  }]);
  assert.deepEqual(normalized.pings, [{ from: 'PC-HQ', to: 'PC-Branch' }]);
  assert.deepEqual(input, original);
});

test('one site supports inter-VLAN routing without WAN links', () => {
  const headquarters = site('HQ', '192.168.10.0/24');
  headquarters.vlans.push({ id: 20, name: 'Voice', subnet: '192.168.20.0/24', gateway: '192.168.20.10',
    pcs: [{ name: 'Desk', ipv4: null }] });
  const result = normalizeRoutedTopology(lab({ sites: [headquarters], wanLinks: [], pings: null }));
  assert.deepEqual(result.sites[0].routes, []);
  assert.deepEqual(result.pings, []);
  assert.equal(result.sites[0].vlans[1].pcs[0].switchPort, 'FastEthernet0/2');
  assert.equal(result.sites[0].vlans[1].pcs[0].ipv4, '192.168.20.1');
});

test('reserves explicit PC and gateway addresses before automatic allocation', () => {
  const hq = site('HQ', '192.168.10.0/24');
  hq.vlans[0].pcs = [{ name: 'LAN_GATEWAY', ipv4: '192.168.10.1' }, { name: 'Other', ipv4: null }];
  let result = normalizeRoutedTopology(lab({ sites: [hq], wanLinks: [], pings: [] }));
  assert.equal(result.sites[0].vlans[0].gateway, '192.168.10.2');
  assert.deepEqual(result.sites[0].vlans[0].pcs.map((pc) => pc.ipv4), ['192.168.10.1', '192.168.10.3']);
  hq.vlans[0].gateway = '192.168.10.3';
  result = normalizeRoutedTopology(lab({ sites: [hq], wanLinks: [], pings: [] }));
  assert.equal(result.sites[0].vlans[0].pcs[1].ipv4, '192.168.10.2');
  hq.vlans[0].gateway = '192.168.10.1';
  assert.throws(() => normalizeRoutedTopology(lab({ sites: [hq], wanLinks: [], pings: [] })), /Duplicate IPv4/);
});

test('routes four-site chains through the first adjacent router in either orientation', () => {
  const result = normalizeRoutedTopology(lab({
    sites: ['A', 'B', 'C', 'D'].map((name, index) => site(name, `192.168.${index + 1}.0/24`)),
    wanLinks: [link('b', 'A'), link('C', 'b', '10.255.0.4/30'), link('C', 'D', '10.255.0.8/30')],
    pings: [],
  }));
  assert.deepEqual(result.wanLinks.map((wan) => [wan.fromPort, wan.toPort]), [
    ['GigabitEthernet0/1', 'GigabitEthernet0/1'],
    ['GigabitEthernet0/1', 'GigabitEthernet0/2'],
    ['GigabitEthernet0/2', 'GigabitEthernet0/1'],
  ]);
  assert.deepEqual(result.sites[0].routes.map((route) => route.nextHop), Array(3).fill('10.255.0.1'));
  assert.deepEqual(result.sites[3].routes.map((route) => route.nextHop), Array(3).fill('10.255.0.9'));
  assert.deepEqual(result.sites[1].routes.map((route) => route.nextHop), ['10.255.0.2', '10.255.0.5', '10.255.0.5']);
});

test('accepts 23 PCs and eight VLANs per site and reserves switch port 24', () => {
  const hq = site('HQ', '192.168.10.0/24');
  hq.vlans = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1, name: `VLAN${index + 1}`, subnet: `192.168.${index + 1}.0/24`, gateway: null,
    pcs: Array.from({ length: index === 7 ? 2 : 3 }, (_, pc) => ({ name: `PC${index}-${pc}`, ipv4: null })),
  }));
  const result = normalizeRoutedTopology(lab({ sites: [hq], wanLinks: [], pings: [] }));
  assert.equal(result.sites[0].vlans[7].pcs[1].switchPort, 'FastEthernet0/23');
  hq.vlans[7].pcs.push({ name: 'Extra', ipv4: null });
  assert.throws(() => normalizeRoutedTopology(lab({ sites: [hq], wanLinks: [], pings: [] })), /up to 23 PCs/);
});

test('rejects duplicate VLAN IDs and invalid or reserved VLAN IDs', () => {
  for (const id of [0, 1002, 1005, 4095, 1.5, '10']) {
    const input = lab();
    input.sites[0].vlans[0].id = id;
    assert.throws(() => normalizeRoutedTopology(input), /VLAN ID/);
  }
  const input = lab();
  input.sites[0].vlans.push({ ...input.sites[0].vlans[0], subnet: '192.168.30.0/24', pcs: [] });
  assert.throws(() => normalizeRoutedTopology(input), /Duplicate VLAN ID/);
});

test('requires unique device and site names across the whole lab', () => {
  const cases = [
    (input) => { input.sites[1].routerName = 'sw-hq'; },
    (input) => { input.sites[1].vlans[0].pcs[0].name = 'PC-HQ'; },
    (input) => { input.sites[1].switchName = 'pc-hq'; },
  ];
  for (const mutate of cases) {
    const input = lab();
    mutate(input);
    assert.throws(() => normalizeRoutedTopology(input), /Duplicate device name/);
  }
  const input = lab();
  input.sites[1].name = 'hq';
  assert.throws(() => normalizeRoutedTopology(input), /Duplicate site name/);
});

test('rejects overlapping VLAN and WAN networks and addresses outside each LAN', () => {
  for (const subnet of ['192.168.10.0/24', '192.168.10.0/25', '192.168.0.0/16']) {
    const input = lab();
    input.sites[1].vlans[0].subnet = subnet;
    assert.throws(() => normalizeRoutedTopology(input), /overlaps/);
  }
  const input = lab();
  input.sites[0].vlans[0].subnet = '10.255.0.0/24';
  assert.throws(() => normalizeRoutedTopology(input), /overlaps/);
  input.sites[0].vlans[0].gateway = '192.168.10.1';
  assert.throws(() => normalizeRoutedTopology(input), /usable host/);
});

test('WAN subnets use distinct private /30s and reserve explicit WAN addresses', () => {
  for (const subnet of ['8.8.8.0/30', '172.15.255.252/30', '172.32.0.0/30', '192.169.0.0/30', '10.255.0.0/29']) {
    assert.throws(() => normalizeRoutedTopology(lab({ wanLinks: [link('HQ', 'Branch', subnet)] })), /private RFC1918 \/30/);
  }
  for (const subnet of ['10.0.0.0/30', '10.255.255.252/30', '172.16.0.0/30', '172.31.255.252/30', '192.168.0.0/30', '192.168.255.252/30']) {
    const input = lab({ wanLinks: [link('HQ', 'Branch', subnet)] });
    assert.equal(normalizeRoutedTopology(input).wanLinks[0].subnet, subnet);
  }
  const normalized = normalizeRoutedTopology(lab({ wanLinks: [link('HQ', 'Branch', '10.255.0.0/30', { toIpv4: '10.255.0.1' })] }));
  assert.equal(normalized.wanLinks[0].fromIpv4, '10.255.0.2');
  assert.throws(() => normalizeRoutedTopology(lab({ wanLinks: [link('HQ', 'Branch', '10.255.0.0/30', { fromIpv4: '10.255.0.0' })] })), /usable host/);
});

test('rejects WAN cycles, disconnected sites, duplicate links, and too many uplinks', () => {
  const sites = ['A', 'B', 'C', 'D'].map((name, index) => site(name, `192.168.${index + 1}.0/24`));
  const invalid = [
    [link('A', 'B')],
    [link('A', 'B'), link('B', 'A', '10.255.0.4/30'), link('C', 'D', '10.255.0.8/30')],
    [link('A', 'B'), link('B', 'C', '10.255.0.4/30'), link('C', 'A', '10.255.0.8/30')],
    [link('A', 'B'), link('A', 'C', '10.255.0.4/30'), link('A', 'D', '10.255.0.8/30')],
    [link('A', 'A'), link('B', 'C', '10.255.0.4/30'), link('C', 'D', '10.255.0.8/30')],
  ];
  for (const wanLinks of invalid) {
    assert.throws(() => normalizeRoutedTopology(lab({ sites, wanLinks, pings: [] })), /tree|repeats|two WAN uplinks|distinct sites/);
  }
});

test('validates ping endpoints, repeated checks, and the 24-check limit', () => {
  for (const pings of [[{ from: 'R-HQ', to: 'PC-Branch' }], [{ from: 'PC-HQ', to: 'pc-hq' }],
    [{ from: 'PC-HQ', to: 'PC-Branch' }, { from: 'pc-hq', to: 'pc-branch' }]]) {
    assert.throws(() => normalizeRoutedTopology(lab({ pings })), /distinct PCs|repeats/);
  }
  const hq = site('HQ', '192.168.10.0/24');
  hq.vlans[0].pcs = Array.from({ length: 6 }, (_, index) => ({ name: `PC${index}`, ipv4: null }));
  const pings = hq.vlans[0].pcs.flatMap(({ name: from }) => hq.vlans[0].pcs.filter(({ name }) => name !== from)
    .map(({ name: to }) => ({ from, to })));
  assert.equal(normalizeRoutedTopology(lab({ sites: [hq], wanLinks: [], pings: pings.slice(0, 24) })).pings.length, 24);
  assert.throws(() => normalizeRoutedTopology(lab({ sites: [hq], wanLinks: [], pings: pings.slice(0, 25) })), /up to 24/);
});

test('rejects unsupported features and unknown nested fields and exposes a strict schema', () => {
  assert.throws(() => normalizeRoutedTopology(lab({ unsupported: ['OSPF'] })), /Unsupported features: OSPF/);
  const input = lab();
  input.sites[0].vlans[0].pcs[0].config = 'command';
  assert.throws(() => normalizeRoutedTopology(input), /unexpected field/);
  assert.throws(() => normalizeRoutedTopology(lab({ kind: 'flat' })), /kind must be routed/);
  assert.equal(routedTopologySchema.additionalProperties, false);
  assert.deepEqual(routedTopologySchema.required, Object.keys(routedTopologySchema.properties));
});
