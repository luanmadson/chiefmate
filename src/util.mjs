// Paths and small helpers shared by the rest of Chiefmate.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// CHIEFMATE_DATA points a temporary Chiefmate (the smoke test) at a folder of its own, away from the installation's records.
export const DATA = process.env.CHIEFMATE_DATA ? path.resolve(process.env.CHIEFMATE_DATA) : path.join(ROOT, 'data');
export const WORKSPACES = path.join(ROOT, 'workspaces');
export const RUNS = path.join(DATA, 'runs');
export const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Writes to a temporary file and swaps it in at once, so a shutdown midway never leaves half a JSON file. On Windows,
 * the swap fails (EBUSY, EPERM, EACCES) while another process (the window of a live session, the CLI, an antivirus)
 * has the file open: it is tried again for about two seconds. The temporary file is this process's own.
 */
export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2));
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temporary, file);
      return;
    } catch (error) {
      if (attempt >= 20 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) {
        rmSync(temporary, { force: true });
        throw error;
      }
      pause(100);
    }
  }
}

export const now = () => new Date().toISOString();
const pad = n => String(n).padStart(2, '0');

/** 2026-11-24-1530, in local time: used in run ids and branch names. */
export function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function clip(text, size) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > size ? `${flat.slice(0, size - 1)}…` : flat;
}

export function slug(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

const LANGUAGE_NAMES = {
  en: 'English',
  'pt-BR': 'Brazilian Portuguese',
  'pt-PT': 'European Portuguese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
};

/** The language's name in English, for instructions to the agents: "pt-BR" becomes "Brazilian Portuguese". */
export const languageName = code => LANGUAGE_NAMES[code] ?? code ?? 'English';
