import { execFile } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const windows = process.platform === 'win32';
const suffix = windows ? '.exe' : '';

async function locatePoppler() {
  const candidates = (process.env.PATH ?? '').split(delimiter).map(entry => entry.trim().replace(/^"|"$/g, ''));
  for (const directory of candidates.filter(isAbsolute)) {
    const tools = await checkDirectory(directory);
    if (tools) return tools;
  }
  if (windows) {
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const query = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Get-AppxPackage -Name 'OpenAI.CodexPrimaryRuntime*' | Sort-Object Version -Descending | ForEach-Object { $_.InstallLocation }`;
    const registration = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', query],
      { windowsHide: true, timeout: 10_000 }).catch(() => null);
    for (const location of (registration?.stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(isAbsolute)) {
      const tools = await checkDirectory(join(location, 'dependencies', 'native', 'poppler', 'Library', 'bin'));
      if (tools) return tools;
    }
  }
  throw new Error('PDF rendering needs pdfinfo and pdftoppm from Poppler. Use the Codex Windows runtime or attach page images.');
}

async function checkDirectory(directory) {
  const tools = { info: join(directory, `pdfinfo${suffix}`), render: join(directory, `pdftoppm${suffix}`) };
  try {
    await Promise.all([access(tools.info), access(tools.render)]);
    return tools;
  } catch {
    return null;
  }
}

export async function renderPdfPages(inputPath, outputPrefix, pageBudget) {
  const tools = await locatePoppler();
  const settings = { windowsHide: true, timeout: 60_000, maxBuffer: 262_144 };
  let info;
  try {
    info = await run(tools.info, [inputPath], settings);
  } catch (error) {
    if (/password|encrypted/i.test(error.stderr ?? '')) throw new Error('This PDF is password-protected. Attach an unlocked copy.');
    throw new Error('This PDF could not be read. Check that it opens normally.');
  }
  const count = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1]);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('This PDF has no readable pages.');
  if (count > pageBudget) throw new Error('The attachments contain more than 20 pages and images. Choose fewer pages or files.');
  try {
    await run(tools.render, ['-png', '-cropbox', '-scale-to', '2000', '-f', '1', '-l', String(count), inputPath, outputPrefix], settings);
  } catch {
    throw new Error('This PDF could not be rendered. Attach a smaller PDF or export its pages as images.');
  }
  const directory = dirname(outputPrefix);
  const name = `${basename(outputPrefix)}-`;
  const pages = (await readdir(directory)).filter(file => file.startsWith(name) && /^\d+\.png$/.test(file.slice(name.length)))
    .sort((first, second) => parseInt(first.slice(name.length), 10) - parseInt(second.slice(name.length), 10));
  const paths = pages.map(file => join(directory, file));
  if (paths.length !== count || (await Promise.all(paths.map(path => stat(path)))).some(file => file.size === 0)) {
    throw new Error('The renderer did not produce every PDF page.');
  }
  return paths;
}
