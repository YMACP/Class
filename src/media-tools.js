import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getResolvedPDFJS } from 'unpdf';
import { activeTimeout, boundedJson, utf8Prefix } from './tool-output.js';

const IMAGE_LIMIT = 5 * 1024 * 1024;
const PDF_LIMIT = 20 * 1024 * 1024;
const define = (name, description, properties, required) => ({ name, description, parameters: { type: 'object', properties, required, additionalProperties: false } });
export const mediaToolDefinitions = [
  define('read_image', 'Read a workspace PNG/JPEG/GIF/WebP as actual model image input (requires a vision-capable model). Maximum 5 MiB. Do not infer image content from the filename.', { path: { type: 'string', minLength: 1 } }, ['path']),
  define('read_pdf', 'Extract text from selected PDF pages (maximum 20 MiB). Scanned pages may have no text: use include_document only with a PDF-capable model to inspect scans and diagrams. No local OCR is claimed. Page numbers are 1-based.', {
    path: { type: 'string', minLength: 1 }, start_page: { type: 'integer', minimum: 1 }, max_pages: { type: 'integer', minimum: 1, maximum: 20 },
    include_document: { type: 'boolean', description: 'Also attach the original complete PDF to the model; page selection limits text extraction only. Requires model/provider PDF support.' },
  }, ['path']),
];

function mimeForImage(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) return 'image/gif';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw Error('Unsupported image content; expected PNG, JPEG, GIF or WebP');
}

async function boundedFile(manager, filePath, maxBytes, signal) {
  const filename = await manager._path(filePath);
  await manager.checkpoint(signal);
  const file = await fs.open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw Error('Media input must be a regular file');
    if (stat.size > maxBytes) throw Error(`Media input exceeds ${maxBytes / 1048576} MiB`);
    const chunks = []; let size = 0;
    while (true) {
      await manager.checkpoint(signal);
      const buffer = Buffer.alloc(Math.min(65536, maxBytes + 1 - size));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead; if (size > maxBytes) throw Error('Media input grew beyond the size limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return { filename, data: Buffer.concat(chunks) };
  } finally { await file.close(); }
}

export async function executeMediaTool(manager, studentId, name, args, signal) {
  const { filename, data } = await boundedFile(manager, args.path, name === 'read_image' ? IMAGE_LIMIT : PDF_LIMIT, signal);
  const relativePath = path.relative(manager.cwd, filename);
  const digest = createHash('sha256').update(data).digest('hex');
  if (name === 'read_image') {
    const mimeType = mimeForImage(data);
    return { name, ...boundedJson({ path: relativePath, mimeType, bytes: data.length, sha256: digest, requiresVision: true }, manager.maxOutputBytes),
      media: [{ type: 'image', mimeType, data: data.toString('base64'), path: relativePath, sha256: digest }] };
  }
  if (name !== 'read_pdf') throw Error('Unknown media tool');
  if (!data.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw Error('Input is not a PDF document');
  const start = args.start_page ?? 1, count = args.max_pages ?? 10;
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 20) throw Error('Invalid PDF page range');
  const { getDocument } = await getResolvedPDFJS();
  await manager.checkpoint(signal);
  const loading = getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: true, disableFontFace: true, verbosity: 0 });
  const deadline = new AbortController();
  signal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const abort = () => { void loading.destroy().catch(() => {}); };
  const cancelTimer = activeTimeout(manager, manager.mediaOptions?.timeoutMs ?? 30000, () => deadline.abort(new Error('PDF reading timed out')));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const pdf = await loading.promise;
    if (start > pdf.numPages) throw Error(`start_page exceeds PDF page count (${pdf.numPages})`);
    const pages = []; let used = 0, truncated = false;
    const budget = Math.max(512, Math.floor(manager.maxOutputBytes * 0.7));
    for (let number = start; number <= Math.min(pdf.numPages, start + count - 1); number++) {
      await manager.checkpoint(signal);
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      const bytes = Buffer.from(text), left = Math.max(0, budget - used);
      pages.push({ page: number, text: utf8Prefix(text, left), ...(bytes.length > left ? { truncated: true } : {}) });
      used += Math.min(bytes.length, left); page.cleanup();
      if (bytes.length > left || used >= budget) { truncated = true; break; }
    }
    const last = pages.at(-1)?.page ?? start;
    const output = { path: relativePath, sha256: digest, totalPages: pdf.numPages, pages, nextPage: truncated ? last : last < pdf.numPages ? last + 1 : null, truncated,
      ...(truncated ? { hint: 'Page text reached the output budget; requesting this page alone may help. Use include_document with a PDF-capable model for full visual inspection.' } : {}),
      ...(!pages.some(page => page.text.trim()) ? { warning: 'No extractable text on selected pages. This may be a scanned PDF; no local OCR was performed. Use include_document with a PDF-capable model.' } : {}),
      ...(args.include_document ? { attachedDocument: 'Complete original PDF, including pages outside the selected text range.' } : {}) };
    const bounded = boundedJson(output, manager.maxOutputBytes);
    return { name, ...bounded, truncated: truncated || bounded.truncated, ...(args.include_document ? { media: [{ type: 'document', mimeType: 'application/pdf', data: data.toString('base64'), filename: path.basename(filename), path: relativePath, sha256: digest }] } : {}) };
  } catch (error) { if (signal.aborted) throw signal.reason; throw error; }
  finally { cancelTimer(); signal?.removeEventListener('abort', abort); await loading.destroy(); }
}

