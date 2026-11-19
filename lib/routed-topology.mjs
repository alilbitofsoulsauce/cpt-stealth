import { normalizeTopology } from './topology.mjs';

const maxSites = 4;
const maxVlans = 8;
const maxPcs = 23;
const maxPings = 24;

export const routedTopologySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'name', 'sites', 'wanLinks', 'pings', 'unsupported'],
  properties: {
    kind: { type: 'string', enum: ['routed'] },
    name: { type: 'string', description: 'A short title for the Packet Tracer lab.' },
    sites: {
      type: 'array',
      description: 'One to four sites, each with one 2911 router, one 2960 switch, and one to 23 PCs.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'routerName', 'switchName', 'vlans'],
        properties: {
          name: { type: 'string', description: 'Unique site label used by WAN endpoints.' },
          routerName: { type: 'string', description: 'Globally unique router device name.' },
          switchName: { type: 'string', description: 'Globally unique switch device name.' },
          vlans: {
            type: 'array',
            description: 'One to eight VLANs with distinct IDs and nonoverlapping IPv4 subnets.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'name', 'subnet', 'gateway', 'pcs'],
              properties: {
                id: { type: 'integer', description: 'VLAN ID from 1 through 4094, excluding reserved IDs 1002 through 1005.' },
                name: { type: 'string', description: 'One to 32 ASCII letters, digits, underscores or hyphens.' },
                subnet: { type: 'string', description: 'Canonical IPv4 network address in CIDR notation, with no overlap with other VLANs or WANs.' },
                gateway: { type: ['string', 'null'], description: 'Router gateway IPv4, or null for the lowest usable host after reserving explicit PC addresses.' },
                pcs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['name', 'ipv4'],
                    properties: {
                      name: { type: 'string', description: 'Globally unique PC device name.' },
                      ipv4: { type: ['string', 'null'], description: 'Full IPv4 address, or null for local allocation after the gateway.' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    wanLinks: {
      type: 'array',
      description: 'A connected acyclic tree between site labels, with at most two WAN links per site. Each link uses a distinct private RFC1918 /30 subnet.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'subnet', 'fromIpv4', 'toIpv4'],
        properties: {
          from: { type: 'string', description: 'Source site label.' },
          to: { type: 'string', description: 'Destination site label.' },
          subnet: { type: 'string', description: 'Canonical private RFC1918 IPv4 /30 network.' },
          fromIpv4: { type: ['string', 'null'], description: 'Source router IPv4, or null for automatic assignment.' },
          toIpv4: { type: ['string', 'null'], description: 'Destination router IPv4, or null for automatic assignment.' },
        },
      },
    },
    pings: {
      type: ['array', 'null'],
      description: 'Up to 24 distinct directed ping checks between named PCs, or null for no checks.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to'],
        properties: { from: { type: 'string' }, to: { type: 'string' } },
      },
    },
    unsupported: {
      type: 'array',
      items: { type: 'string' },
      description: 'Requested features outside this static routed VLAN lab, or an empty array.',
    },
  },
};

function checkObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} has an unexpected field: ${key}.`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing ${key}.`);
  }
}

function text(value, label, maxLength) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > maxLength || /[\x00-\x1f\x7f]/.test(result)) {
    throw new Error(`${label} must be 1–${maxLength} characters on a single line.`);
  }
  return result;
}

function deviceName(value, label) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(result)) {
    throw new Error(`${label} must be 1–63 letters, digits, underscores or hyphens and start with a letter or digit.`);
  }
  return result;
}

function registerDevice(value, names, label) {
  const name = deviceName(value, label);
  const key = name.toLowerCase();
  if (names.has(key)) throw new Error(`Duplicate device name: ${name}.`);
  names.add(key);
  return name;
}

// Subnets reach this helper only after the flat IPv4 validator has accepted them.
function ipv4Number(address) {
  return address.split('.').reduce((number, octet) => number * 256 + Number(octet), 0);
}

function addSubnet(subnet, label, ranges) {
  const [network, prefix] = subnet.split('/');
  const start = ipv4Number(network);
  const end = start + 2 ** (32 - Number(prefix)) - 1;
  const overlap = ranges.find((range) => start <= range.end && end >= range.start);
  if (overlap) throw new Error(`${label} subnet ${subnet} overlaps ${overlap.label} subnet ${overlap.subnet}.`);
  ranges.push({ start, end, subnet, label });
  return network;
}

