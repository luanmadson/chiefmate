// Paths and small helpers shared by the rest of Chiefmate.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
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

/** Writes to a temporary file and swaps it in at once, so a shutdown midway never leaves half a JSON file. */
export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2));
  renameSync(temporary, file);
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
