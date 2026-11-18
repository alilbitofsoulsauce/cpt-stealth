import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

const maxFiles = 8;
const maxBytes = 20 * 1024 * 1024;
const fileTypes = new Map([
  ['.pdf', 'application/pdf'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
]);

export function parseBuildRequest(input) {
  let request;
  try {
    request = JSON.parse(input);
  } catch {
    throw new Error('The build request must contain valid JSON.');
  }
  if (!request || typeof request.prompt !== 'string' || !Array.isArray(request.attachments)) {
    throw new Error('The build request must contain prompt text and a list of attachments.');
  }
  const prompt = request.prompt.trim();
  if (prompt.length > 4_000) throw new Error('Keep the topology request within 4,000 characters.');
  if (!prompt && request.attachments.length === 0) throw new Error('Enter a prompt or attach a PDF or image.');
  return { prompt, paths: request.attachments };
}

function matchesFileType(bytes, type) {
  switch (type) {
    case 'application/pdf': return bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'));
    case 'image/png': return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/jpeg': return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    case 'image/webp': return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    default: return false;
  }
}

async function readAttachment(path, remaining) {
  const handle = await open(path, 'r');
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.size === 0) throw new Error('Choose a nonempty file.');
    if (file.size > remaining) throw new Error('Attachments may total up to 20 MB.');
    const chunks = [];
    let total = 0;
    for await (const chunk of handle.createReadStream({ end: remaining, autoClose: false })) {
      total += chunk.length;
      if (total > remaining) throw new Error('Attachments may total up to 20 MB.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export async function withAttachments(paths, callback) {
  if (paths.length === 0) return callback([]);
  if (paths.length > maxFiles) throw new Error(`Choose at most ${maxFiles} attachments.`);
  const selected = paths.map(path => {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
      throw new Error('Select attachments as local files.');
    }
    const extension = extname(path).toLowerCase();
    const mediaType = fileTypes.get(extension);
    const name = basename(path);
    if (!mediaType) throw new Error(`Choose a PDF, PNG, JPEG, or WebP file. Unsupported file: ${name}`);
    return { path: resolve(path), extension, mediaType, name };
  });

  const directory = await mkdtemp(join(tmpdir(), 'cpt-attachments-'));
  try {
    const staged = [];
    let remaining = maxBytes;
    for (const input of selected) {
      let bytes;
      try {
        bytes = await readAttachment(input.path, remaining);
        if (!matchesFileType(bytes, input.mediaType)) throw new Error('The contents do not match the file type.');
      } catch (error) {
        const reason = error.code ? 'The file could not be opened. Check that it is available locally.' : error.message;
        throw new Error(`${input.name}: ${reason}`);
      }
      remaining -= bytes.length;
      const path = join(directory, `attachment-${staged.length + 1}${input.extension}`);
      await writeFile(path, bytes, { flag: 'wx' });
      staged.push({ path, name: input.name, mediaType: input.mediaType });
    }
    return await callback(staged);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
