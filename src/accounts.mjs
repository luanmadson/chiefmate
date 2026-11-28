// The Claude accounts Chiefmate works with. Each one has its own Claude Code configuration folder (CLAUDE_CONFIG_DIR),
// so its sign-in, its conversations and its usage (the plan's 5-hour window and week) are its own. Each project stays on
// one account ("projects.<id>.account"; without it, the default one), and so do the manager's conversation
// ("manager_account") and each live session (its profile's "account", else its project's). Chiefmate never moves work
// to another account when one runs out: which account a project uses is the owner's deliberate choice, in the settings.
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { DATA } from './util.mjs';

/** The id of the one account of settings without "accounts": Claude Code's own configuration, as before accounts. */
export const MAIN = 'main';
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The settings, or none when they can't be read now (a file being edited): then only the main account. */
function settings(config) {
  if (config) return config;
  try {
    return loadConfig();
  } catch {
    return {};
  }
}

/**
 * The accounts: [{ id, name, configDir (null: Claude Code's own, ~/.claude), default }]. From "accounts":
 * [{ "id": "team", "name": "Team seat" }, { "id": "personal", "name": "Personal", "config_dir": "<folder>" }], the
 * default one named by "default_account" (else the first); an entry without a valid id, or with an id seen before, is
 * left out. With no list, one account: MAIN, on Claude Code's own configuration.
 */
export function listAccounts(config) {
  const c = settings(config);
  const accounts = [];
  for (const a of Array.isArray(c.accounts) ? c.accounts : []) {
    const id = String(a?.id ?? '').trim().toLowerCase();
    if (!ID.test(id) || accounts.some(x => x.id === id)) continue;
    const dir = typeof a.config_dir === 'string' && a.config_dir.trim() ? path.resolve(a.config_dir.trim()) : null;
    accounts.push({ id, name: String(a.name ?? '').trim() || id, configDir: dir });
  }
  if (!accounts.length) accounts.push({ id: MAIN, name: t('Claude account'), configDir: null });
  const chosen = accounts.find(a => a.id === String(c.default_account ?? '').trim().toLowerCase()) ?? accounts[0];
  return accounts.map(a => ({ ...a, default: a === chosen }));
}

/** Whether the settings list more than one account (the app and the manager then name the account of each thing). */
export const manyAccounts = config => listAccounts(config).length > 1;

export const defaultAccount = config => listAccounts(config).find(a => a.default);

/**
 * The account an id names. A missing id is the default one; an id not in the list comes back with "missing", so
 * nothing runs on it (accountEnv refuses it) and no other account is used in its place.
 */
export function findAccount(config, id) {
  const list = listAccounts(config);
  const want = String(id ?? '').trim().toLowerCase();
  if (!want) return list.find(a => a.default);
  return list.find(a => a.id === want) ?? { id: want, name: want, configDir: null, default: false, missing: true };
}

/**
 * A live session's account (src/sessions.mjs): the one recorded when it opened; a session from before accounts ran
 * on Claude Code's own configuration, where its conversation is, so it stays there.
 */
export function sessionAccount(config, session) {
  const c = settings(config);
  if (session?.account) return findAccount(c, session.account);
  return listAccounts(c).find(a => !a.configDir) ?? listAccounts(c).find(a => a.default);
}

/**
 * The account a live session opens on (the owner's own work: a session, "Work now", the agent in charge): the owner's
 * choice, else its profile's "account", else its project's "sessions_account", else the general "sessions_account",
 * else its project's account, else the default. So the crew may work on one account while the owner's sessions keep
 * to another.
 */
export function openingAccount(config, profile, chosen = null) {
  const c = settings(config);
  if (chosen) return findAccount(c, chosen);
  if (profile?.account) return findAccount(c, profile.account);
  const own = (profile?.project ? c.projects?.[profile.project]?.sessions_account : null) ?? c.sessions_account;
  if (own) return findAccount(c, own);
  return profile?.project ? projectAccount(c, profile.project) : findAccount(c, null);
}

/** A project's account: "projects.<id>.account", else the default one. */
export const projectAccount = (config, projectId) => findAccount(settings(config), settings(config).projects?.[projectId]?.account);

/** The manager's conversation's account (and Chiefmate's own short calls): "manager_account", else the default one. */
export const managerAccount = config => findAccount(settings(config), settings(config).manager_account);

/**
 * The environment that points Claude Code at an account: its CLAUDE_CONFIG_DIR, or nothing for Claude Code's own
 * configuration. An account missing from the settings is refused: work never runs on another account in its place.
 */
export function accountEnv(account) {
  if (!account) return {};
  if (account.missing) {
    throw new Error(t('The Claude account "{id}" is not in the settings ("accounts"). Fix the setting: Chiefmate never moves work to another account by itself.', { id: account.id }));
  }
  return account.configDir ? { CLAUDE_CONFIG_DIR: account.configDir } : {};
}

/** Where Claude Code keeps an account's conversations (the "projects" folder of its configuration). */
export const accountHome = (account, home) => account?.configDir ?? path.join(home, '.claude');

/**
 * Where Chiefmate keeps what is an account's own (its usage, the spending's samples, the usage page's reading): the
 * data folder itself for Claude Code's own configuration (as before accounts, so nothing moves), else
 * data/accounts/<id>.
 */
export const accountData = account => (account?.configDir || account?.missing ? path.join(DATA, 'accounts', account.id) : DATA);

/** How the manager and the app name an account: its name, with its id when they differ. */
export const accountLabel = account => (account ? (account.name && account.name !== account.id ? `${account.name} (${account.id})` : account.id) : '');
