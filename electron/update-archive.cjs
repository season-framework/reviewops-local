'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const MAX_EXPANDED = 2 * 1024 ** 3;
function normalizeName(value) { return value.normalize('NFC').toLowerCase(); }
function validateExtra(bytes) {
  for (let cursor = 0; cursor < bytes.length;) {
    if (cursor + 4 > bytes.length) invalid();
    const id = bytes.readUInt16LE(cursor), length = bytes.readUInt16LE(cursor + 2);
    // Only timestamp and UID/GID metadata. Unicode-path overrides, ZIP64,
    // hardlink records and unknown extraction extensions are not accepted.
    if (![0x5455, 0x5855, 0x7855, 0x7875].includes(id) || cursor + 4 + length > bytes.length) invalid();
    cursor += 4 + length;
  }
}
function invalid() { throw new Error('The update archive is invalid. Download the update again.'); }
// Inspect both ZIP indexes and local headers before ditto sees any pathname.
// Framework symlinks are allowed only inside the single app bundle.
async function validateArchive(filename) {
  const file = await fs.open(filename, 'r');
  try {
    const { size } = await file.stat();
    if (size < 22 || size > 512 * 1024 ** 2) invalid();
    const read = async (offset, length) => { if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > size) invalid(); const data = Buffer.alloc(length); if ((await file.read(data, 0, length, offset)).bytesRead !== length) invalid(); return data; };
    const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0) invalid();
    const eocd = tail.subarray(end), count = eocd.readUInt16LE(10), dirSize = eocd.readUInt32LE(12), dirOffset = eocd.readUInt32LE(16);
    if (eocd.readUInt16LE(4) || eocd.readUInt16LE(6) || count !== eocd.readUInt16LE(8) || !count || count > 10000 || dirSize > 32 * 1024 ** 2 || dirOffset + dirSize !== size - tail.length + end) invalid();
    const directory = await read(dirOffset, dirSize), names = new Set(), symlinks = new Map(), entries = [];
    let cursor = 0, expanded = 0;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) invalid();
      const checksum = directory.readUInt32LE(cursor + 16), flags = directory.readUInt16LE(cursor + 8), method = directory.readUInt16LE(cursor + 10), compressed = directory.readUInt32LE(cursor + 20), length = directory.readUInt32LE(cursor + 24), nameSize = directory.readUInt16LE(cursor + 28), extraSize = directory.readUInt16LE(cursor + 30), commentSize = directory.readUInt16LE(cursor + 32), offset = directory.readUInt32LE(cursor + 42), mode = directory.readUInt32LE(cursor + 38) >>> 16;
      if ((flags & 1) || ![0, 8].includes(method) || cursor + 46 + nameSize + extraSize + commentSize > directory.length || directory.readUInt16LE(cursor + 34)) invalid();
      const rawName = directory.subarray(cursor + 46, cursor + 46 + nameSize), name = rawName.toString('utf8');
      const parts = name.replace(/\/$/, '').split('/');
      if (name.length > 2048 || !Buffer.from(name).equals(rawName) || parts[0] !== 'ReviewOps.app' || parts.some(part => !part || part === '.' || part === '..') || /[:\\\x00-\x1f\x7f]/.test(name) || names.has(normalizeName(name))) invalid();
      names.add(normalizeName(name));
      validateExtra(directory.subarray(cursor + 46 + nameSize, cursor + 46 + nameSize + extraSize)); expanded += length;
      if (expanded > MAX_EXPANDED || compressed > size || length > MAX_EXPANDED || offset + 30 >= dirOffset) invalid();
      const local = await read(offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method || local.readUInt16LE(26) !== nameSize) invalid();
      const localExtraSize = local.readUInt16LE(28);
      validateExtra(await read(offset + 30 + nameSize, localExtraSize));
      if (!(flags & 8) && (local.readUInt32LE(14) !== checksum || local.readUInt32LE(18) !== compressed || local.readUInt32LE(22) !== length)) invalid();
      if ((flags & 8) && ((local.readUInt32LE(14) && local.readUInt32LE(14) !== checksum) || (local.readUInt32LE(18) && local.readUInt32LE(18) !== compressed) || (local.readUInt32LE(22) && local.readUInt32LE(22) !== length))) invalid();
      const start = offset + 30 + nameSize + localExtraSize;
      let entryEnd = start + compressed;
      if (flags & 8) {
        const descriptor = await read(entryEnd, 16), skip = descriptor.readUInt32LE(0) === 0x08074b50 ? 4 : 0;
        if (descriptor.readUInt32LE(skip) !== checksum || descriptor.readUInt32LE(skip + 4) !== compressed || descriptor.readUInt32LE(skip + 8) !== length) invalid();
        entryEnd += 12 + skip;
      }
      if (entryEnd > dirOffset || !(await read(offset + 30, nameSize)).equals(rawName)) invalid();
      const kind = mode & 0xf000;
      if (kind && ![0x8000, 0x4000, 0xa000].includes(kind)) invalid();
      if (kind === 0xa000) {
        if (length > 2048 || compressed > 8192) invalid();
        const data = await read(start, compressed), value = method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 2048 }) : data;
        const target = value.toString('utf8');
        if (value.length !== length || !target || !Buffer.from(target).equals(value) || target.startsWith('/') || /[\\\x00-\x1f]/.test(target)) invalid();
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
        if (!resolved.startsWith('ReviewOps.app/')) invalid();
        if (symlinks.size >= 2000) invalid();
        symlinks.set(normalizeName(name), normalizeName(resolved));
      }
      entries.push({ name, offset, end: entryEnd });
      cursor += 46 + nameSize + extraSize + commentSize;
    }
    if (cursor !== directory.length || !entries.some(entry => entry.name === 'ReviewOps.app/Contents/Info.plist') || !entries.some(entry => entry.name === 'ReviewOps.app/Contents/MacOS/ReviewOps')) invalid();
    // Extraction must never walk through a link, even one that initially points inside.
    for (const entry of entries) { const parts = entry.name.split('/'); for (let n = 1; n < parts.length; n++) if (symlinks.has(normalizeName(parts.slice(0, n).join('/')))) invalid(); }
    const ordered = [...entries].sort((a,b) => a.offset - b.offset);
    for (let n = 1; n < ordered.length; n++) if (ordered[n].offset < ordered[n - 1].end) invalid();
    for (const [link] of symlinks) {
      let value = link; const seen = new Set();
      for (let n = 0; n < 40; n++) {
        const prefix = [...symlinks.keys()].find(name => value === name || value.startsWith(name + '/'));
        if (!prefix) break;
        if (seen.has(value)) invalid(); seen.add(value);
        value = path.posix.normalize(symlinks.get(prefix) + value.slice(prefix.length));
        if (!value.startsWith('reviewops.app/') || n === 39) invalid();
      }
    }
    return { entries: count, expandedBytes: expanded };
  } finally { await file.close(); }
}
module.exports = { validateArchive, MAX_EXPANDED };
