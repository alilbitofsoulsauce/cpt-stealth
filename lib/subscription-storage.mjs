import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

function dataDirectory() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) {
    throw new Error('ChatGPT sign-in needs a Windows user profile.');
  }
  return join(process.env.LOCALAPPDATA, 'PacketTracerHelper');
}

function startPowerShell(script, extraEnv = {}) {
  const powerShell = join(process.env.SystemRoot || 'C:\\Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  child.stdin.on('error', () => {});
  return child;
}

function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    const child = startPowerShell(script);
    let output = '';
    child.stdout.setEncoding('ascii');
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error('Windows command failed.')));
    child.stdin.end(input);
  });
}

const dpapi = operation => `
  $ErrorActionPreference = 'Stop'
  Add-Type -AssemblyName System.Security
  $data = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  $result = [System.Security.Cryptography.ProtectedData]::${operation}($data, $null, $scope)
  [Console]::Write([Convert]::ToBase64String($result))
`;

export async function openBrowser(url) {
  try {
    await runPowerShell(`
      $ErrorActionPreference = 'Stop'
      Start-Process -FilePath ([Console]::In.ReadToEnd())
    `, url.toString());
  } catch {
    throw new Error('Windows could not open the default browser for ChatGPT sign-in.');
  }
}

export async function readAuthState() {
  const path = join(dataDirectory(), 'chatgpt.dpapi');
  let encrypted;
  try {
    encrypted = await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return { profiles: [], activeClientId: null, hostId: null };
    throw new Error('The local ChatGPT profile could not be read.');
  }
  try {
    const decrypted = await runPowerShell(dpapi('Unprotect'), encrypted.toString('base64'));
    return JSON.parse(Buffer.from(decrypted, 'base64').toString('utf8'));
  } catch {
    throw new Error('Windows could not decrypt the ChatGPT profile for this user.');
  }
}

export async function saveAuthState(state) {
  const directory = dataDirectory();
  const path = join(directory, 'chatgpt.dpapi');
  const temp = join(directory, `chatgpt-${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    const data = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
    const encrypted = await runPowerShell(dpapi('Protect'), data);
    await writeFile(temp, Buffer.from(encrypted, 'base64'), { flag: 'wx' });
    await rename(temp, path);
  } catch {
    await rm(temp, { force: true }).catch(() => {});
    throw new Error('Windows could not save the encrypted ChatGPT profile.');
  }
}

// Windows releases the exclusive file handle when either process exits.
export async function withAuthLock(operation) {
  const directory = dataDirectory();
  await mkdir(directory, { recursive: true });
  const child = startPowerShell(`
    $ErrorActionPreference = 'Stop'
    $file = [IO.File]::Open($env:CPT_SUBSCRIPTION_LOCK, 'OpenOrCreate', 'ReadWrite', 'None')
    try {
      [Console]::WriteLine('locked')
      [Console]::Out.Flush()
      [void][Console]::In.ReadToEnd()
    } finally { $file.Dispose() }
  `, { CPT_SUBSCRIPTION_LOCK: join(directory, 'chatgpt.lock') });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.setEncoding('ascii');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.trim() === 'locked') resolve();
      });
      child.on('error', reject);
      child.on('close', () => reject(new Error('The ChatGPT profile is busy. Try again shortly.')));
    });
    return await operation();
  } finally {
    const closed = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise(resolve => child.once('close', resolve));
    child.stdin.end();
    await closed;
  }
}
