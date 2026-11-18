const maxPcs = 24;
const maxPings = 24;
const octetSize = 256;
const firstOctetSize = octetSize ** 3;
const loopbackStart = 127 * firstOctetSize;
const loopbackEnd = 128 * firstOctetSize;
const multicastStart = 224 * firstOctetSize;

export const topologySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'switchName', 'subnet', 'pcs', 'pings', 'unsupported'],
  properties: {
    name: { type: 'string', description: 'A short title for the Packet Tracer lab.' },
    switchName: { type: 'string', description: 'The Ethernet switch name.' },
    subnet: { type: 'string', description: 'Canonical IPv4 network address in CIDR notation.' },
    pcs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'ipv4'],
        properties: {
          name: { type: 'string' },
          ipv4: { type: ['string', 'null'], description: 'Full IPv4 address, or null for local allocation.' },
        },
      },
    },
    pings: {
      type: ['array', 'null'],
      description: `Up to ${maxPings} distinct directed ping checks between PCs, or null for no checks.`,
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
      description: 'Requested features outside the supported single-switch IPv4 lab, or an empty array.',
    },
  },
};

function checkObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} has an unexpected field: ${key}.`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing ${key}.`);
  }
}

function parseName(value, label) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(name)) {
    throw new Error(`${label} must be 1–63 letters, digits, underscores or hyphens and start with a letter or digit.`);
  }
  return name;
}

function parseIPv4(value, label) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) {
    throw new Error(`${label} must be a full IPv4 address in dotted-decimal notation.`);
  }
  let address = 0;
  for (const octet of value.split('.').map(Number)) {
    if (octet >= octetSize) throw new Error(`${label} has an IPv4 octet above 255.`);
    address = address * octetSize + octet;
  }
  return address;
}

function formatIPv4(address) {
  return [3, 2, 1, 0].map((position) => Math.floor(address / octetSize ** position) % octetSize).join('.');
}

function parseSubnet(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+\.\d+\/(?:[1-9]|[12]\d|30)$/.test(value)) {
    throw new Error('Subnet must be in IPv4 CIDR notation with a prefix from /1 through /30.');
  }
  const [base, prefix] = value.split('/');
  const network = parseIPv4(base, 'Subnet');
  const blockSize = 2 ** (32 - Number(prefix));
  if (network % blockSize !== 0) throw new Error('Subnet must use the network address with host bits set to zero.');
  return { network, broadcast: network + blockSize - 1, mask: formatIPv4(2 ** 32 - blockSize) };
}

function skipNonUnicast(address) {
  if (address < firstOctetSize) return firstOctetSize;
  if (address >= loopbackStart && address < loopbackEnd) return loopbackEnd;
  return address;
}

function normalizePings(input, pcNames) {
  if (input === null) return [];
  if (!Array.isArray(input)) throw new Error('Pings must be an array or null.');
  if (input.length > maxPings) throw new Error(`The lab supports up to ${maxPings} ping checks.`);
  const seen = new Set();
  return Array.from(input, (ping, index) => {
    const label = `Ping ${index + 1}`;
    checkObject(ping, ['from', 'to'], label);
    const from = pcNames.get(parseName(ping.from, `${label} source`).toLowerCase());
    const to = pcNames.get(parseName(ping.to, `${label} destination`).toLowerCase());
    if (!from || !to) throw new Error(`${label} must refer to two PCs in the lab.`);
    if (from === to) throw new Error(`${label} must use two different PCs.`);
    const key = `${from}:${to}`;
    if (seen.has(key)) throw new Error(`${label} repeats the ping from ${from} to ${to}.`);
    seen.add(key);
    return { from, to };
  });
}

export function normalizeTopology(input) {
  checkObject(input, topologySchema.required, 'Topology');
  if (!Array.isArray(input.unsupported) || Array.from(input.unsupported).some((feature) => typeof feature !== 'string' || !feature.trim())) {
    throw new Error('Unsupported features must be an array of nonempty strings.');
  }
  if (input.unsupported.length > 0) throw new Error(`Unsupported features: ${input.unsupported.join(', ')}.`);

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error('Lab title must be 1–100 characters on a single line.');
  }
  const switchName = parseName(input.switchName, 'Switch name');
  const subnet = typeof input.subnet === 'string' ? input.subnet.trim() : input.subnet;
  const { network, broadcast, mask } = parseSubnet(subnet);
  if (!Array.isArray(input.pcs) || input.pcs.length < 1 || input.pcs.length > maxPcs) {
    throw new Error(`The lab must contain 1–${maxPcs} PCs.`);
  }

  const pcNames = new Map();
  const addresses = new Set();
  const plannedPcs = Array.from(input.pcs, (pc, index) => {
    const label = `PC ${index + 1}`;
    checkObject(pc, ['name', 'ipv4'], label);
    const name = parseName(pc.name, `${label} name`);
    const key = name.toLowerCase();
    if (key === switchName.toLowerCase() || pcNames.has(key)) throw new Error(`Duplicate device name: ${name}.`);
    pcNames.set(key, name);

    let address = null;
    if (pc.ipv4 !== null) {
      address = parseIPv4(pc.ipv4, `${name} IPv4`);
      if (address <= network || address >= broadcast || skipNonUnicast(address) !== address || address >= multicastStart) {
        throw new Error(`${name} IPv4 address ${pc.ipv4} is not a usable host address in ${subnet}.`);
      }
      if (addresses.has(address)) throw new Error(`Duplicate IPv4 address: ${pc.ipv4}.`);
      addresses.add(address);
    }
    return { name, address, switchPort: `FastEthernet0/${index + 1}` };
  });

  let nextAddress = skipNonUnicast(network + 1);
  const pcs = plannedPcs.map(({ name, address, switchPort }) => {
    if (address === null) {
      while (addresses.has(nextAddress)) nextAddress = skipNonUnicast(nextAddress + 1);
      if (nextAddress >= broadcast || nextAddress >= multicastStart) {
        throw new Error(`Subnet ${subnet} has too few usable host addresses for ${plannedPcs.length} PCs.`);
      }
      address = nextAddress;
      nextAddress = skipNonUnicast(nextAddress + 1);
    }
    return { name, ipv4: formatIPv4(address), switchPort };
  });

  return { schemaVersion: 1, name, switchName, subnet, mask, pcs, pings: normalizePings(input.pings, pcNames) };
}
