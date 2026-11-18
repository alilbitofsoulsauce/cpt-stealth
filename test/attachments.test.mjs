import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseBuildRequest, withAttachments } from '../lib/attachments.mjs';
import { makePlannerContent } from '../lib/subscription.mjs';

test('accepts reference-only requests and requires a prompt or attachment', () => {
  assert.deepEqual(parseBuildRequest('{"prompt":"  ","attachments":["example.pdf"]}'),
    { prompt: '', paths: ['example.pdf'] });
  assert.throws(() => parseBuildRequest('{"prompt":"","attachments":[]}'), /prompt or attach/);
  assert.throws(() => parseBuildRequest('{"prompt":12,"attachments":[]}'), /prompt text/);
});

test('takes private copies and builds the direct ChatGPT input for both media types', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cpt-test-attachments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pdf = join(directory, 'Lab notes.PDF');
  const image = join(directory, 'Network.png');
  const pdfBytes = Buffer.from('%PDF-1.7\n');
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await Promise.all([writeFile(pdf, pdfBytes), writeFile(image, imageBytes)]);

  const stagedPaths = await withAttachments([pdf, image], async files => {
    assert.notEqual(files[0].path, pdf);
    assert.deepEqual(await readFile(files[0].path), pdfBytes);
    assert.deepEqual(await makePlannerContent('Use these references', files), [
      { type: 'input_text', text: 'Use these references' },
      { type: 'input_file', filename: 'Lab notes.PDF', file_data: `data:application/pdf;base64,${pdfBytes.toString('base64')}` },
      { type: 'input_image', image_url: `data:image/png;base64,${imageBytes.toString('base64')}`, detail: 'high' },
    ]);
    return files.map(file => file.path);
  });
  for (const staged of stagedPaths) await assert.rejects(() => access(staged), { code: 'ENOENT' });
  assert.equal(await makePlannerContent('Text only', []), 'Text only');
});

test('rejects unsupported, mislabeled, or over-limit attachments before planning', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cpt-test-attachments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mislabeled = join(directory, 'bad.png');
  const large = join(directory, 'large.jpg');
  await writeFile(mislabeled, '%PDF-1.7\n');
  await writeFile(large, Buffer.alloc((20 * 1024 * 1024) + 1));
  const unexpected = () => assert.fail('Attachments should be rejected before planning');
  await assert.rejects(() => withAttachments([join(directory, 'lab.txt')], unexpected), /Unsupported file/);
  await assert.rejects(() => withAttachments([mislabeled], unexpected), /contents do not match/);
  await assert.rejects(() => withAttachments([large], unexpected), /total up to 20 MB/);
  await assert.rejects(() => withAttachments(Array(9).fill(mislabeled), unexpected), /at most 8/);
});
