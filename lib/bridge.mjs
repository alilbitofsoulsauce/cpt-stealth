import { randomUUID } from 'node:crypto';
import { access, link, mkdir, stat, unlink, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const heartbeatLifetime = 10_000;
const buildTimeout = 90_000;

export function getPaths() {
  if (!process.env.LOCALAPPDATA) {
    throw new Error('Packet Tracer Helper requires a Windows user profile.');
  }
  const root = resolve(process.env.LOCALAPPDATA, 'PacketTracerHelper');
  return { root, bridge: join(root, 'bridge'), labs: join(root, 'labs') };
}

export async function bridgeStatus() {
  const { bridge } = getPaths();
  await mkdir(bridge, { recursive: true });
  await writeFile(join(bridge, 'connection.json'), '{"version":1}\n', { flag: 'wx' }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  try {
    const heartbeat = await stat(join(bridge, 'ready.json'));
    return { ready: Date.now() - heartbeat.mtimeMs <= heartbeatLifetime };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { ready: false };
  }
}

export async function prepareModule(moduleUrl) {
  await bridgeStatus();
  const modulePath = fileURLToPath(moduleUrl);
  await access(modulePath).catch(() => {
    throw new Error('The Packet Tracer module is missing. Extract the entire release ZIP before opening the helper.');
  });
  return { modulePath, bridgePath: join(getPaths().bridge, 'connection.json') };
}

export async function buildLab(topology) {
  const { bridge, labs } = getPaths();
  if (!(await bridgeStatus()).ready) {
    throw new Error('Start the Packet Tracer Helper module in Packet Tracer, then try again.');
  }
  await mkdir(labs, { recursive: true });
  const id = randomUUID();
  const slug = topology.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 45);
  const outputPath = join(labs, `${slug || 'lab'}-${id}.pkt`);
  const requestPath = join(bridge, 'request.json');
  const pendingPath = join(bridge, `request-${id}.tmp`);
  const resultPath = join(bridge, `result-${id}.json`);

  await writeFile(pendingPath, JSON.stringify({ id, outputPath, topology, startBy: Date.now() + 15_000 }), { flag: 'wx' });
  try {
    // Publish the complete file atomically and let Packet Tracer release the request slot.
    await link(pendingPath, requestPath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('Packet Tracer is still handling a build. Wait for it to finish before starting another.');
    }
    throw error;
  } finally {
    await unlink(pendingPath);
  }

  const result = await waitForResult(resultPath);
  await unlink(resultPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });

  if (result.id !== id || typeof result.ok !== 'boolean') {
    throw new Error('Packet Tracer returned an invalid build result.');
  }
  if (!result.ok) {
    throw new Error(typeof result.error === 'string' ? result.error : 'Packet Tracer could not build the lab.');
  }
  if (typeof result.outputPath !== 'string' || resolve(result.outputPath) !== outputPath) {
    throw new Error('Packet Tracer reported an unexpected output path.');
  }
  const file = await stat(outputPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!file?.isFile() || file.size === 0) {
    throw new Error('Packet Tracer did not produce a readable lab file.');
  }
  const checks = Array.isArray(result.checks) ? result.checks : [];
  if (checks.length !== topology.pings.length || topology.pings.some((ping, index) => {
    const check = checks[index];
    return check?.from !== ping.from || check.to !== ping.to || typeof check.ok !== 'boolean';
  })) {
    throw new Error('Packet Tracer did not confirm all requested connectivity checks.');
  }
  return { outputPath, checks, verified: checks.every((check) => check.ok) };
}

async function waitForResult(resultPath) {
  const deadline = Date.now() + buildTimeout;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(resultPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(300);
  }
  throw new Error('Packet Tracer did not report a result within 90 seconds. Check its workspace and the helper module.');
}