function privateWan(network) {
  const address = ipv4Number(network);
  return (address >= 0x0a000000 && address <= 0x0afffffc) ||
    (address >= 0xac100000 && address <= 0xac1ffffc) ||
    (address >= 0xc0a80000 && address <= 0xc0a8fffc);
}

function normalizeVlan(vlan, site, context, offset) {
  const label = `${site.name} VLAN`;
  checkObject(vlan, ['id', 'name', 'subnet', 'gateway', 'pcs'], label);
  if (!Number.isInteger(vlan.id) || vlan.id < 1 || vlan.id > 4094 || (vlan.id >= 1002 && vlan.id <= 1005)) {
    throw new Error(`${label} ID must be 1–4094 and exclude reserved IDs 1002–1005.`);
  }
  const name = typeof vlan.name === 'string' ? vlan.name.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error(`${label} name must be 1–32 letters, digits, underscores or hyphens.`);
  if (!Array.isArray(vlan.pcs) || vlan.pcs.length + offset > maxPcs) {
    throw new Error(`${site.name} supports up to ${maxPcs} PCs across its VLANs.`);
  }
  const pcs = Array.from(vlan.pcs, (pc, index) => {
    checkObject(pc, ['name', 'ipv4'], `${label} ${vlan.id} PC ${index + 1}`);
    const name = registerDevice(pc.name, context.deviceNames, 'PC name');
    context.pcNames.set(name.toLowerCase(), name);
    return { name, ipv4: pc.ipv4 };
  });

  let gatewayName = 'LAN_GATEWAY';
  let gatewayIndex = 0;
  while (context.deviceNames.has(gatewayName.toLowerCase())) gatewayName = `LAN_GATEWAY_${++gatewayIndex}`;
  const lan = normalizeTopology({
    name: context.name,
    switchName: site.switchName,
    subnet: vlan.subnet,
    pcs: [{ name: gatewayName, ipv4: vlan.gateway }, ...pcs],
    pings: [],
    unsupported: [],
  });
  const network = addSubnet(lan.subnet, `${label} ${vlan.id}`, context.ranges);
  return {
    id: vlan.id,
    name,
    subnet: lan.subnet,
    network,
    mask: lan.mask,
    gateway: lan.pcs[0].ipv4,
    pcs: lan.pcs.slice(1).map((pc, index) => ({
      name: pc.name,
      ipv4: pc.ipv4,
      switchPort: `FastEthernet0/${offset + index + 1}`,
    })),
  };
}

function normalizeSites(input, context) {
  if (!Array.isArray(input) || input.length < 1 || input.length > maxSites) {
    throw new Error(`A routed lab must contain 1–${maxSites} sites.`);
  }
  return Array.from(input, (site, index) => {
    checkObject(site, ['name', 'routerName', 'switchName', 'vlans'], `Site ${index + 1}`);
    const name = text(site.name, 'Site name', 63);
    if (context.siteNames.has(name.toLowerCase())) throw new Error(`Duplicate site name: ${name}.`);
    context.siteNames.set(name.toLowerCase(), name);
    const routerName = registerDevice(site.routerName, context.deviceNames, 'Router name');
    const switchName = registerDevice(site.switchName, context.deviceNames, 'Switch name');
    if (!Array.isArray(site.vlans) || site.vlans.length < 1 || site.vlans.length > maxVlans) {
      throw new Error(`${name} must contain 1–${maxVlans} VLANs.`);
    }
    const normalized = { name, routerName, switchName, vlans: [], routes: [] };
    const vlanIds = new Set();
    let pcCount = 0;
    for (const vlan of site.vlans) {
      const resolved = normalizeVlan(vlan, normalized, context, pcCount);
      if (vlanIds.has(resolved.id)) throw new Error(`Duplicate VLAN ID ${resolved.id} in ${name}.`);
      vlanIds.add(resolved.id);
      pcCount += resolved.pcs.length;
      normalized.vlans.push(resolved);
    }
    if (pcCount === 0) throw new Error(`${name} must contain at least one PC.`);
    return normalized;
  });
}