// Media bytes remain model inputs, not JSON prose in logs, context notes, or review snapshots.
export function summarizeToolResult(value) {
  if (!value || !Array.isArray(value.media)) return value;
  return { ...value, media: value.media.map(({ data, ...item }) => ({ ...item, bytes: Buffer.from(data ?? '', 'base64').length })) };
}

export async function retainToolMedia(manager, result, signal) {
  if (!Array.isArray(result?.media)) return result;
  for (const item of result.media) {
    if (item.path) continue;
    await manager.checkpoint(signal);
    const data = Buffer.from(item.data ?? '', 'base64');
    if (!data.length || data.length > IMAGE_LIMIT || item.type !== 'image') throw Error('Invalid or oversized browser image');
    const mimeType = mimeForImage(data);
    const root = await fs.realpath(manager.cwd);
    let directory = root;
    for (const segment of ['.class-artifacts', manager.mediaId]) {
      directory = path.join(directory, segment);
      await fs.mkdir(directory, { recursive: false }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(directory) !== directory) throw Error('Unsafe media artifact directory');
    }
    const filename = path.join(directory, `${randomUUID()}.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1]}`);
    await manager.checkpoint(signal);
    await fs.writeFile(filename, data, { flag: 'wx', mode: 0o600 });
    item.path = path.relative(manager.cwd, filename);
    item.mimeType = mimeType; item.sha256 = createHash('sha256').update(data).digest('hex');
  }
  result.outputDigest = createHash('sha256').update(JSON.stringify(result.media.map(item => [item.type, item.mimeType, item.sha256]))).digest('hex');
  return result;
}

export function modelMediaParts(media, protocol) {
  return (media ?? []).map(item => {
    const url = `data:${item.mimeType};base64,${item.data}`;
    if (protocol === 'messages') return { type: item.type === 'image' ? 'image' : 'document', source: { type: 'base64', media_type: item.mimeType, data: item.data } };
    if (protocol === 'responses') return item.type === 'image' ? { type: 'input_image', image_url: url, detail: 'auto' } : { type: 'input_file', filename: item.filename ?? 'document.pdf', file_data: url };
    return item.type === 'image' ? { type: 'image_url', image_url: { url, detail: 'auto' } } : { type: 'file', file: { filename: item.filename ?? 'document.pdf', file_data: url } };
  });
}
