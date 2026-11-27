// The schedule: starts missions on their days and times, sends the eve reminder and catches up on a missed run.
// A mission whose time came while Chiefmate was off or on standby (src/power.mjs), or while the owner's focus held its
// project (src/steer.mjs), runs once at the next chance, however many of its times went by: the run is marked late
// ("due") and starts at once.
import { loadConfig } from './config.mjs';
import { formatDateTime, locale, t } from './i18n.mjs';
import { notify } from './notify.mjs';
import { held } from './power.mjs';
import { nudgeQueue } from './queue.mjs';
import { holdReason, readSteer } from './steer.mjs';
import { createRun } from './runs.mjs';
import { readState, saveState } from './store.mjs';
import { now } from './util.mjs';

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const daysOf = schedule => (schedule?.days ?? []).map(d => DAYS[String(d).slice(0, 3).toLowerCase()]).filter(d => d !== undefined);

function atTime(schedule, day) {
  const [hours, minutes] = String(schedule.time ?? '09:00').split(':').map(Number);
  const d = new Date(day);
  d.setHours(hours, minutes || 0, 0, 0);
  return d;
}

export function nextRun(schedule, after = new Date()) {
  const days = daysOf(schedule);
  for (let i = 0; i <= 14 && days.length; i++) {
    const d = new Date(after);
    d.setDate(d.getDate() + i);
    const time = atTime(schedule, d);
    if (days.includes(time.getDay()) && time > after) return time;
  }
  return null;
}

export function lastRun(schedule, until = new Date()) {
  const days = daysOf(schedule);
  for (let i = 0; i <= 14 && days.length; i++) {
    const d = new Date(until);
    d.setDate(d.getDate() - i);
    const time = atTime(schedule, d);
    if (days.includes(time.getDay()) && time <= until) return time;
  }
  return null;
}

/** "Every week: Monday at 09:00", in the app's language. */
export function describeSchedule(schedule) {
  const days = daysOf(schedule);
  if (!days.length) return t('Only when you ask');
  if (days.length === 7) return t('Every day at {time}', { time: schedule.time });
  // 7 January 2024 was a Sunday: 7 + d is weekday d.
  const weekday = new Intl.DateTimeFormat(locale(), { weekday: 'long', timeZone: 'UTC' });
  const names = days.map(d => weekday.format(new Date(Date.UTC(2024, 0, 7 + d))));
  const list = names.length > 1 ? t('{list} and {last}', { list: names.slice(0, -1).join(', '), last: names.at(-1) }) : names[0];
  return t('Every week: {days} at {time}', { days: list, time: schedule.time });
}

/** More than this late, a mission's run is "late": the computer or Chiefmate was off, or on standby. */
export const LATE_MINUTES = 20;

/** Whether a mission due at "last" is late at "at". */
export const isLate = (last, at = Date.now()) => (at - last.getTime()) / 60000 > LATE_MINUTES;

function startScheduledRun(id, mission, last) {
  const late = isLate(last);
  try {
    createRun({ kind: 'mission', missionId: id, origin: late ? 'schedule-late' : 'schedule', due: late ? last.toISOString() : null });
    if (late) {
      notify(
        t('Late mission'),
        t('"{name}" was due at {when}, while Chiefmate was off, on standby or its project was held by your focus. It runs now; to cancel, open Chiefmate.', { name: mission.name, when: formatDateTime(last) }),
        'chiefmate:operations',
      );
    }
    nudgeQueue();
  } catch (error) {
    notify(t('Chiefmate hit an error'), t('{title}: {error}', { title: mission.name ?? id, error: error.message }), 'chiefmate:missions', { urgent: true });
  }
}

function check() {
  const config = loadConfig();
  const state = readState();
  state.schedule ??= {};
  state.reminders_sent ??= {};
  let changed = false;
  const steer = readSteer();
  for (const [id, mission] of Object.entries(config.missions ?? {})) {
    if (!daysOf(mission.schedule).length) continue;
    const last = lastRun(mission.schedule);
    const recorded = state.schedule[id];
    if (!recorded) {
      // The first time Chiefmate sees this mission: start counting from here, without catching up on the past.
      state.schedule[id] = (last ?? new Date()).toISOString();
      changed = true;
    } else if (last && new Date(recorded) < last && !held() && !holdReason(mission.project, steer)) {
      // Only the last time missed counts: one run, never one per time missed. On standby, or while the owner's focus
      // holds its project (src/steer.mjs), it waits, and runs once after.
      state.schedule[id] = last.toISOString();
      changed = true;
      startScheduledRun(id, mission, last);
    }
    if (mission.eve_reminder) {
      const next = nextRun(mission.schedule);
      if (!next) continue;
      const eve = new Date(next);
      eve.setDate(eve.getDate() - 1);
      const [hours, minutes] = String(mission.eve_reminder).split(':').map(Number);
      eve.setHours(hours, minutes || 0, 0, 0);
      const key = `${id}@${next.toISOString()}`;
      if (Date.now() >= eve.getTime() && Date.now() < next.getTime() && !state.reminders_sent[key]) {
        state.reminders_sent[key] = now();
        changed = true;
        notify(
          t('Mission tomorrow'),
          t('{name}: {when}. Leave the computer on or asleep; it wakes up by itself to work.', { name: mission.name, when: formatDateTime(next) }),
          'chiefmate:missions',
        );
      }
    }
  }
  if (changed) saveState(state);
}

export function startSchedule() {
  check();
  setInterval(() => {
    try {
      check();
    } catch (error) {
      console.error('Schedule:', error);
    }
  }, 30_000);
}
