'use strict';
// Untrusted uploads from equipment owners.
//  * Images: the bytes must really be JPEG, PNG or WebP. Each image is
//    decoded and re-encoded as WebP, so GPS/EXIF data, hidden payloads
//    and odd formats never reach the database or other visitors.
//  * PDFs: must start like a PDF and contain no scripts, launch actions or
//    embedded files; they are only ever served as downloads.
const sharp = require('sharp');

const MAX_UPLOAD = 5 * 1024 * 1024;   // 5 MB per file
const MAX_PIXELS = 40_000_000;        // refuse decompression bombs
const MAX_EDGE = 1600;                // stored size

sharp.cache(false);
sharp.concurrency(1);

function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

class UploadError extends Error {
  constructor(msg) { super(msg); this.statusCode = 400; this.expose = true; }
}

// At most two images are decoded at once, so a burst of uploads can't
// exhaust memory on a small server; the rest wait their turn.
let active = 0;
const waiting = [];
async function slot() {
  if (active < 2) { active++; return; }
  await new Promise((resolve) => waiting.push(resolve));
  active++;
}
function release() {
  active--;
  const next = waiting.shift();
  if (next) next();
}

async function processImage(buf) {
  await slot();
  try {
    return await decodeImage(buf);
  } finally {
    release();
  }
}

async function decodeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new UploadError('Choose a photo to upload.');
  if (buf.length > MAX_UPLOAD) throw new UploadError('Photos must be 5 MB or smaller.');
  if (!sniffImage(buf)) throw new UploadError('Photos must be JPG, PNG or WebP images.');
  let meta;
  try {
    meta = await sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
  } catch {
    throw new UploadError('That file is not a readable image.');
  }
  if (!meta.width || !meta.height || meta.width < 200 || meta.height < 200) {
    throw new UploadError('Photos must be at least 200 × 200 pixels.');
  }
  try {
    const { data, info } = await sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error', animated: false })
      .rotate() // honour camera orientation before the metadata is dropped
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    return { data, mime: 'image/webp', width: info.width, height: info.height, size: data.length };
  } catch {
    throw new UploadError('That image could not be processed. Try another photo.');
  }
}

const PDF_DANGER = [/\/JavaScript/i, /\/JS\b/, /\/Launch/, /\/EmbeddedFile/, /\/RichMedia/, /\/OpenAction/, /\/AA\b/, /\/XFA/];

function processPdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new UploadError('Choose a PDF to upload.');
  if (buf.length > MAX_UPLOAD) throw new UploadError('The document must be 5 MB or smaller.');
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') throw new UploadError('The document must be a PDF.');
  if (!buf.slice(-1024).toString('latin1').includes('%%EOF')) throw new UploadError('That PDF looks damaged. Save it again and retry.');
  const text = buf.toString('latin1');
  if (PDF_DANGER.some((re) => re.test(text))) {
    throw new UploadError('This PDF contains scripts or embedded files, which are not allowed. Export it again as a plain PDF ("Print to PDF" works).');
  }
  return { data: buf, mime: 'application/pdf', size: buf.length };
}

// A filename that is safe to put in a download header.
function safeFilename(name, fallback) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[^A-Za-z0-9._ -]/g, '').trim().slice(0, 80);
  return base && /\.pdf$/i.test(base) ? base : fallback;
}

module.exports = { processImage, processPdf, safeFilename, MAX_UPLOAD, UploadError };
