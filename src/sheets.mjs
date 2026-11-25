// Tables for the file viewer, with no dependency: CSV (and TSV) and XLSX. An XLSX file is a zip of XML parts, read
// here with zlib: the workbook's sheets, the shared strings, the dates by their number format, and each sheet's cells.
import { inflateRawSync } from 'node:zlib';

// The largest XML part inflated from a workbook: a bigger one (a zip bomb, or a sheet far beyond a preview) is refused.
const MAX_PART = 64 * 1024 ** 2;
const MAX_COLUMNS = 200;

/** Text from a file's bytes: UTF-8 (with or without BOM), UTF-16 with its BOM, else Windows-1252. */
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

/**
 * Rows of a CSV text, at most maxRows: { rows, total, truncated }. The delimiter is the comma, the semicolon or the tab,
 * whichever the first line has most of (outside quotes), unless given.
 */
export function parseCsv(text, { delimiter = null, maxRows = 5000 } = {}) {
  const src = String(text ?? '').replace(/^﻿/, '');
  if (!delimiter) {
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let quoted = false;
    for (const c of src.slice(0, 20_000)) {
      if (c === '"') quoted = !quoted;
      else if (!quoted && (c === '\n' || c === '\r')) break;
      else if (!quoted && c in counts) counts[c]++;
    }
    const [most, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    delimiter = count ? most : ',';
  }
  const rows = [];
  let total = 0;
  let row = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    field = '';
    total++;
    if (rows.length < maxRows) rows.push(row.slice(0, MAX_COLUMNS));
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else field += c;
  }
  if (field !== '' || row.length) endRow();
  return { rows, total, truncated: total > rows.length };
}

// ---------- XLSX ----------

/** The entries of a zip file, by name: { method, csize, usize, local }. */
export function zipEntries(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip file');
    const nameLength = buf.readUInt16LE(p + 28);
    const entry = { method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), usize: buf.readUInt32LE(p + 24), local: buf.readUInt32LE(p + 42) };
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLength), entry);
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

/** One entry's content: stored or deflated, never inflated past maxPart. */
export function zipRead(buf, entry, maxPart = MAX_PART) {
  if (!entry) return null;
  if (entry.csize === 0xffffffff || entry.local === 0xffffffff) throw new Error('zip64 files are not supported');
  const p = entry.local;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('damaged zip file');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.csize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error('unsupported compression');
  try {
    return inflateRawSync(data, { maxOutputLength: maxPart });
  } catch (error) {
    throw new Error(error.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError ? 'a part of the workbook is too large to preview' : 'damaged zip file');
  }
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
/** XML text: its entities and the _xHHHH_ escapes of Office. */
export const xmlText = s => String(s ?? '')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10)) : ENTITIES[e] ?? m))
  .replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
// Without namespace prefixes on the tags (<x:c> as <c>), as some programs write them.
const plain = buf => (buf ? buf.toString('utf8').replace(/<(\/?)[\w.-]+:/g, '<$1') : '');
// The text of a rich or plain string (<si>, <is>), without its phonetic hints.
const stringText = xml => xmlText([...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''));

// Built-in number formats that are dates or times.
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** The styles whose number format is a date, by index in cellXfs. */
function dateStyles(xml) {
  const custom = new Map([...xml.matchAll(/<numFmt\b[^>]*>/g)].map(m => [Number(attr(m[0], 'numFmtId')), xmlText(attr(m[0], 'formatCode') ?? '')]));
  const isDate = id => DATE_FORMATS.has(id) || (custom.has(id) && /[dmyhs]/i.test(custom.get(id).replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')));
  const xfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '';
  return [...xfs.matchAll(/<xf\b[^>]*>/g)].map(m => isDate(Number(attr(m[0], 'numFmtId'))));
}

/** A date serial as text: "2026-03-01", "14:30" or "2026-03-01 14:30". */
function serialDate(value, date1904) {
  // Days since 1970-01-01, which is serial 25569 (or 24107 in the 1904 system).
  const d = new Date(Math.round((value - (date1904 ? 24107 : 25569)) * 86_400_000));
  if (Number.isNaN(d.getTime())) return String(value);
  const iso = d.toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  if (Number.isInteger(value)) return day;
  return value < 1 ? time : `${day} ${time}`;
}

const columnIndex = ref => {
  const letters = String(ref ?? '').match(/^[A-Z]+/i)?.[0].toUpperCase() ?? '';
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
};

/**
 * An XLSX workbook: { sheets: [names], sheet, rows, total, truncated } for the sheet at index "sheet" (the first by
 * default), at most maxRows rows of at most MAX_COLUMNS cells, each as text.
 */
export function readXlsx(buf, { sheet = 0, maxRows = 5000, maxPart = MAX_PART } = {}) {
  let entries;
  try {
    entries = zipEntries(buf);
  } catch {
    throw new Error('not a valid XLSX file');
  }
  const part = name => plain(zipRead(buf, entries.get(name), maxPart));
  const workbook = part('xl/workbook.xml');
  if (!workbook) throw new Error('not a valid XLSX file');
  const date1904 = /<workbookPr\b[^>]*\sdate1904="(1|true)"/.test(workbook);
  const rels = new Map([...part('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(m => {
    const target = rels.get(m[0].match(/\s[\w]+:id="([^"]*)"/)?.[1]) ?? '';
    return { name: xmlText(attr(m[0], 'name') ?? ''), file: target.startsWith('/') ? target.slice(1) : `xl/${target}`.replace(/\/[^/]+\/\.\.\//g, '/') };
  });
  if (!sheets.length) throw new Error('not a valid XLSX file');
  const index = Math.max(0, Math.min(sheets.length - 1, Number(sheet) || 0));
  const shared = [...part('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map(m => stringText(m[1] ?? ''));
  const dates = dateStyles(part('xl/styles.xml'));
  const xml = part(sheets[index].file);
  const rows = [];
  let total = 0;
  let truncated = false;
  for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    // A row's number ("r"): the empty rows before it are kept, so the table matches the sheet.
    const at = Number(attr(r[0], 'r')) || total + 1;
    while (total < at - 1) {
      total++;
      if (rows.length < maxRows) rows.push([]);
    }
    total++;
    if (rows.length >= maxRows) {
      truncated = true;
      continue;
    }
    const row = [];
    let next = 0;
    for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[0], 'r');
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      if (col < 0 || col >= MAX_COLUMNS) {
        if (col >= MAX_COLUMNS) truncated = true;
        continue;
      }
      const type = attr(c[0], 't');
      const inner = c[2] ?? '';
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let text = '';
      if (type === 'inlineStr') text = stringText(inner.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? '');
      else if (v === undefined) text = '';
      else if (type === 's') text = shared[Number(v)] ?? '';
      else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'str' || type === 'e' || type === 'd') text = xmlText(v);
      else {
        const n = Number(v);
        text = Number.isFinite(n) ? (dates[Number(attr(c[0], 's')) || 0] ? serialDate(n, date1904) : String(n)) : xmlText(v);
      }
      while (row.length < col) row.push('');
      row[col] = text;
    }
    rows.push(row);
  }
  truncated ||= total > rows.length;
  // Trailing empty rows (formatted but blank) are left out.
  while (rows.length && !rows.at(-1).some(x => x !== '')) rows.pop();
  return { sheets: sheets.map(s => s.name), sheet: index, rows, total: truncated ? total : rows.length, truncated };
}
