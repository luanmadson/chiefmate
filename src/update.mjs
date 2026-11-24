// Self-update: when a pull request to Chiefmate is merged on GitHub, this installation updates itself.
// It waits until the crew and the manager are free, checks the new version first and, if anything fails,
// stays on the current one.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { t } from './i18n.mjs';
import { notify } from './notify.mjs';
import { now, ROOT } from './util.mjs';
import { run } from './workspace.mjs';

/** What the app shows about updates. */
export const updateInfo = { checked: null, waiting: 0, blocked: null };

const git = (...args) => run('git', args, ROOT, { maxMinutes: 5 });

async function check({ isBusy, beforeRestart }) {
  if (!existsSync(path.join(ROOT, '.git'))) return;
  if ((await git('fetch', 'origin', '--quiet')).code !== 0) return;
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).output.trim();
  const behind = Number((await git('rev-list', '--count', `HEAD..origin/${branch}`)).output.trim()) || 0;
  Object.assign(updateInfo, { checked: now(), waiting: behind });
  if (!behind || isBusy()) return;

  // Files of Chiefmate changed by hand in this installation: don't overwrite them.
  if ((await git('status', '--porcelain', '--untracked-files=no')).output.trim()) {
    if (updateInfo.blocked !== 'changes') {
      updateInfo.blocked = 'changes';
      notify(t('Update waiting'), t("Chiefmate's files were changed by hand in this installation, so the new version was not installed."));
    }
    return;
  }
  const before = (await git('rev-parse', 'HEAD')).output.trim();
  if ((await git('merge', '--ff-only', `origin/${branch}`)).code !== 0) {
    updateInfo.blocked = 'merge';
    return;
  }
  const checked = await run(process.execPath, [path.join('scripts', 'check.mjs')], ROOT, { maxMinutes: 5 });
  if (checked.code !== 0) {
    await git('reset', '--hard', before);
    updateInfo.blocked = 'checks';
    notify(t('Update not installed'), t('The new version failed its checks, so Chiefmate stayed on the current one.'));
    return;
  }
  notify(t('Chiefmate updated'), t('The improvements you approved are installed. Chiefmate restarts by itself.'));
  await restart(beforeRestart);
}

/**
 * Starts a fresh Chiefmate in the background and ends this one.
 * The new one is started first: if it can't start, this one carries on. It opens its own log ("--log") once this one
 * is gone, because the command that started this one may keep the log locked while this one runs.
 */
async function restart(beforeRestart) {
  const child = spawn(process.execPath, [path.join('src', 'cli.mjs'), 'server', '--log'], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, CHIEFMATE_RESTART_DELAY: '2000' },
  });
  await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
  child.unref();
  // A connection slow to close must not keep this one alive: two Chiefmates would share the queue and the schedule.
  await Promise.race([beforeRestart(), new Promise(resolve => setTimeout(resolve, 10_000))]);
  process.exit(0);
}

/** Checks GitHub a minute after starting and every 10 minutes after that. */
export function startUpdates(options) {
  const tick = () => check(options).catch(error => console.error('Update:', error));
  setTimeout(tick, 60_000);
  setInterval(tick, 10 * 60_000);
}
