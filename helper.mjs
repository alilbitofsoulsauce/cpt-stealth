import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parseBuildRequest, withAttachments } from './lib/attachments.mjs';
import { bridgeStatus, buildLab, getPaths, prepareModule } from './lib/bridge.mjs';
import { codexStatus, generateWithCodex } from './lib/codex-planner.mjs';
import { normalizeRoutedTopology, routedTopologySchema } from './lib/routed-topology.mjs';
import { normalizeTopology, topologySchema } from './lib/topology.mjs';

const moduleFile = new URL('./packet-tracer/Packet Tracer Helper.pts', import.meta.url);
const plannerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plan'],
  properties: { plan: { anyOf: [topologySchema, routedTopologySchema] } },
};

function normalizePlan(input) {
  const plan = input && Object.hasOwn(input, 'plan') && Object.keys(input).length === 1 ? input.plan : input;
  return plan?.kind === 'routed' ? normalizeRoutedTopology(plan) : normalizeTopology(plan);
}

const mcpTools = [
  {
    name: 'build_packet_tracer_lab',
    description: 'Build a fresh simulated Cisco Packet Tracer lab with one Ethernet switch and up to 24 PCs on one static IPv4 subnet. Use null IPs for automatic assignment.',
    inputSchema: topologySchema,
  },
  {
    name: 'build_routed_packet_tracer_lab',
    description: 'Build a simulated Packet Tracer lab with one or more sites, static IPv4 VLANs, router-on-a-stick trunks, and static routes over point-to-point Ethernet WAN links. Requires the current Packet Tracer Helper module.',
    inputSchema: routedTopologySchema,
  },
];
const example = {
  name: 'Two PCs and a switch',
  switchName: 'SW1',
  subnet: '192.168.10.0/24',
  pcs: [{ name: 'PC1', ipv4: '192.168.10.10' }, { name: 'PC2', ipv4: '192.168.10.11' }],
  pings: [{ from: 'PC1', to: 'PC2' }],
  unsupported: [],
};

async function run(command, argument) {
  switch (command) {
    case 'prepare':
      return prepareModule(moduleFile);
    case 'validate':
      return { topology: normalizePlan(JSON.parse(await readInput(argument))) };
    case 'build-plan':
      return buildLab(normalizePlan(JSON.parse(await readInput(argument))));
    case 'sample':
      return buildLab(normalizeTopology(example));
    case 'bridge-status':
      return bridgeStatus();
    case 'status': {
      const { getStatus } = await import('./lib/subscription.mjs');
      const accountStatus = getStatus().catch(() => ({ connected: false, authorized: false,
        error: 'The tray could not read its saved ChatGPT sign-in.' }));
      const [bridge, account, codex] = await Promise.all([bridgeStatus(), accountStatus, codexStatus()]);
      return { bridge, account, codex, labsPath: getPaths().labs };
    }
    case 'sign-in': {
      const { connect } = await import('./lib/subscription.mjs');
      return connect();
    }
    case 'sign-out': {
      const { disconnect } = await import('./lib/subscription.mjs');
      return disconnect();
    }
    case 'build':
    case 'build-codex':
    case 'build-request':
    case 'build-codex-request': {
      const input = await readInput(argument);
      const { prompt, paths } = command.endsWith('-request') ? parseBuildRequest(input) : { prompt: input.trim(), paths: [] };
      if ((!prompt && paths.length === 0) || prompt.length > 4_000) {
        throw new Error('Enter a topology request of 1 to 4,000 characters.');
      }
      if (!(await bridgeStatus()).ready) {
        throw new Error('Start the Packet Tracer Helper module in Packet Tracer, then try again.');
      }
      const generate = command.startsWith('build-codex') ? generateWithCodex
        : (await import('./lib/subscription.mjs')).generateTopology;
      const instructions = prompt || 'Build the Packet Tracer topology described by the attached references.';
      const plan = await withAttachments(paths, attachments => generate(instructions, plannerSchema, attachments));
      return buildLab(normalizePlan(plan));
    }
    default:
      throw new Error('Use prepare, validate, build-plan, sample, bridge-status, status, sign-in, sign-out, build, build-codex, build-request, build-codex-request, or mcp.');
  }
}

async function readInput(file) {
  if (file) return readFile(file, 'utf8');
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 65_536) throw new Error('The input exceeds 65,536 characters.');
  }
  return input;
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function handleMcp(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } });
    return;
  }
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request.' } });
    return;
  }
  if (!Object.hasOwn(message, 'id')) return;

  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize': {
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
      const version = message.params?.protocolVersion;
      reply({ protocolVersion: supported.includes(version) ? version : supported.at(-1),
        capabilities: { tools: {} }, serverInfo: { name: 'packet-tracer-helper', version: '0.2.0' } });
      break;
    }
    case 'ping':
      reply({});
      break;
    case 'tools/list':
      reply({ tools: mcpTools });
      break;
    case 'tools/call':
      if (!mcpTools.some(tool => tool.name === message.params?.name)) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown Packet Tracer tool.' } });
        break;
      }
      try {
        const normalize = message.params.name === 'build_routed_packet_tracer_lab' ? normalizeRoutedTopology : normalizeTopology;
        const result = await buildLab(normalize(message.params.arguments));
        reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (error) {
        reply({ isError: true, content: [{ type: 'text', text: error.message }] });
      }
      break;
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found.' } });
  }
}

const [, , command, argument] = process.argv;
if (command === 'mcp') {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => { if (line.trim()) void handleMcp(line); });
} else {
  try {
    send({ ok: true, ...await run(command, argument) });
  } catch (error) {
    send({ ok: false, error: error.message });
    process.exitCode = 1;
  }
}