function normalizeWanLinks(input, sites, context) {
  if (!Array.isArray(input) || input.length !== sites.length - 1) {
    throw new Error('WAN links must form a connected acyclic tree with exactly one fewer link than sites.');
  }
  const degrees = new Map(sites.map((site) => [site.name, 0]));
  const edges = new Set();
  return Array.from(input, (link, index) => {
    const label = `WAN link ${index + 1}`;
    checkObject(link, ['from', 'to', 'subnet', 'fromIpv4', 'toIpv4'], label);
    const from = context.siteNames.get(text(link.from, `${label} source`, 63).toLowerCase());
    const to = context.siteNames.get(text(link.to, `${label} destination`, 63).toLowerCase());
    if (!from || !to || from === to) throw new Error(`${label} must connect two distinct sites in the lab.`);
    const edge = JSON.stringify([from, to].sort());
    if (edges.has(edge)) throw new Error(`${label} repeats the connection between ${from} and ${to}.`);
    edges.add(edge);
    const fromDegree = degrees.get(from) + 1;
    const toDegree = degrees.get(to) + 1;
    if (fromDegree > 2 || toDegree > 2) throw new Error('Each router supports at most two WAN uplinks.');
    degrees.set(from, fromDegree);
    degrees.set(to, toDegree);
    const wan = normalizeTopology({
      name: context.name,
      switchName: 'WAN_SWITCH',
      subnet: link.subnet,
      pcs: [{ name: 'WAN_FROM', ipv4: link.fromIpv4 }, { name: 'WAN_TO', ipv4: link.toIpv4 }],
      pings: [],
      unsupported: [],
    });
    const network = wan.subnet.split('/')[0];
    if (!wan.subnet.endsWith('/30') || !privateWan(network)) {
      throw new Error(`${label} needs a private RFC1918 /30 IPv4 subnet.`);
    }
    addSubnet(wan.subnet, label, context.ranges);
    return {
      from, to, subnet: wan.subnet, network, mask: wan.mask,
      fromIpv4: wan.pcs[0].ipv4, toIpv4: wan.pcs[1].ipv4,
      fromPort: `GigabitEthernet0/${fromDegree}`, toPort: `GigabitEthernet0/${toDegree}`,
    };
  });
}

function assignRoutes(sites, wanLinks) {
  const neighbors = new Map(sites.map((site) => [site.name, []]));
  for (const link of wanLinks) {
    neighbors.get(link.from).push({ name: link.to, nextHop: link.toIpv4 });
    neighbors.get(link.to).push({ name: link.from, nextHop: link.fromIpv4 });
  }
  for (const site of sites) {
    const nextHops = new Map([[site.name, null]]);
    const queue = [site.name];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      for (const neighbor of neighbors.get(current)) {
        if (nextHops.has(neighbor.name)) continue;
        nextHops.set(neighbor.name, current === site.name ? neighbor.nextHop : nextHops.get(current));
        queue.push(neighbor.name);
      }
    }
    if (nextHops.size !== sites.length) throw new Error('WAN links must form a connected acyclic tree between all sites.');
    site.routes = sites.filter((remote) => remote.name !== site.name).flatMap((remote) =>
      remote.vlans.map((vlan) => ({ network: vlan.network, mask: vlan.mask, nextHop: nextHops.get(remote.name) })));
  }
}

function normalizePings(input, pcNames) {
  if (input === null) return [];
  if (!Array.isArray(input) || input.length > maxPings) throw new Error(`Use an array of up to ${maxPings} ping checks, or null.`);
  const checks = new Set();
  return Array.from(input, (ping, index) => {
    const label = `Ping ${index + 1}`;
    checkObject(ping, ['from', 'to'], label);
    const from = pcNames.get(deviceName(ping.from, `${label} source`).toLowerCase());
    const to = pcNames.get(deviceName(ping.to, `${label} destination`).toLowerCase());
    if (!from || !to || from === to) throw new Error(`${label} must name two distinct PCs in the lab.`);
    const key = `${from}:${to}`;
    if (checks.has(key)) throw new Error(`${label} repeats the ping from ${from} to ${to}.`);
    checks.add(key);
    return { from, to };
  });
}

export function normalizeRoutedTopology(input) {
  checkObject(input, routedTopologySchema.required, 'Routed topology');
  if (input.kind !== 'routed') throw new Error('Routed topology kind must be routed.');
  if (!Array.isArray(input.unsupported) || Array.from(input.unsupported).some((feature) => typeof feature !== 'string' || !feature.trim())) {
    throw new Error('Unsupported features must be an array of nonempty strings.');
  }
  if (input.unsupported.length) throw new Error(`Unsupported features: ${input.unsupported.join(', ')}.`);
  const context = {
    name: text(input.name, 'Lab title', 100),
    siteNames: new Map(), deviceNames: new Set(), pcNames: new Map(), ranges: [],
  };
  const sites = normalizeSites(input.sites, context);
  const wanLinks = normalizeWanLinks(input.wanLinks, sites, context);
  assignRoutes(sites, wanLinks);
  return { schemaVersion: 2, name: context.name, sites, wanLinks, pings: normalizePings(input.pings, context.pcNames) };
}
