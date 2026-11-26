// Chiefmate's command line. The manager uses these commands to queue work; you can use them too.
import { openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { loadConfig, saveConfig } from './config.mjs';
import { fullReport, outcomeMarkdown } from './digest.mjs';
import { formatDateTime, formatDuration } from './i18n.mjs';
import { notify } from './notify.mjs';
import { listRuns, readRun, stepsOf } from './store.mjs';
import { DATA, ensureDir } from './util.mjs';

const [command, ...rest] = process.argv.slice(2);
const option = name => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = name => rest.includes(name);
// The words of a command that are not options nor their values ("--title <text>").
const VALUED = ['--origin', '--plan', '--modules', '--title', '--summary', '--level', '--note', '--recommend', '--project', '--tool', '--from', '--description'];
const words = () => rest.filter((x, i) => !x.startsWith('--') && !VALUED.includes(rest[i - 1]));
/** The title and summary given with --title and --summary: nothing is generated for them. */
const brief = () => ({ title: option('--title'), summary: option('--summary'), level: option('--level'), tool: option('--tool') });
// CHIEFMATE_PORT runs a second, temporary Chiefmate next to yours (the smoke test does this).
const port = () => Number(process.env.CHIEFMATE_PORT) || loadConfig().port || 4747;
const work = run => formatDuration(stepsOf(run).reduce((sum, s) => sum + (s.durationMs ?? 0), 0));

async function api(route, body) {
  const r = await fetch(
    `http://localhost:${port()}${route}`,
    body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-chiefmate': '1' }, body: JSON.stringify(body) } : {},
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Whether a Chiefmate answers on this port. */
const answers = () => api('/api/health').then(() => true, () => false);

/**
 * "server --log": Chiefmate writes what it prints to data/server.log, opening the file itself. A log redirected by
 * cmd (">>") stays locked while Chiefmate runs, and a Chiefmate restarted by the self-update could not write to it.
 * If the file is locked anyway, it waits up to ten seconds and then carries on without a log.
 */
async function logToFile() {
  const file = path.join(ensureDir(DATA), 'server.log');
  for (let i = 0; i < 20; i++) {
    let fd;
    try {
      fd = openSync(file, 'a');
    } catch {
      await sleep(500);
      continue;
    }
    const write = (...args) => {
      try {
        writeSync(fd, `${format(...args)}\n`);
      } catch {
        // the log is a convenience: it never stops Chiefmate
      }
    };
    console.log = console.info = console.warn = console.error = write;
    process.on('uncaughtException', error => {
      write('Uncaught:', error);
      process.exit(1);
    });
    return;
  }
}

const HELP = `Chiefmate: a command center for AI agents

  node src/cli.mjs server [--log]               starts the app, the queue, the schedule and the updates (http://localhost:${port()});
                                                --log writes what it prints to data/server.log
  node src/cli.mjs status                       what is running, the queue, the account's usage and the crew
  node src/cli.mjs mission <id> [--plan <n>] [--level 1|2|3] [--tool claude|codex|grok]
                                                queues a mission (the ids are in config/chiefmate.json); --tool: the
                                                tool of its crew's steps that name none ("tool" in a mission's step)
  node src/cli.mjs task <project> <agent> "<what to do>" [--review] [--modules A,B] [--plan <n>] [--level 1|2|3]
                            [--tool claude|codex|grok]
                                                queues a one-off task; --review has the manager review it at the end;
                                                --modules adds optional blocks of the prompt builder; --plan links it
                                                to item n of the planning board, which then follows the run; --level is
                                                the approval level of its result (1: the manager decides, 2: the owner
                                                approves, 3: only the owner), shown on the owner's decision card;
                                                --tool runs it on that tool instead of the member's own (Claude Code
                                                when the tool is not available or signed in, or the project is
                                                "sensitive"; the final review is always on Claude Code)
  node src/cli.mjs ask <project> "<request>" [--plan <n>] [--level 1|2|3] [--tool claude|codex|grok]
                                                queues a request for the project's team lead ("lead" in its settings):
                                                the lead plans it into at most 3 tasks for the project's crew, reviews
                                                their work first, and the manager does the final review; --tool: the
                                                tool of the tasks the lead plans
  node src/cli.mjs tools [--json]               how Codex and Grok did on the crew's steps (data/manager/tools-quality.jsonl):
                                                by tool and kind of task, how many, % approved with no correction, mean time
  node src/cli.mjs level <run id> <1|2|3|none>  sets (or clears) the approval level of a run
  node src/cli.mjs effort [<agent>] [low|medium|high|xhigh|max|default] [--project <id>] [--chat]
                                                each agent's effort (docs/effort.md), or changes one: for the
                                                installation, or that project only with --project; --chat: the
                                                manager's conversation; default: back to the level before it.
                                                Counts from the next step and is recorded (effort history)
  node src/cli.mjs effort history [--project <id>]
                                                the recorded effort changes: who, when, from and to
  node src/cli.mjs plan [list] [--project <id>] [--status <s>] [--priority <p>] [--all]
                                                the planning board: open items by priority (--all: done and archived too)
  node src/cli.mjs plan add <project> "<title>" [--priority high|medium|low] [--status <s>] [--description "<text>"]
                                                adds an item; statuses: proposed, triaged, approved, future, todo, queued,
                                                in_progress, waiting_owner, done, discarded
  node src/cli.mjs plan set <n> [--title ...] [--description ...] [--project ...] [--priority ...] [--status ...] [--agent ...]
                            [--tool claude|codex|grok|""] [--run <id>] [--pr <url>] [--level 1|2|3|none] [--archive | --restore]
                                                changes item n (--run "" or --pr "" removes the link)
  node src/cli.mjs plan done <n>                marks item n as done
  node src/cli.mjs plan propose <project> "<short title>" --summary "<1-2 sentences>" [--agent <member>] [--priority ...]
                                                for the crew: proposes an item (status "proposed", the author recorded);
                                                the manager hears of it and triages it, the owner decides
  node src/cli.mjs plan triage <n> --recommend now|later|discard --level 1|2|3 [--agent <member>] [--priority ...]
                            [--note "..."] [--risk "..."] [--order <position>] [--tool claude|codex|grok]
                                                for the manager: the item then waits for the owner's decision (--risk:
                                                one line on what to watch, shown on the owner's card; --level: its
                                                approval level, also shown there; --tool: the tool suggested for its
                                                task, which runs on it once approved)
  node src/cli.mjs plan approve|later|discard <n> [--reason "..."] [--duplicate-of <m>] [--tool claude|codex|grok]
                                                the decision: "approve" makes it a task for its agent (one approved task
                                                per project at a time, the others wait in order), "later" leaves it for
                                                the future, "discard" sets it aside with a reason (plan restore <n> brings
                                                it back)
  node src/cli.mjs plan approve <n> --autopilot for the manager, with the autopilot on: puts an item triaged "now" on
                                                the queue of a project whose queue is empty, within the autopilot's limits
  node src/cli.mjs plan order <n> <n> ...       puts these items first in the owner's order, in this order
  node src/cli.mjs radar [list] [--status <s>] [--all]
                                                the project radar: ideas for new projects, highest potential first
                                                (statuses: new, studying, chosen, discarded, project; --all: discarded too)
  node src/cli.mjs radar show <n>               an idea with its fundamentals and sources
  node src/cli.mjs radar add "<title>" --summary "<one sentence>" --potential 1-5 --effort 1-5 --risk 1-5
                     --source "<name> <https://...>" [--source ...] [--problem ...] [--audience ...] [--market ...]
                     [--competitor "<name> <https://...>" ...] [--trend ...] [--revenue ...] [--advantage ...]
                     [--risks ...] [--series "2024:40,2025:55"]   or: radar add --file <idea.json>
                                                adds an idea (refused without a source, or when its title is there)
  node src/cli.mjs radar set <n> [the same options] [--status <s>] [--project <id>] [--file <idea.json>]
                                                updates an idea (a step of a run can't set chosen, discarded or project)
  node src/cli.mjs radar choose|later|discard|restore <n> [--reason "..."]
                                                the owner's decisions: "choose" puts a proposal on the planning board
                                                for the manager to turn it into a project; "later" leaves it in study
  node src/cli.mjs chat [n]                     the conversation with the manager: the last n messages (10), what it is
                                                doing now and the messages waiting in the queue
  node src/cli.mjs chat say "<message>"         writes to the manager; while it answers, the message waits in the queue
                                                and goes with the others, in order, when the answer ends
  node src/cli.mjs chat edit <id> "<message>"   changes a message still in the queue (chat remove <id> takes it out)
  node src/cli.mjs chat interrupt               ends the current answer (the conversation goes on); the queue goes next
  node src/cli.mjs session [<profile>] [--window] [--dry-run]
                                                opens a live session (the profiles are in "sessions" in the settings):
                                                a conversation in the app with Claude Code or Codex (--window: in a
                                                window of its own), started with the prompt builder's blocks; with no
                                                profile, lists the profiles and the sessions open; --dry-run shows the
                                                folder, the command and the first message only
  node src/cli.mjs session log <id> [n]         a session's history: the last n entries (40), messages and actions
  node src/cli.mjs session say <id> "<message>" [--owner-asked]
                                                writes to a session in the app (queued while the agent works); the
                                                manager does it only when the owner asks, with --owner-asked
  node src/cli.mjs session end <id>             ends a live session (its turn stops, or its window closes)
  node src/cli.mjs dev <project> [--dry-run]    starts the project's development environment ("dev_start" in its settings)
                                                in a window of its own, in your clone; --dry-run shows what would run
  node src/cli.mjs dev stop <project>           stops it, with everything it started
  node src/cli.mjs cancel <id>                  cancels a run
  node src/cli.mjs resume <id> [--ignore-limits]
                                                resumes a paused, failed or canceled run
  node src/cli.mjs ask-owner "<question>" [--context "<explanation>"] [--options "Yes|No|Wait"] [--recommend <option>] [--project <id>]
                            [--level 1|2|3]
                                                the manager's question for the owner: a card in the app with one button
                                                per option and a field to write; the answer (the option, what the owner
                                                wrote, or both) comes back as "owner_decided" news
  node src/cli.mjs request [list] [--project <id>] [--all]
                                                the requests the agents in charge of the projects sent from their talk
                                                with the owner (--all: answered ones too)
  node src/cli.mjs request show <id>            one request: what the owner asked, the plan, size, risk, urgency, answers
  node src/cli.mjs request <id> approve|hold|ask-owner|reject [--note "<why>"] [--recommend approve|hold|reject]
                     [--title "..."] [--summary "..."]
                                                the manager's answer: approve queues the work for the project (an "ask"
                                                for a team lead, else a task with your review), hold leaves it waiting,
                                                ask-owner makes it a card in Decisions, reject refuses it (--note is
                                                required except to approve); the answer goes back to the conversation
  node src/cli.mjs merge <id> [--yes]           merges a finished run's work, only with the owner's authorization: shows
                                                the pull request (or the branch delivered locally), the checks and the
                                                review's verdict; with --yes, Chiefmate merges it (a pull request on
                                                GitHub; a local branch into your clone's base branch, nothing pushed)
  node src/cli.mjs push <folder> <branch>       for the manager: the push the owner allowed on its card (that branch,
                                                from that folder, once, within 30 minutes; never the main branch, never
                                                forced). Without the owner's grant it refuses and sends nothing
  node src/cli.mjs repo-create <name> --private --from <folder> [--description "<text>"]
                                                for the manager: a private repository in the owner's GitHub account for a
                                                local folder. Without the owner's grant, a card for them to allow it; with
                                                it (once, within 30 minutes), creates it (always private), adds it to the
                                                folder as "origin" and sends the folder's branch. Never public, never a
                                                name that already exists
  node src/cli.mjs close-pr <id> --replaced-by <id> [--yes]
                                                a run's pull request replaced by a newer run's (same board item, or the
                                                newer instruction names the old run): shows both; with --yes, closes it
                                                on GitHub with a comment naming the new one (the branch stays)
  node src/cli.mjs update-check                 looks for an approved update of Chiefmate now (after a merge), instead of
                                                within 10 minutes; it then installs as "auto_update_mode" says
  node src/cli.mjs update-now [--yes] [--interrupt-manager]
                                                installs the approved update now: shows what pauses; with --yes, pauses
                                                the runs going on at a safe point, waits for the manager's answer (or
                                                interrupts it), installs, restarts and resumes the paused work
  node src/cli.mjs power [status]               the power mode: on, standby or stopping
  node src/cli.mjs power standby|on|stop|shutdown|cancel [--yes]
                                                standby: nothing new starts (the queue, the missions, the autopilot), the
                                                runs going on pause at a safe point, the live sessions go on; on: back
                                                from standby. stop: pauses everything at a safe point, closes the crew's
                                                browsers and processes and ends Chiefmate (the watchdog leaves it off;
                                                the next start resumes the work). shutdown: the same, then Windows shuts
                                                down after a 60-second countdown. cancel: stops a stop or shutdown going
                                                on. Without --yes, only shows what would happen
  node src/cli.mjs history [n]                  the latest runs
  node src/cli.mjs report <id>                  the report of each step of a run
  node src/cli.mjs context <id> [step]          what each step received: prompt, model, tools, folders, MCP servers
  node src/cli.mjs project-context <project> [member] [--short] [--json]
                                                everything the project's crew (or one member) gets now, in order and by
                                                source, with sizes in tokens; its live sessions' first messages; and what
                                                changed since each member's last run. --short leaves the texts out
  node src/cli.mjs needs-you "<what to do>" [--url <address>] [--wait] [--check "<command>"] [--id <request>]
                                                for a step of a run: asks the owner to act and, with --wait, waits
                                                until they click "I did it" (or the check command succeeds)
  node src/cli.mjs needs-you "<question>" --options "A|B" [--recommend A] [--why "<one sentence>"]
                                                for a step of a run: asks the owner to choose, one button per option
                                                (the recommended one marked) and a field to write, and waits for the
                                                answer: the option, what the owner wrote, or both
  node src/cli.mjs prompts-sync                 brings the prompt builder's document up to date: the library's copy
                                                (git), or a copy from Google Docs through your browser
  node src/cli.mjs limits [--window-5h 0.85] [--plan-week 0.9]
                                                when runs pause, as a share of the account's 5-hour window and plan week
  node src/cli.mjs ram                          the projects running on this computer and the memory each one uses
  node src/cli.mjs stop-project <id> [--yes]    lists, then (with --yes) stops a project's processes on this computer
  node src/cli.mjs reset-grant [list]           the plan's free resets you recorded
  node src/cli.mjs reset-grant add <expires> ["<note>"]
                                                records a free reset (expires: YYYY-MM-DD)
  node src/cli.mjs reset-grant used <n>         marks free reset number n as used (remove <n> deletes it)
  node src/cli.mjs claude-login                 opens a browser window to sign in to claude.ai, for the optional usage reading
  node src/cli.mjs autopilot [on|off] [--week-pace 0.95] [--window-5h 0.85] [--quiet 23:00-07:00|off] [--report 08:00|off]
                                                the autopilot: when a project's queue empties, the manager puts its next
                                                item triaged "now" on the queue, within these limits; with no option, its
                                                settings, whether it may act now and what it did in the last day
  node src/cli.mjs usage-reader on|off|now      turns the reading of claude.ai's usage page on or off, or reads it now
  node src/cli.mjs watch [--dry-run] [--json]   the watchdog's check, run every 10 minutes by the Windows task "Watchdog":
                                                whether Chiefmate answers, a stuck queue, run or update, the live sessions,
                                                memory and orphan processes; when Chiefmate is stuck, it calls the rescuer.
                                                --dry-run only shows what it sees
  node src/cli.mjs rescue restart|stop-orphans [<pid> ...]|resume <run> [--dry-run]
                                                the rescuer's safe actions (yours too): restart Chiefmate, stop the orphan
                                                processes left by the crew, resume a paused or failed run (once a day)
  node src/cli.mjs notify "<title>" "<text>"    tests a Windows notification`;

/** The API when Chiefmate is running, else the same work done here. */
async function apiOr(route, body, local) {
  try {
    return await api(route, body);
  } catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED' && !/fetch failed/.test(error.message)) throw error;
    return local();
  }
}

/**
 * "needs-you", run by a step (Chiefmate gives it CHIEFMATE_RUN and CHIEFMATE_STEP). Without --wait it only records
 * the request. With --wait it waits in rounds of at most 9 minutes (the Bash tool stops a command at 10): exit code 0
 * when it is done, 3 when the round ended and it is still waiting, 2 when the wait runs out or the run ends.
 */
async function needsYou() {
  const run = process.env.CHIEFMATE_RUN;
  if (!run) throw new Error('needs-you is for a step of a Chiefmate run (CHIEFMATE_RUN is not set).');
  const check = option('--check');
  let id = option('--id');
  if (!id) {
    const what = rest.find((x, i) => !x.startsWith('--') && !['--url', '--check', '--id', '--options', '--recommend', '--why'].includes(rest[i - 1]));
    const request = await api('/api/needs-you', {
      run, step: process.env.CHIEFMATE_STEP, what, url: option('--url'), wait: has('--wait'), check,
      options: option('--options'), recommend: option('--recommend'), why: option('--why'),
    });
    id = request.id;
    const opened = { browser_cdp: "in a new tab of the owner's browser", playwright: 'in a browser window for the owner', browser: 'in a browser window for the owner' }[request.opened];
    console.log(`${request.options ? 'Question' : 'Request'} ${id} sent to the owner${opened ? `; the address opened ${opened}` : ''}.${request.openError ? ` The address did not open: ${request.openError}` : ''}`);
    // A question always waits for its answer.
    if (!request.wait) return;
  }
  const { spawnSync } = await import('node:child_process');
  const roundEnds = Date.now() + 9 * 60_000;
  let lastCheck = 0;
  for (;;) {
    const s = await api('/api/needs-you/poll', { run, id });
    if (s.status === 'done') {
      // The option chosen and/or what the owner wrote (an explanation, or an answer of their own instead of an option).
      if (s.answer && s.note) console.log(`The owner answered you from the app:\n${s.answer}\n\nAnd wrote:\n${s.note}\n\nTake the answer into account and go on.`);
      else if (s.note) console.log(`The owner answered you from the app in their own words (none of the options):\n${s.note}\n\nTake the answer into account and go on.`);
      else if (s.answer) console.log(`The owner answered you from the app:\n${s.answer}\n\nTake the answer into account and go on.`);
      else console.log(s.by === 'check' ? 'Done: the check succeeded.' : 'Done: the owner says they did it. Go on.');
      return;
    }
    if (s.status === 'closed') {
      console.log('The request closed because the run ended.');
      process.exitCode = 2;
      return;
    }
    if (s.timedOut) {
      console.log(`No answer within ${s.maxWaitMinutes} min. The request stays open until the run ends. Finish what you can and say in your report what is left for the owner.`);
      process.exitCode = 2;
      return;
    }
    if (check && Date.now() - lastCheck >= 15_000) {
      lastCheck = Date.now();
      if (spawnSync(check, { shell: true, stdio: 'ignore', windowsHide: true, timeout: 60_000 }).status === 0) {
        await api('/api/needs-you/done', { run, id, by: 'check' });
        continue;
      }
    }
    if (Date.now() >= roundEnds) {
      const self = process.argv[1].replaceAll('\\', '/');
      console.log(`Still waiting for the owner (${s.waitedMinutes} of at most ${s.maxWaitMinutes} min). To keep waiting, run: node ${/\s/.test(self) ? `"${self}"` : self} needs-you --wait --id ${id}${check ? ` --check ${JSON.stringify(check)}` : ''}`);
      process.exitCode = 3;
      return;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

/** "chat": the conversation with the manager, through the running Chiefmate. */
async function chatCommand() {
  const [action, ...args] = rest;
  const time = iso => (iso ? formatDateTime(iso) : '');
  if (['say', 'edit', 'remove', 'interrupt'].includes(action) && process.env.CHIEFMATE_MANAGER) {
    throw new Error("The manager can't write to its own conversation.");
  }
  switch (action) {
    case 'say': {
      const m = await api('/api/manager', { message: args.join(' ') });
      console.log(m.queued ? `Queued (${m.position} waiting, id ${m.id}): it goes when the manager finishes its answer.` : 'Sent. The manager is answering: node src/cli.mjs chat');
      return;
    }
    case 'edit':
      await api('/api/manager/edit', { id: args[0], message: args.slice(1).join(' ') });
      console.log(`Message ${args[0]} changed.`);
      return;
    case 'remove':
      await api('/api/manager/remove', { id: args[0] });
      console.log(`Message ${args[0]} taken out of the queue.`);
      return;
    case 'interrupt':
      console.log((await api('/api/manager/interrupt', {})).interrupted ? 'Interrupted. The messages in the queue go next.' : 'The manager was not answering.');
      return;
    default: {
      if (action && !/^\d+$/.test(action)) throw new Error('Use: chat [n] | say "<message>" | edit <id> "<message>" | remove <id> | interrupt');
      const g = (await api('/api/state')).manager;
      const who = { you: 'You', manager: 'Manager', system: 'Chiefmate' };
      for (const m of g.messages.slice(-(Number(action) || 10))) {
        const extra = [m.news ? `notice: ${m.news.join(', ')}` : '', m.queued ? `delivered ${time(m.delivered)}` : '', m.interrupted ? 'interrupted' : ''].filter(Boolean).join(', ');
        console.log(`[${time(m.at)}] ${who[m.who] ?? m.who}${extra ? ` (${extra})` : ''}:\n${m.text}\n`);
      }
      if (g.responding) {
        console.log(`Now: ${g.context?.renewing ? 'renewing the conversation' : 'answering'} since ${time(g.since)}.${g.lastAction ? ` Last action, ${time(g.lastAction.at)}: ${g.lastAction.text}` : ''}`);
      } else console.log('Now: waiting for you.');
      for (const m of g.pending) console.log(m.from === 'chiefmate' ? `In the queue [${m.id}], Chiefmate's news for the manager since ${time(m.at)}: ${m.text}` : `In the queue [${m.id}], sent ${time(m.at)}${m.edited ? ', edited' : ''}: ${m.text}`);
    }
  }
}

/** "request": the requests of the projects' agents in charge (src/charge.mjs), listed, shown and answered by the manager. */
async function requestCommand() {
  const { readRequests } = await import('./charge.mjs');
  const [first = 'list', second] = words();
  const line = r => `#${String(r.id).padEnd(3)} ${r.status.padEnd(8)} ${r.project}: ${r.plan.replace(/\s+/g, ' ').slice(0, 100)}  (${r.size}, risk ${r.risk}${r.urgency ? ', now' : ''}${r.level ? `, level ${r.level}` : ''}${r.run ? `, run ${r.run}` : ''})`;
  if (first === 'list') {
    const all = readRequests().filter(r => (!option('--project') || r.project === option('--project')) && (has('--all') || ['pending', 'waiting', 'owner'].includes(r.status)));
    if (!all.length) console.log(has('--all') ? 'No requests.' : 'No request waiting for an answer.');
    for (const r of all) console.log(line(r));
    return;
  }
  const id = first === 'show' ? second : first;
  const r = readRequests().find(x => x.id === Number(String(id ?? '').replace(/^#/, '')));
  if (!r) throw new Error(`Request ${id} not found. node src/cli.mjs request list`);
  if (first === 'show' || !second) {
    console.log(line(r));
    console.log(`  Asked (by the owner, ${formatDateTime(r.at)}): ${r.asked}
  Plan (${r.memberName ?? r.member ?? 'the agent in charge'}): ${r.plan}`);
    for (const h of r.history ?? []) console.log(`  ${formatDateTime(h.at)} ${h.by}: ${h.action}${h.note ? ` (${h.note})` : ''}`);
    if (!second && first !== 'show') console.log(`Answer with node src/cli.mjs request ${r.id} approve|hold|ask-owner|reject --note "<why>" --level 1|2|3.`);
    return;
  }
  // Only the manager (or the owner) answers: a step of a run never does.
  if (process.env.CHIEFMATE_RUN && !process.env.CHIEFMATE_MANAGER) throw new Error('A step of a run cannot answer the requests of the agents in charge.');
  const result = await api('/api/request', { id: r.id, action: second, note: option('--note'), recommend: option('--recommend'), ...brief() });
  const a = result.request;
  console.log(`Request #${a.id}: ${a.status}${result.run ? `. Queued: ${result.run.title} [${result.run.id}]` : ''}${result.question ? `. Question #${result.question.id} waits for the owner in Decisions; the answer decides the request by itself.` : ''}`);
  console.log('The answer went back to the conversation with the agent in charge.');
}

/**
 * "plan": the planning board, read and changed in data/plan.json (with or without Chiefmate running). Proposals,
 * triage and decisions go through the running Chiefmate when there is one, so the manager hears of new proposals and
 * an approved item's task is queued at once.
 */
async function planCommand() {
  const planning = await import('./planning.mjs');
  // The options that take a value.
  const keys = ['title', 'description', 'project', 'priority', 'status', 'agent', 'tool', 'run', 'pr', 'level', 'summary', 'recommend', 'note', 'risk', 'order', 'reason', 'by', 'duplicate-of'];
  const [action = 'list', ...args] = rest.filter((x, i) => !x.startsWith('--') && !keys.includes(rest[i - 1]?.slice(2)));
  const fields = () => Object.fromEntries(['title', 'description', 'project', 'priority', 'status', 'agent', 'tool', 'run', 'pr', 'level'].filter(k => option(`--${k}`) !== undefined).map(k => [k, option(`--${k}`)]));
  const line = i => `#${String(i.id).padEnd(3)} ${i.priority.padEnd(6)} ${i.status.padEnd(13)} ${i.project}: ${i.title}${i.agent ? `  (${i.agent}${i.tool ? `, on ${i.tool}` : ''})` : ''}${i.recommend ? `  [recommended: ${i.recommend}]` : ''}${i.level ? `  [level ${i.level}]` : ''}${i.run ? `  [run ${i.run}${i.run_status ? `, ${i.run_status}` : ''}]` : ''}${i.pr ? `  ${i.pr}` : ''}${i.archived ? '  (archived)' : ''}`;
  const notes = i => [
    i.description,
    i.proposed_by ? `Proposed by ${i.proposed_by}${i.proposed_run ? ` (run ${i.proposed_run})` : ''}.` : '',
    i.recommend_note ? `Manager: ${i.recommend_note}` : '',
    i.status === 'discarded' && i.discard_reason ? `Discarded: ${i.discard_reason}` : '',
  ].filter(Boolean).join('\n');
  const show = (verb, i) => console.log(`${verb} ${line(i)}${notes(i) ? `\n      ${notes(i).replace(/\n/g, '\n      ')}` : ''}`);
  const which = () => {
    if (!args[0]) throw new Error(`Which item? node src/cli.mjs plan ${action} <n>`);
    return Number(args[0].replace(/^#/, ''));
  };
  // Through the running Chiefmate, else here.
  const change = async body => (await apiOr('/api/planning', body, async () => ({ item: await planning.changePlan(body) }))).item;
  // The manager triages and the owner decides: a step of a run only proposes.
  const decided = ['proposed', 'triaged', 'approved', 'discarded'];
  if (process.env.CHIEFMATE_RUN && (['triage', 'approve', 'later', 'discard', 'restore', 'order'].includes(action)
    || (['add', 'set'].includes(action) && option('--status') && decided.includes(planning.parseStatus(option('--status')))))) {
    throw new Error('A step of a run only proposes items: node src/cli.mjs plan propose <project> "<title>" --summary "..." --agent <member>.');
  }
  const by = process.env.CHIEFMATE_MANAGER ? 'manager' : option('--by');
  switch (action) {
    case 'propose': {
      const [project, ...title] = args;
      const item = await change({
        action: 'propose', project, title: title.join(' '), summary: option('--summary') ?? option('--description'), agent: option('--agent'),
        priority: option('--priority'), run: process.env.CHIEFMATE_RUN, step: process.env.CHIEFMATE_STEP, by,
      });
      show('Proposed', item);
      console.log('The manager triages it; the owner decides.');
      return;
    }
    case 'triage':
      show('Triaged', await change({ action: 'triage', id: which(), priority: option('--priority'), agent: option('--agent'), recommend: option('--recommend'), note: option('--note'), risk: option('--risk'), order: option('--order'), level: option('--level'), tool: option('--tool') }));
      return;
    case 'approve':
    case 'later':
      show(action === 'approve' ? 'Approved' : 'Later', await change({ action, id: which(), by, ...(action === 'approve' && has('--autopilot') ? { autopilot: true } : {}), ...(action === 'approve' ? { tool: option('--tool') } : {}) }));
      return;
    case 'discard': {
      const duplicate = option('--duplicate-of');
      const reason = [duplicate ? `Duplicate of #${duplicate.replace(/^#/, '')}` : '', option('--reason') ?? ''].filter(Boolean).join(': ');
      show('Discarded', await change({ action: 'discard', id: which(), reason, by }));
      return;
    }
    case 'restore':
      show('Restored', await change({ action: 'restore', id: which() }));
      return;
    case 'order': {
      const ids = args.map(x => Number(x.replace(/^#/, '')));
      if (!ids.length) throw new Error('Which items, in which order? node src/cli.mjs plan order <n> <n> ...');
      for (const i of await change({ action: 'reorder', ids })) show('Order', i);
      return;
    }
    case 'list': {
      const status = option('--status') && planning.parseStatus(option('--status'));
      const priority = option('--priority') && planning.parsePriority(option('--priority'));
      const project = option('--project');
      const items = planning.planItems().filter(i =>
        (has('--all') || status || (!i.archived && !planning.CLOSED.includes(i.status))) && (!i.archived || has('--all'))
        && (!status || i.status === status) && (!priority || i.priority === priority) && (!project || i.project === project));
      for (const i of items) console.log(line(i));
      if (!items.length) console.log('No items on the planning board for this filter. Add one: node src/cli.mjs plan add <project> "<title>"');
      return;
    }
    case 'add': {
      const [project, ...title] = args;
      show('Added', await change({ action: 'add', ...fields(), project, title: title.join(' ') }));
      return;
    }
    case 'set': {
      if (!args[0]) throw new Error('Which item? node src/cli.mjs plan set <n> --status <s>');
      let item = await change({ action: 'set', id: args[0], ...fields() });
      if (has('--archive') || has('--restore')) item = planning.archiveItem(args[0], has('--archive'));
      show('Changed', item);
      return;
    }
    case 'done':
      if (!args[0]) throw new Error('Which item? node src/cli.mjs plan done <n>');
      show('Done', await change({ action: 'set', id: args[0], status: 'done' }));
      return;
    default:
      throw new Error('Use: plan [list] | add <project> "<title>" | set <n> [--status ...] | done <n> | propose <project> "<title>" | triage <n> | approve|later|discard|restore <n> | order <n> <n> ...');
  }
}

/** "radar": the project radar (src/radar.mjs), fed by the manager and a weekly mission; the owner decides. */
async function radarCommand() {
  const radar = await import('./radar.mjs');
  const keys = ['title', 'summary', 'problem', 'audience', 'market', 'trend', 'revenue', 'advantage', 'risks', 'potential', 'effort', 'risk', 'source', 'competitor', 'series', 'status', 'reason', 'project', 'file', 'by'];
  const [action = 'list', ...args] = rest.filter((x, i) => !x.startsWith('--') && !keys.includes(rest[i - 1]?.slice(2)));
  const all = name => rest.flatMap((x, i) => (x === name && rest[i + 1] !== undefined ? [rest[i + 1]] : []));
  const fields = async () => {
    const file = option('--file');
    const given = file ? JSON.parse((await import('node:fs')).readFileSync(path.resolve(file), 'utf8')) : {};
    for (const k of ['title', 'summary', 'problem', 'audience', 'market', 'trend', 'revenue', 'advantage', 'risks', 'potential', 'effort', 'risk', 'series', 'status', 'project']) {
      if (option(`--${k}`) !== undefined) given[k] = option(`--${k}`);
    }
    if (all('--source').length) given.sources = all('--source');
    if (all('--competitor').length) given.competitors = all('--competitor');
    return given;
  };
  const which = () => {
    if (!args[0]) throw new Error(`Which idea? node src/cli.mjs radar ${action} <n>`);
    return Number(args[0].replace(/^#/, ''));
  };
  const line = i => `#${String(i.id).padEnd(3)} ${i.status.padEnd(9)} potential ${i.scores.potential} effort ${i.scores.effort} risk ${i.scores.risk}  ${i.title}: ${i.summary}${i.plan ? `  [planning #${i.plan}]` : ''}${i.project ? `  [project ${i.project}]` : ''}`;
  const show = (verb, i) => console.log(`${verb} ${line(i)}`);
  // Through the running Chiefmate, else here.
  const change = async body => (await apiOr('/api/radar', body, async () => ({ idea: radar.changeRadar(body) }))).idea;
  // The crew researches and adds; the owner decides (the manager on the owner's word).
  if (process.env.CHIEFMATE_RUN && (['choose', 'later', 'discard', 'restore'].includes(action)
    || (action === 'set' && option('--status') && ['chosen', 'discarded', 'project'].includes(radar.parseRadarStatus(option('--status')))))) {
    throw new Error('A step of a run only adds and updates radar ideas: the owner decides (radar add, radar set <n>).');
  }
  const by = process.env.CHIEFMATE_MANAGER ? 'manager' : process.env.CHIEFMATE_RUN ? 'crew' : option('--by');
  switch (action) {
    case 'list': {
      const status = option('--status') && radar.parseRadarStatus(option('--status'));
      const ideas = radar.radarIdeas().filter(i => (status ? i.status === status : has('--all') || i.status !== 'discarded'));
      for (const i of ideas) console.log(line(i));
      if (!ideas.length) console.log('No ideas on the radar for this filter. Add one: node src/cli.mjs radar add "<title>" --summary ... --source ...');
      return;
    }
    case 'show': {
      const i = radar.radarIdea(which());
      const f = i.fundamentals;
      const links = list => list.map(l => `${l.name}${l.url ? ` ${l.url}` : ''}`).join('; ');
      console.log([
        line(i),
        i.problem && `Problem: ${i.problem}`, i.audience && `Audience: ${i.audience}`, f.market && `Market: ${f.market}`,
        f.competitors.length && `Competitors: ${links(f.competitors)}`, f.trend && `Trend: ${f.trend}`,
        i.series.length && `Series: ${i.series.map(p => `${p.label}:${p.value}`).join(', ')}`, f.revenue && `Revenue: ${f.revenue}`,
        f.advantage && `Advantage: ${f.advantage}`, f.risks && `Risks: ${f.risks}`, `Sources: ${links(i.sources)}`,
        `Added ${formatDateTime(i.created)} by ${i.by}${i.discard_reason ? `. Discarded: ${i.discard_reason}` : ''}`,
      ].filter(Boolean).join('\n      '));
      return;
    }
    case 'add': {
      const given = await fields();
      if (args.length) given.title = args.join(' ');
      show('Added', await change({ action: 'add', ...given, by }));
      return;
    }
    case 'set':
      show('Changed', await change({ action: 'set', id: which(), ...(await fields()), ...(option('--reason') !== undefined ? { reason: option('--reason') } : {}) }));
      return;
    case 'choose':
    case 'later':
    case 'discard':
    case 'restore': {
      const idea = await change({ action, id: which(), reason: option('--reason'), by: by ?? 'owner' });
      show({ choose: 'Chosen', later: 'In study', discard: 'Discarded', restore: 'Restored' }[action], idea);
      if (action === 'choose') console.log(`On the planning board as #${idea.plan}, for the manager to turn into a project.`);
      return;
    }
    default:
      throw new Error('Use: radar [list] | show <n> | add "<title>" --summary ... | set <n> ... | choose|later|discard|restore <n>');
  }
}

/** "session": opens, lists or ends the live sessions. */
async function sessionCommand() {
  const sessions = await import('./sessions.mjs');
  const [first, second] = rest.filter(x => !x.startsWith('--'));
  if (first === 'end') {
    if (!second) throw new Error('Which session? node src/cli.mjs session end <id>');
    const s = await apiOr('/api/session/end', { id: second }, () => sessions.endSession(second));
    console.log(`Session ${s.id} ended.`);
    return;
  }
  if (first === 'log') {
    // A session's history (data/sessions/<id>.jsonl): what the owner wrote, what the agent said and did.
    if (!second) throw new Error('Which session? node src/cli.mjs session log <id> [n]');
    const record = sessions.readSession(second);
    if (!record) throw new Error(`Session not found: ${second}`);
    const count = Number(rest.filter(x => !x.startsWith('--'))[2]) || 40;
    const { items } = sessions.sessionHistory(second, null, count);
    console.log(`${record.name} [${record.id}] (${record.tool}, ${record.mode === 'app' ? 'in the app' : 'in a window'}), ${record.status}, in ${record.cwd}`);
    if (record.mode !== 'app') console.log('A session in a window: its conversation stays in the tool itself, not in Chiefmate.');
    const who = { owner: 'Owner', say: 'Agent', action: '  >', note: '  *', permission: '  !' };
    for (const e of items) console.log(`${formatDateTime(e.at)} ${who[e.kind] ?? e.kind}${e.first ? ' (first message)' : ''}${e.failed ? ' (failed)' : ''}${e.kind === 'permission' ? ` [${e.status}]` : ''}: ${e.first ? `${e.text.length} characters, in data/sessions/${record.id}.md` : e.text}`);
    if (!items.length) console.log('No history yet.');
    return;
  }
  if (first === 'say') {
    // The manager writes to the owner's sessions only when the owner asks it to, and the message says so.
    const manager = !!process.env.CHIEFMATE_MANAGER;
    if (manager && !has('--owner-asked')) throw new Error("The manager writes to the owner's live sessions only when the owner asks: add --owner-asked only then.");
    const text = rest.filter(x => !x.startsWith('--')).slice(2).join(' ');
    if (!second || !text.trim()) throw new Error('Use: node src/cli.mjs session say <id> "<message>"');
    const m = await api('/api/session/say', { id: second, text, by: manager ? 'manager' : 'owner' });
    console.log(m.queued ? `Queued (${m.position} waiting): it goes when the agent finishes its turn.` : `Sent. Follow it with: node src/cli.mjs session log ${second}`);
    return;
  }
  if (!first) {
    // Through the running Chiefmate, which knows the processes (alive, memory); else from the records alone.
    const { profiles, open } = (await apiOr('/api/state', null, () => ({ sessions: sessions.sessionsState(loadConfig()) }))).sessions;
    for (const p of profiles) console.log(`Profile ${p.id}: ${p.name} (${p.tool}, ${p.project ? `project ${p.project}` : p.folder ? `library folder ${p.folder}` : 'its own folder'})${p.blocks.length ? `, blocks: ${p.blocks.join(', ')}` : ''}`);
    if (!profiles.length) console.log('No session profiles. Add them under "sessions" in config/chiefmate.json (see the README).');
    for (const x of open) console.log(`Open: ${x.name} [${x.id}] (${x.tool}, ${x.mode === 'app' ? 'in the app' : 'in a window'}), ${x.phase ?? x.status}${x.ram ? `, ${machineBytes(x.ram)}` : ''}, since ${formatDateTime(x.started)}`);
    return;
  }
  if (has('--dry-run')) {
    const config = loadConfig();
    const { profile, folder, prompt } = sessions.planSession(config, first);
    let command;
    try {
      const tool = sessions.toolCommand(profile.tool);
      command = [tool.command, ...tool.prefix].join(' ');
    } catch (error) {
      command = `(not found: ${error.message})`;
    }
    const window = has('--window');
    const args = window ? sessions.sessionArgs({ ...profile, cwd: folder.dir }, config, prompt.blocksGiven ? '<first message>' : null)
      : profile.tool === 'codex' ? sessions.codexArgs({ ...profile, cwd: folder.dir })
      : ['-p', '--output-format', 'stream-json', '--session-id', '<new>', '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: sessions.sessionMcp(config, profile).servers }), '--settings', '(with the guard, src/guard.mjs, before each command)', '--allowedTools', '(reading, editing, terminal)', ...sessions.sessionMcp(config, profile).tools, '--disallowedTools', ...sessions.ASK_FIRST];
    console.log(window ? 'In a window of its own.' : 'In the app: each message is one turn of the tool, resuming the same session; the message goes through standard input.');
    console.log(`Folder: ${folder.dir}${folder.copy ? " (Chiefmate's read-only copy of the library)" : ''}`);
    const mcp = sessions.sessionMcp(config, profile);
    if (profile.tool === 'claude') console.log(`External tools (MCP): ${mcp.names.join(', ') || '(none)'}${mcp.unknown.length ? ` (released but missing from "mcp_servers": ${mcp.unknown.join(', ')})` : ''}`);
    console.log(`Command: ${command} ${args.map(a => (/[\s"{}]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    if (prompt.missing.length) console.log(`Not found in the prompt builder: ${prompt.missing.join(', ')}`);
    if (prompt.unresolved?.length) console.log(`Variables left unfilled (no value in the prompt builder): ${prompt.unresolved.map(v => `{${v}}`).join(', ')}`);
    console.log(prompt.blocksGiven ? `\nFirst message (${prompt.text.length} characters):\n\n${prompt.text}` : '\nNo first message: the profile has no "prompt_blocks".');
    return;
  }
  const window = has('--window');
  // In the app, the turns run inside Chiefmate: it must be running.
  const s = window ? await apiOr('/api/session', { profile: first, origin: 'cli', window }, () => sessions.openSession(first, { origin: 'cli', window }))
    : await api('/api/session', { profile: first, origin: 'cli' });
  if (s.status === 'login') console.log(`Codex is not signed in: run "codex login" in a terminal. The session ${s.id} opens by itself once you are signed in (with Chiefmate running).`);
  else if (s.existing) console.log(`This profile already has a session open in the app: ${s.id}. Write to it with: node src/cli.mjs session say ${s.id} "<message>"`);
  else if (s.mode === 'app') console.log(`Session ${s.id} opened in the app, in ${s.cwd}. Follow it in the app, or with: node src/cli.mjs session log ${s.id}`);
  else console.log(`Session ${s.id} opened (${s.window === 'terminal' ? 'Windows Terminal' : 'PowerShell'}), in ${s.cwd}. First message: data/sessions/${s.id}.md`);
  if (s.missing?.length) console.log(`Not found in the prompt builder: ${s.missing.join(', ')}`);
}

/** The power mode, in one line. */
function powerLine(p) {
  if (p.mode === 'standby') return `Standby since ${formatDateTime(p.since)}: nothing new starts. Back on with: node src/cli.mjs power on --yes`;
  if (p.mode !== 'stopping') return 'On.';
  const what = p.target === 'shutdown' ? 'Shutting the computer down' : 'Stopping Chiefmate';
  const waiting = (p.waitingFor ?? []).map(w => `${w.title ?? w.run}${w.doing ? ` (${w.doing})` : ''}`);
  const stage = p.stage === 'pausing' ? `pausing the work going on at a safe point${waiting.length ? `; waiting for: ${waiting.join('; ')}` : ''}`
    : p.stage === 'manager' ? "ending the manager's answer"
      : p.stage === 'countdown' ? `the computer shuts down at ${formatDateTime(p.countdownUntil)}`
        : 'closing';
  return `${what}: ${stage}.${p.stage !== 'closing' ? ' To cancel: node src/cli.mjs power cancel' : ''}`;
}

/** "effort": each agent's effort, its changes and their history (src/effort.mjs). A step only reads it. */
async function effortCommand() {
  const { effortChangeLine, effortHistory, effortSource, parseEffort, setEffort } = await import('./effort.mjs');
  const { loadAgents, projectCrew } = await import('./config.mjs');
  const project = option('--project') ?? null;
  const [who, level] = words();
  const config = loadConfig();
  if (who === 'history') {
    const list = effortHistory(project ? { project } : {}).slice(-30);
    console.log(list.length ? list.map(effortChangeLine).join('\n') : 'No effort change recorded.');
    return;
  }
  if (project && !config.projects?.[project]) throw new Error(`Unknown project: ${project}`);
  if (level !== undefined) {
    if (!parseEffort(level)) throw new Error('Use: node src/cli.mjs effort <agent> low|medium|high|xhigh|max|default [--project <id>] [--chat]');
    if (process.env.CHIEFMATE_RUN && !process.env.CHIEFMATE_MANAGER) throw new Error("A step doesn't change the crew's effort: propose it for the planning board.");
    const by = process.env.CHIEFMATE_MANAGER ? 'manager' : 'owner';
    const e = setEffort({ member: who, level, project, chat: has('--chat'), by, config });
    console.log(e.changed ? `${effortChangeLine(e)}. Counts from the next step.` : `No change: ${who} is already at ${e.to ?? 'default'}.`);
    return;
  }
  const team = project ? projectCrew(config, project) : loadAgents(config);
  const members = Object.values(team).filter(a => !who || a.id === who);
  if (!members.length) throw new Error(`Unknown agent: ${who}`);
  const from = { project: `this project (projects.${project}.effort)`, member: "this project's crew setting", installation: 'this installation (crew)', agent: 'the agent file', none: "Claude Code's default for the model" };
  for (const a of members) {
    const chat = a.id === 'manager' ? `; conversation ${a.chat_effort ?? a.effort ?? 'default'}` : '';
    console.log(`${a.id.padEnd(12)} ${String(a.name ?? '').padEnd(16)} ${String(a.model ?? config.default_model ?? '').padEnd(18)} effort ${String(a.effort ?? 'default').padEnd(7)} from ${from[effortSource(config, project, a)]}${chat}`);
  }
}

/** "power": the power modes (src/power.mjs). Only the owner's: refused inside a step and the manager's answer. */
async function powerCommand() {
  const action = rest.find(x => !x.startsWith('--')) ?? 'status';
  if (action === 'status') return console.log(powerLine((await api('/api/state')).power ?? { mode: 'on' }));
  if (!['standby', 'on', 'stop', 'shutdown', 'cancel'].includes(action)) throw new Error('Use: node src/cli.mjs power [status|standby|on|stop|shutdown|cancel] [--yes]');
  if (process.env.CHIEFMATE_RUN || process.env.CHIEFMATE_MANAGER) throw new Error("The power modes are the owner's only: ask them with needs-you.");
  if (action === 'cancel') return console.log(powerLine(await api('/api/power', { action })));
  if (!has('--yes')) {
    const p = await api('/api/power', { action: 'preview' });
    const said = {
      standby: 'Standby: nothing new starts (the queue, the missions, the autopilot); the runs going on pause at a safe point; the live sessions go on.',
      on: 'Back on: the queue goes on, the paused runs first, and each mission missed meanwhile runs once.',
      stop: "Stop Chiefmate: everything pauses at a safe point, the crew's browsers and processes close and Chiefmate ends. The watchdog leaves it off; the next start resumes the work.",
      shutdown: 'Shut the computer down: as stop, then Windows shuts down after a 60-second countdown (cancel with: node src/cli.mjs power cancel).',
    };
    console.log(said[action]);
    if (p.runs.length) console.log(['Runs that pause at a safe point:', ...p.runs.map(r => `  ${r.title} [${r.run}] (${r.project})`)].join('\n'));
    if (['stop', 'shutdown'].includes(action)) {
      if (p.sessions.length) console.log(['Live sessions open (their turns pause; a window ends with the computer):', ...p.sessions.map(x => `  ${x.name} [${x.id}]`)].join('\n'));
      if (p.unsaved.length) console.log(['Changes not committed:', ...p.unsaved.map(u => `  ${u.folder}: ${u.files} file(s)`)].join('\n'));
    }
    console.log('Nothing was done. Add --yes to go ahead.');
    return;
  }
  console.log(powerLine(await api('/api/power', { action })));
}

/** What an update going on is doing, in one line. */
function updateLine(u) {
  const job = u.installing;
  if (!job) {
    if (u.blocked === 'changes') return "It can't be installed: Chiefmate's files were changed by hand in this installation.";
    if (u.blocked === 'merge') return "It can't be installed: this installation's branch has commits of its own.";
    if (u.blocked === 'checks') return 'It failed its checks, so Chiefmate stayed on the current version.';
    return u.mode === 'wait' ? 'It installs once the crew, the manager and the live sessions are free ("auto_update_mode": "wait").' : 'It installs on the next check.';
  }
  const paused = [
    job.paused?.length ? ` ${job.paused.length} run(s) paused for it resume after the restart.` : '',
    job.sessions?.length ? ` ${job.sessions.length} live session(s) paused for it carry on after the restart.` : '',
  ].join('');
  if (job.stage === 'pausing') {
    const waiting = (job.waitingFor ?? []).map(w => `${w.title ?? w.run}${w.doing ? ` (${w.doing})` : ''}`);
    return `Installing: pausing the runs and the live sessions' turns going on at a safe point${waiting.length ? `; waiting for: ${waiting.join('; ')}` : ''}.${paused}`;
  }
  if (job.stage === 'manager') return `Installing: waiting for the manager's answer to end${job.interruptManager ? ' (it is being interrupted)' : ''}.${paused}`;
  return `Installing the new version: Chiefmate checks it and restarts by itself.${paused}`;
}

/** The emergency lockdown in a few lines, for the terminal. */
function lockdownText(v) {
  if (!v.active) {
    const last = v.last ? `\nLast: ${formatDateTime(v.last.since)} to ${formatDateTime(v.last.until)}, ${v.last.reason}` : '';
    const warnings = v.warnings.map(w => `\nWarning ${formatDateTime(w.at)}: ${w.text}`).join('');
    return `Chiefmate is not locked down.${last}${warnings}`;
  }
  const stopped = Object.entries(v.stopped).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing';
  return [
    `EMERGENCY LOCKDOWN since ${formatDateTime(v.since)} (by ${v.by}, from ${v.from})`,
    `Reason: ${v.reason}`,
    `Stopped: ${stopped}`,
    ...v.evidence.map(e => `Evidence ${formatDateTime(e.at)} [${e.what}${e.who ? `, ${e.who}` : ''}]: ${e.detail}`),
  ].join('\n');
}

/** A command refused to a step of a run: noted for the emergency lockdown's detection (src/lockdown.mjs), then refused. */
async function crewRefused(what, message) {
  (await import('./lockdown.mjs')).recordSignal('publish_refused', `cli.mjs ${what}`, { who: 'step' });
  throw new Error(message);
}

const machineBytes = n => `${Math.round((n ?? 0) / 1024 ** 2)} MB`;

async function main() {
  switch (command) {
    case 'server': {
      // After a self-update, the new Chiefmate waits for the old one to leave (up to half a minute).
      if (process.env.CHIEFMATE_RESTART_DELAY) await sleep(Number(process.env.CHIEFMATE_RESTART_DELAY));
      if (has('--log')) await logToFile();
      for (let i = 0; process.env.CHIEFMATE_RESTART_DELAY && i < 28 && (await answers()); i++) await sleep(1000);
      if (await answers()) {
        console.log(`Chiefmate is already running at http://localhost:${port()}`);
        return;
      }
      const { startServer } = await import('./server.mjs');
      const { port: p, close } = startServer();
      if (!process.env.CHIEFMATE_SMOKE) (await import('./config.mjs')).backupConfig();
      // The smoke test only needs the app and the API: no queue, no schedule, no updates.
      if (!process.env.CHIEFMATE_SMOKE) {
        const { startQueue } = await import('./queue.mjs');
        const { startSchedule } = await import('./schedule.mjs');
        const { startUpdates } = await import('./update.mjs');
        const { doingNow, live, pauseAll } = await import('./runs.mjs');
        const { nudgeQueue } = await import('./queue.mjs');
        const { pauseSessionTurns, resumeSessions, sessionTurnsGoingOn, startSessions } = await import('./sessions.mjs');
        const { chat, deliverPending, interruptManager, managerBusy } = await import('./manager.mjs');
        const { startWatch } = await import('./plan.mjs');
        const { startAutopilot } = await import('./autopilot.mjs');
        const { powerOffCommand, startPower } = await import('./power.mjs');
        const { updating } = await import('./update.mjs');
        // In "pause" mode (and on "update now") the update pauses the runs and the live sessions' turns going on and
        // waits for the manager's answer; in "wait" mode, it waits for all of them to end. The sessions' windows stay open.
        // The power modes (src/power.mjs) pause the same way.
        const pausing = {
          crewBusy: () => live.size > 0,
          crewWaiting: () => [...live.values()].map(l => ({ run: l.run, title: l.title, project: l.project, doing: doingNow(l) })),
          sessionsBusy: sessionTurnsGoingOn,
          pauseSessions: why => pauseSessionTurns(why),
          managerAnswering: () => chat.responding,
          interruptManager,
          resume: () => {
            nudgeQueue();
            deliverPending();
            resumeSessions();
          },
        };
        startPower({
          ...pausing,
          pauseRuns: why => pauseAll(why),
          updating,
          closeBrowsers: async () => (await import('./browsers.mjs')).closeAllBrowsers(),
          stopCrew: async () => {
            if (process.platform !== 'win32') return;
            const { crewUnder, processList, stopPids } = await import('./watch.mjs');
            await stopPids(crewUnder(process.pid, await processList()).map(p => p.pid));
          },
          powerOff: () => powerOffCommand(),
          // A connection slow to close must not keep Chiefmate alive.
          finish: async () => {
            await Promise.race([close(), sleep(10_000)]);
            process.exit(0);
          },
        });
        startQueue();
        startSchedule();
        startWatch();
        startAutopilot();
        startSessions();
        startUpdates({
          ...pausing,
          isBusy: () => live.size > 0 || managerBusy() || sessionTurnsGoingOn(),
          pauseRuns: () => pauseAll('update'),
          beforeRestart: close,
        });
        // The emergency lockdown (src/lockdown.mjs): what it stops, what a release resumes, and who is told.
        const lockdown = await import('./lockdown.mjs');
        const { cancelLive } = await import('./runs.mjs');
        const { stopSessionTurns } = await import('./sessions.mjs');
        const { closeBrowser, findBrowsers } = await import('./browsers.mjs');
        const { processes } = await import('./machine.mjs');
        const { reportEvent } = await import('./news.mjs');
        const { t } = await import('./i18n.mjs');
        lockdown.setLockdownHooks({
          stopAll: async () => {
            const runs = [...live.keys()].filter(id => {
              live.get(id)?.preparing?.abort();
              return cancelLive(id, t('stopped by the emergency lockdown'));
            }).length;
            const manager = interruptManager() ? 1 : 0;
            const sessions = stopSessionTurns();
            let browsers = 0;
            try {
              const { list } = await processes(0);
              for (const b of findBrowsers(loadConfig(), list ?? [])) {
                await closeBrowser(b.pid).catch(() => null);
                browsers++;
              }
            } catch {
              // listed on Windows only
            }
            return { runs, manager, sessions, browsers };
          },
          resume: () => {
            nudgeQueue();
            deliverPending();
            resumeSessions();
          },
          tell: ({ kind, title, text, news }) => {
            notify(title, text, 'chiefmate:operations', { urgent: true });
            reportEvent(kind, news ?? text, { urgent: true });
          },
        });
        lockdown.startLockdownWatch();
        deliverPending(); // messages left in the queue when Chiefmate stopped
        (await import('./news.mjs')).startNews(); // and the news for the manager, such as "update installed"
      }
      console.log(`Chiefmate running at http://localhost:${p} (${new Date().toISOString()})`);
      return;
    }
    case 'status': {
      const s = await api('/api/state');
      const account = s.usage.account;
      const percent = v => `${Math.round((v ?? 0) * 100)}%`;
      const going = s.running ?? (s.current ? [s.current] : []);
      if (s.power && s.power.mode !== 'on') console.log(`Power: ${powerLine(s.power)}`);
      if (!going.length) console.log('Running: nothing');
      for (const r of going) console.log(`Running: ${r.title} [${r.id}] (${r.project}), step ${r.step ?? '-'}: ${r.agent ?? 'preparing'}`);
      for (const x of s.sessions?.open ?? []) console.log(`Session: ${x.name} [${x.id}] (${x.tool}${x.project ? `, ${x.project}` : ''}), ${x.alive ? 'open' : x.status} since ${formatDateTime(x.started)}`);
      console.log(`Queue: ${s.queue.map(r => `${r.title} [${r.id}]`).join('; ') || 'empty'}`);
      console.log(`Account: 5-hour window ${percent(account.five_hour?.used)}, plan week ${percent(account.seven_day?.used)}`);
      console.log(`Claude Code: ${s.ai.claude.found ? s.ai.claude.version : 'not found'}`);
      console.log(`Chiefmate ${s.version}${s.update.waiting ? `, update waiting (${s.update.waiting} change(s))` : ''}`);
      for (const m of s.missions) console.log(`Mission ${m.id} (${m.project}): ${m.schedule}${m.next ? `, next ${formatDateTime(m.next)}` : ''}`);
      for (const a of s.crew) console.log(`Crew ${a.id}: ${a.status}${a.run ? ` (${a.run})` : ''}, ${a.tool && a.tool !== 'claude' ? `${a.tool}${a.model ? ` ${a.model}` : ''}` : a.model}${a.toolReason === 'expired' ? ` (${a.toolAsked} expired ${a.toolUntil})` : ''}`);
      return;
    }
    case 'tools': {
      // Read here: the records are a file of their own, with or without Chiefmate running.
      const { qualitySummary, TOOL_NAMES } = await import('./tools.mjs');
      const summary = qualitySummary();
      if (has('--json')) return console.log(JSON.stringify(summary, null, 2));
      const percent = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
      const minutes = ms => (ms ? `${Math.round(ms / 60000)} min` : '-');
      const row = (name, x) => `${name}: ${x.count} step(s), ${percent(x.clean, x.count)} approved with no correction, ${x.corrected} corrected by the review, ${x.failed} failed, mean ${minutes(x.meanMs)}`;
      for (const x of summary) {
        console.log(row(TOOL_NAMES[x.tool], x));
        for (const k of x.kinds) console.log(`  ${row(k.kind, k)}`);
      }
      if (!summary.some(x => x.count)) console.log('No step has run on Codex or Grok yet: Claude Code does the work by default (--tool on task, ask, mission and plan).');
      return;
    }
    case 'mission': {
      const run = await api('/api/mission', { mission: words()[0], origin: option('--origin') ?? 'manager', plan: option('--plan'), ...brief() });
      console.log(`Queued: ${run.title} [${run.id}]`);
      return;
    }
    case 'task': {
      const [project, agent, instruction] = words();
      const modules = (option('--modules') ?? '').split(',').map(m => m.trim()).filter(Boolean);
      const run = await api('/api/task', { project, agent, instruction, review: has('--review'), modules, origin: option('--origin') ?? 'manager', plan: option('--plan'), ...brief() });
      console.log(`Queued: ${run.title} [${run.id}]`);
      return;
    }
    case 'ask': {
      const [project, request] = words();
      const run = await api('/api/ask', { project, request, origin: option('--origin') ?? 'manager', plan: option('--plan'), ...brief() });
      console.log(`Queued: ${run.title} [${run.id}]. The team lead plans it into at most 3 tasks for the crew.`);
      return;
    }
    case 'level': {
      // The manager's approval level for a run: what its decision card says (src/decisions.mjs).
      const [id, value] = rest.filter(x => !x.startsWith('--'));
      if (!id || value === undefined) throw new Error('Use: node src/cli.mjs level <run id> <1|2|3|none>');
      const r = await apiOr('/api/level', { run: id, level: value }, async () => {
        const { setRunLevel } = await import('./runs.mjs');
        const run = setRunLevel(id, value);
        return { run: run.id, title: run.title, level: run.level };
      });
      console.log(r.level ? `Level ${r.level}: ${r.title} [${r.run}]` : `No level: ${r.title} [${r.run}]`);
      return;
    }
    case 'chat':
      await chatCommand();
      return;
    case 'ask-owner': {
      // The manager's (or the owner's) question; a step of a run asks with needs-you instead.
      if (process.env.CHIEFMATE_RUN && !process.env.CHIEFMATE_MANAGER) throw new Error('A step of a run asks the owner with needs-you.');
      const question = rest.find((x, i) => !x.startsWith('--') && !['--context', '--options', '--recommend', '--project', '--level'].includes(rest[i - 1]));
      if (!question) throw new Error('Which question? node src/cli.mjs ask-owner "<question>" --context "<explanation>" --options "Yes|No|Wait"');
      const q = (await api('/api/ask-owner', { question, context: option('--context'), options: option('--options'), recommend: option('--recommend'), project: option('--project'), level: option('--level') })).question;
      console.log(`Question #${q.id} is waiting for the owner in the app: ${q.question} [${q.options.join(' | ')}]${q.recommend ? ` (recommended: ${q.recommend})` : ''}`);
      console.log('The answer comes back to you as "owner_decided" news. Do not ask it again in the conversation.');
      return;
    }
    case 'plan':
      await planCommand();
      return;
    case 'request':
      await requestCommand();
      return;
    case 'radar':
      await radarCommand();
      return;
    case 'cancel':
      console.log((await api('/api/cancel', { id: rest[0] })).status);
      return;
    case 'resume':
      console.log((await api('/api/resume', { id: rest[0], ignoreLimits: has('--ignore-limits') })).status);
      return;
    case 'history':
      for (const r of listRuns().slice(0, Number(rest[0]) || 10)) {
        console.log(`${formatDateTime(r.created)}  ${r.status.padEnd(9)} ${work(r).padStart(10)}  ${r.title} [${r.id}]${r.pullRequest ? `  ${r.pullRequest}` : ''}`);
      }
      return;
    case 'report': {
      const run = readRun(rest[0]);
      if (!run) throw new Error('Run not found.');
      console.log(`# ${run.title} (${run.status})\n${run.summary ? `${run.summary}\n` : ''}${run.result ?? ''}${run.pullRequest ? `\nPull request: ${run.pullRequest}` : ''}\n`);
      if (run.outcome) console.log(`${outcomeMarkdown(run.outcome, run.outcome.lang)}\n`);
      const { effortChangeLine, runEffortChanges } = await import('./effort.mjs');
      const changes = runEffortChanges(run).map(e => `- ${effortChangeLine(e)}`);
      if (changes.length) console.log(`Effort changed during the run:\n${changes.join('\n')}\n`);
      for (const step of stepsOf(run)) {
        console.log(`## ${step.agent} (${step.status}, ${formatDuration(step.durationMs)}, ${step.model ?? ''}${step.started ? `, effort ${step.effort ?? 'default'}` : ''})\n${fullReport(step) || step.error || '(no report)'}\n`);
      }
      return;
    }
    case 'context': {
      const { readdirSync, readFileSync } = await import('node:fs');
      const { runDir } = await import('./store.mjs');
      if (!rest[0] || !readRun(rest[0])) throw new Error('Run not found. Use: context <id> [step]');
      const dir = runDir(rest[0]);
      const prefix = rest[1] ? `${String(Number(rest[1])).padStart(2, '0')}-` : '';
      const files = readdirSync(dir).filter(f => f.endsWith('.context.md') && f.startsWith(prefix)).sort();
      if (!files.length) throw new Error('No context recorded for this run or step (runs from before this version have none).');
      for (const f of files) console.log(`${readFileSync(`${dir}/${f}`, 'utf8')}\n`);
      return;
    }
    case 'project-context': {
      // Put together here, from the settings, the same way the runs do (src/context.mjs): nothing runs or opens.
      const { contextText, projectContext } = await import('./context.mjs');
      const [project, member] = rest.filter(x => !x.startsWith('--'));
      if (!project) throw new Error('Which project? node src/cli.mjs project-context <project> [member]');
      const context = projectContext(loadConfig(), project, { member: member ?? null });
      console.log(has('--json') ? JSON.stringify(context, null, 2) : contextText(context, { full: !has('--short') }));
      return;
    }
    case 'needs-you':
      await needsYou();
      return;
    case 'session':
      await sessionCommand();
      return;
    case 'session-run': {
      // Inside the session's window (see src/sessions.mjs).
      const { runSession } = await import('./sessions.mjs');
      await runSession(rest[0]);
      return;
    }
    case 'dev': {
      const projects = await import('./projects.mjs');
      const [first, second] = rest.filter(x => !x.startsWith('--'));
      const stop = first === 'stop';
      const id = stop ? second : first;
      if (!id) throw new Error('Which project? node src/cli.mjs dev <project> | dev stop <project>');
      const body = { project: id, action: stop ? 'stop' : 'start', dryRun: has('--dry-run') };
      const local = () => (stop ? projects.stopDev(id, body) : projects.startDev(id, body));
      const r = await apiOr('/api/project/dev', body, local);
      if (r.dryRun && !stop) console.log(`Would run, in a window of its own:\n  ${r.command}\nin ${r.cwd}`);
      else if (r.dryRun) console.log(r.pids.length ? `Would stop the window process(es) ${r.pids.join(', ')} and everything under them.` : 'Nothing running.');
      else if (stop) console.log(r.stopped ? 'Development environment stopped.' : 'Nothing running.');
      else console.log(`Development environment started (${r.window === 'terminal' ? 'Windows Terminal' : 'PowerShell'}): ${r.command}, in ${r.cwd}`);
      return;
    }
    case 'dev-run': {
      // Inside the development environment's window (see src/projects.mjs).
      const { runDev } = await import('./projects.mjs');
      await runDev(rest[0]);
      return;
    }
    case 'prompts-sync': {
      const { syncPrompts } = await import('./promptsync.mjs');
      const status = await apiOr('/api/prompts-sync', {}, () => syncPrompts());
      if (!status.ok) throw new Error(status.error);
      if (status.source === 'library') {
        const c = status.commit;
        console.log(`Prompt builder: the library's copy updated (${status.bytes} bytes).${c ? ` Last change ${formatDateTime(c.date)}${c.approximate ? ' or earlier' : ''}: ${c.subject} (${c.hash.slice(0, 7)}).` : ''}`);
      } else if (status.source === 'google') console.log(`Prompt builder copied from Google Docs at ${formatDateTime(status.synced_at)} (${status.bytes} bytes).`);
      else console.log(`Prompt builder: the file on this computer read again (${status.bytes} bytes).`);
      return;
    }
    case 'limits': {
      const map = { '--window-5h': 'pause_at_5h_window', '--plan-week': 'pause_at_plan_week' };
      const changes = Object.fromEntries(Object.entries(map).filter(([o]) => option(o) !== undefined).map(([o, key]) => [key, Number(option(o))]));
      if (Object.keys(changes).length) {
        try {
          await api('/api/limits', changes);
        } catch {
          const config = loadConfig();
          config.limits = { ...config.limits, ...changes };
          saveConfig(config);
        }
      }
      console.log(JSON.stringify(loadConfig().limits, null, 2));
      return;
    }
    case 'ram': {
      const machine = await import('./machine.mjs');
      const c = await apiOr('/api/computer', null, async () => (await machine.processes(0), machine.computer()));
      const { formatBytes } = machine;
      const state = { agent: 'crew at work', running: 'running on this computer', session: 'live session', queued: 'in the queue', stopped: 'stopped' };
      console.log(`Free memory: ${Math.round((c.memory.free / c.memory.total) * 100)}% (${formatBytes(c.memory.free)} of ${formatBytes(c.memory.total)})`);
      console.log(`Chiefmate itself: ${formatBytes(c.chiefmate.ram)}`);
      if (!c.supported) console.log("The projects' processes are read on Windows only.");
      if (c.error) console.log(`Couldn't read the processes: ${c.error}`);
      for (const p of c.projects) {
        console.log(`${p.id.padEnd(16)} ${state[p.state].padEnd(25)} ${formatBytes(p.ram).padStart(8)}  ${p.processes.length} process(es)`);
        for (const x of p.processes) console.log(`    ${String(x.pid).padStart(6)} ${formatBytes(x.ram).padStart(8)}  ${x.name}${x.crew ? ' (crew)' : ''}${x.session ? ' (session)' : ''}${x.guarded ? ' (kept)' : ''}  ${x.command}`);
      }
      return;
    }
    case 'merge': {
      // Never from a step of a run: only the owner authorizes a merge, from the app or through the manager.
      if (process.env.CHIEFMATE_RUN && !process.env.CHIEFMATE_MANAGER) await crewRefused('merge', 'The crew never merges: only the owner authorizes a merge.');
      const id = rest[0];
      if (!id || id.startsWith('--')) throw new Error('Which run? node src/cli.mjs merge <id> [--yes]');
      if (!has('--yes')) {
        const m = await api('/api/merge', { run: id, preview: true });
        console.log(`${m.title} [${m.run}], project ${m.project}`);
        console.log(m.kind === 'pr' ? `Pull request: ${m.url}` : `Branch ${m.branch} into ${m.base}, in ${m.dir} (nothing is sent to GitHub)`);
        console.log(m.failedChecks ? `${m.failedChecks} check(s) failed.` : 'The checks passed.');
        console.log(m.verdict ? `Review's verdict:\n${m.verdict}` : 'No review verdict was found.');
        console.log("Nothing was merged. Add --yes only with the owner's explicit yes for this run.");
        return;
      }
      const m = await api('/api/merge', { run: id, by: process.env.CHIEFMATE_MANAGER ? 'manager' : 'owner' });
      if (m.discarded || m.merged.by === 'outside') {
        console.log(m.discarded ? `Local branch deleted: ${m.branch}.` : `Branch already merged: ${m.branch}.`);
        return;
      }
      console.log(m.kind === 'pr' ? `Merged: ${m.url}.` : `Merged: ${m.branch} into ${m.base}, in ${m.dir}. Nothing was sent to GitHub.`);
      if (m.copies?.done?.length) console.log(`Updated after the merge: ${m.copies.done.join(', ')}.`);
      if (m.copiesNote) console.log(`Not updated: ${m.copiesNote}`);
      return;
    }
    case 'close-pr': {
      // Never from a step of a run: the crew doesn't close pull requests.
      if (process.env.CHIEFMATE_RUN && !process.env.CHIEFMATE_MANAGER) await crewRefused('close-pr', 'The crew never closes pull requests.');
      const id = rest[0];
      const newer = option('--replaced-by');
      if (!id || id.startsWith('--') || !newer) throw new Error('Which runs? node src/cli.mjs close-pr <run> --replaced-by <newer run> [--yes]');
      const c = await api('/api/close-pr', { run: id, replacedBy: newer, preview: !has('--yes'), by: process.env.CHIEFMATE_MANAGER ? 'manager' : 'owner' });
      if (!has('--yes')) {
        console.log(`${c.title} [${c.run}], project ${c.project}: ${c.url}`);
        console.log(`Replaced by ${c.newTitle} [${c.replacedBy}]: ${c.newUrl} (${c.why}).`);
        console.log('Nothing was closed. Add --yes to close it on GitHub with a comment naming the new one.');
        return;
      }
      console.log(`Closed: ${c.url}, replaced by ${c.newUrl}. Its branch stays; it can be reopened on GitHub.`);
      return;
    }
    case 'push': {
      // Only the push the owner allowed the manager on its card (src/decisions.mjs), once: never from a step of a run.
      if (process.env.CHIEFMATE_RUN && !process.env.CHIEFMATE_MANAGER) await crewRefused('push', 'The crew never pushes: Chiefmate does that at the end of a run.');
      (await import('./lockdown.mjs')).refuseWhileLocked('push');
      const [dir, branch] = words();
      if (!dir || !branch) throw new Error('Which folder and branch? node src/cli.mjs push <folder> <branch>');
      const { pushesFile } = await import('./decisions.mjs');
      const { grantFor, pushFacts, readPushes, samePath, takeGrant } = await import('./guard.mjs');
      const asked = readPushes(pushesFile()).find(g => g.status === 'allowed' && Date.parse(g.expires) > Date.now() && g.branch === branch && samePath(g.dir, dir));
      const target = asked && { dir: asked.dir, remote: asked.remote, src: asked.src, branch: asked.branch };
      // The facts again, now: the remote may point elsewhere since the card, or the branch have become the default one.
      const facts = target ? pushFacts(target) : null;
      if (!target || !grantFor([asked], target, facts) || !takeGrant(pushesFile(), target, facts)) {
        throw new Error(`The owner has not allowed a push of ${branch} from ${dir} now (or it expired, or was used). Try the push itself (git -C <folder> push <remote> <branch>): the owner gets a card to allow it once.`);
      }
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync('git', ['-C', target.dir, 'push', target.remote, `${target.src}:refs/heads/${target.branch}`], { stdio: 'inherit', windowsHide: true });
      if (r.status !== 0) throw new Error(`The push failed (git exit ${r.status ?? r.error?.message}). The grant was used: try the push again to ask the owner once more.`);
      console.log(`Pushed ${target.branch} to ${facts.repo}.`);
      return;
    }
    case 'repo-create': {
      // A private repository for a local folder, created only once the owner allows it on its card (src/decisions.mjs).
      if (process.env.CHIEFMATE_RUN && !process.env.CHIEFMATE_MANAGER) await crewRefused('repo-create', 'The crew never creates repositories: ask the owner with needs-you.');
      const [name] = words();
      if (!name || !option('--from')) throw new Error('Which name and folder? node src/cli.mjs repo-create <name> --private --from <folder> [--description "<text>"]');
      const visibility = has('--public') || has('--internal') ? 'public' : has('--private') ? 'private' : '';
      const { repoCreate } = await import('./decisions.mjs');
      const r = repoCreate({ name, from: option('--from'), description: option('--description') ?? '', visibility });
      if (r.created) {
        console.log(`Created the private repository ${r.created.repo} (${r.created.url}); ${r.created.dir} has it as "origin" and its branch ${r.created.branch} was sent.`);
        console.log(`Later pushes follow the usual rules. For a project of Chiefmate in this folder, its "repository" setting can now be "${r.created.repo}".`);
      } else {
        console.log(`${r.again ? 'Still waiting' : 'Waiting'} for the owner's card in the app: the private repository ${r.request.repo}, with ${r.request.dir} (branch ${r.request.branch}) sent to it.`);
        console.log('Nothing was created. When the owner allows it ("repo_allowed" news), run the same command again, once, within 30 minutes.');
      }
      return;
    }
    case 'power': {
      await powerCommand();
      return;
    }
    case 'effort':
      await effortCommand();
      return;
    case 'update-check': {
      const u = await api('/api/update-check', {});
      if (!u.waiting) console.log(`Chiefmate ${(await api('/api/health')).version} is up to date.`);
      else console.log(`An approved update is waiting (${u.waiting} change(s)). ${updateLine(u)}`);
      return;
    }
    case 'lockdown': {
      // The emergency lockdown (src/lockdown.mjs): "lockdown status" shows it; "lockdown [reason]" engages it at once.
      const lockdown = await import('./lockdown.mjs');
      if (words()[0] === 'status') return console.log(lockdownText(lockdown.lockdownView()));
      const reason = words().join(' ').trim();
      const by = process.env.CHIEFMATE_MANAGER ? 'manager' : process.env.CHIEFMATE_RUN ? 'step' : 'owner';
      // Without Chiefmate running, only the state is written: it holds from its next start.
      const state = await apiOr('/api/lockdown', { action: 'engage', reason, by, origin: 'cli' }, () => lockdown.engage({ reason, by, from: 'cli' }));
      console.log(lockdownText(state.lockdown ?? lockdown.lockdownView(state)));
      return;
    }
    case 'unlock': {
      // Only the owner, at this computer's terminal: never a step, the manager or the rescuer, never a command with no
      // terminal (what an agent runs), and after reading what triggered it.
      if (process.env.CHIEFMATE_RUN || process.env.CHIEFMATE_MANAGER || process.env.CHIEFMATE_RESCUER) throw new Error('Only the owner releases the emergency lockdown, in the app or in a terminal on this computer.');
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run "node src/cli.mjs unlock" yourself, in a terminal on this computer: it asks you to confirm.');
      const lockdown = await import('./lockdown.mjs');
      const view = lockdown.lockdownView();
      if (!view.active) return console.log('Chiefmate is not locked down.');
      console.log(lockdownText(view));
      const { createInterface } = await import('node:readline/promises');
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const typed = (await prompt.question('\nType UNLOCK to release it (anything else keeps it): ')).trim();
      prompt.close();
      if (typed !== 'UNLOCK') return console.log('Kept locked down.');
      await apiOr('/api/lockdown', { action: 'release', confirm: true, origin: 'cli' }, () => lockdown.release({ by: 'owner', from: 'cli' }));
      console.log('Released. The queue goes on; the runs the lockdown stopped stay canceled until you resume them.');
      return;
    }
    case 'update-now': {
      if (has('--interrupt-manager') && process.env.CHIEFMATE_MANAGER) throw new Error("The manager can't interrupt its own answer: run update-now without --interrupt-manager.");
      const s = await api('/api/state');
      if (s.update.installing) {
        if (has('--interrupt-manager')) await api('/api/update-now', { interruptManager: true });
        console.log(updateLine({ ...s.update, installing: { ...s.update.installing, interruptManager: s.update.installing.interruptManager || has('--interrupt-manager') } }));
        return;
      }
      const going = s.running ?? [];
      if (!has('--yes')) {
        console.log(s.update.waiting ? `An approved update is waiting (${s.update.waiting} change(s); run update-check first for the latest).` : 'No approved update was seen yet: update-now looks for one first.');
        if (!going.length) console.log('No run is going on.');
        else console.log(['These runs would pause at a safe point and resume after the restart:', ...going.map(r => `  ${r.title} [${r.id}], step ${r.step ?? '-'}: ${r.agent ?? 'preparing'}`)].join('\n'));
        if (s.manager.responding) console.log(`The manager is answering: the update waits for the answer to end${has('--interrupt-manager') ? ' (with --interrupt-manager, it is interrupted)' : ' (add --interrupt-manager to interrupt it)'}.`);
        console.log('Nothing was done. Add --yes to update now.');
        return;
      }
      const u = await api('/api/update-now', { interruptManager: has('--interrupt-manager') });
      console.log(updateLine(u));
      return;
    }
    case 'stop-project': {
      const id = rest[0];
      if (!id) throw new Error('Which project? node src/cli.mjs stop-project <id> [--yes]');
      const machine = await import('./machine.mjs');
      const { processes } = await apiOr('/api/stop-project', { project: id, preview: true }, async () => ({ processes: await machine.stoppable(id) }));
      if (!processes.length) {
        console.log(`Nothing of ${id} to stop on this computer.`);
        return;
      }
      console.log(`${has('--yes') ? 'Stopping' : 'These would stop'}:`);
      for (const x of processes) console.log(`  ${String(x.pid).padStart(6)} ${machine.formatBytes(x.ram).padStart(8)}  ${x.name}  ${x.command}`);
      if (!has('--yes')) {
        console.log('Nothing was stopped. Add --yes to stop them.');
        return;
      }
      const pids = processes.map(x => x.pid);
      const { stopped } = await apiOr('/api/stop-project', { project: id, pids }, async () => ({ stopped: await machine.stopProject(id, pids) }));
      console.log(`Stopped ${stopped.length} process(es).`);
      return;
    }
    case 'reset-grant': {
      const { changeResets, planResets } = await import('./plan.mjs');
      const [action = 'list', ...args] = rest;
      let list;
      if (action === 'list') list = planResets();
      else if (action === 'add') list = changeResets({ action, expires: args[0], note: args.slice(1).join(' ') });
      else if (action === 'used' || action === 'remove') list = changeResets({ action, index: args[0] });
      else throw new Error('Use: reset-grant [list] | add <expires> ["<note>"] | used <n> | remove <n>');
      for (const g of list) {
        const status = g.used ? 'used' : g.available ? 'available' : 'expired';
        console.log(`${String(g.index).padStart(2)}. ${status.padEnd(9)} ${g.expires ? `expires ${formatDateTime(g.expires)}` : 'expiry unknown'}${g.note ? `  ${g.note}` : ''}${g.source === 'claude.ai' ? '  (read on claude.ai)' : ''}`);
      }
      if (!list.length) console.log('No free resets recorded.');
      return;
    }
    case 'claude-login': {
      const { openLogin, PROFILE_DIR } = await import('./usagepage.mjs');
      openLogin();
      console.log(`A browser window opened with Chiefmate's own profile (${PROFILE_DIR}).
Sign in to claude.ai there, then close the window.
The reading is off until you turn it on: node src/cli.mjs usage-reader on`);
      return;
    }
    case 'autopilot': {
      const autopilot = await import('./autopilot.mjs');
      const config = loadConfig();
      const changes = {};
      if (rest[0] === 'on' || rest[0] === 'off') changes.enabled = rest[0] === 'on';
      for (const [o, key] of [['--week-pace', 'week_pace'], ['--window-5h', 'stop_at_5h_window'], ['--quiet', 'quiet_hours'], ['--report', 'daily_report']]) if (option(o) !== undefined) changes[key] = option(o);
      // validated and saved as in the app (read again on every check: no restart needed)
      autopilot.changeAutopilot(changes, { config });
      console.log(JSON.stringify(config.autopilot ?? {}, null, 2));
      console.log(autopilot.autopilotLine(config));
      return;
    }
    case 'usage-reader': {
      const reader = await import('./usagepage.mjs');
      const action = rest[0];
      if (action === 'on' || action === 'off') {
        const config = loadConfig();
        config.usage_reader = { ...config.usage_reader, enabled: action === 'on' };
        saveConfig(config);
      } else if (action === 'now') {
        const start = Date.now() - 1000;
        await apiOr('/api/usage-reader', { read: true }, () => reader.readUsagePage());
        // Through the server, the reading goes on there: its result is written when it ends (wait up to two minutes).
        for (let i = 0; i < 120 && !(Date.parse(reader.readerStatus().attempted ?? '') >= start); i++) await new Promise(r => setTimeout(r, 1000));
      }
      const { enabled, everyHours } = reader.readerSettings();
      console.log(`Reading of claude.ai: ${enabled ? `on, every ${everyHours} h` : 'off'}${reader.signedIn() ? '' : ' (not signed in: node src/cli.mjs claude-login)'}`);
      console.log(JSON.stringify(reader.readerStatus(), null, 2));
      return;
    }
    case 'watch': {
      const { watchOnce } = await import('./watch.mjs');
      const r = await watchOnce({ dryRun: has('--dry-run') });
      if (has('--json')) {
        console.log(JSON.stringify({ health: r.health, problems: r.problems, orphans: r.orphans, rescue: r.rescue, told: r.told }, null, 2));
        return;
      }
      console.log(r.health ? 'Chiefmate answers.' : "Chiefmate doesn't answer.");
      for (const p of r.problems) console.log(`[${p.level}] ${p.text}`);
      if (!r.problems.length) console.log('No problem found.');
      if (r.rescue) console.log(`Rescuer: ${r.rescue.ok ? r.rescue.summary : `could not act (${r.rescue.error})`}${r.rescue.needs ? `\nNeeds you: ${r.rescue.needs}` : ''}`);
      else if (r.told.length) console.log('The owner and the manager were told.');
      return;
    }
    case 'rescue': {
      // The owner's and the rescuer's: never a step of a run, nor the manager (a restart would end its own answer).
      if ((process.env.CHIEFMATE_RUN || process.env.CHIEFMATE_MANAGER) && !process.env.CHIEFMATE_RESCUER) throw new Error("The rescue actions are the watchdog's rescuer's and the owner's only.");
      const watch = await import('./watch.mjs');
      const [action, ...args] = words();
      const dryRun = has('--dry-run');
      if (action === 'restart') {
        const r = await watch.rescueRestart({ dryRun });
        const what = `${r.stop ? `Chiefmate's server (process ${r.stop})` : 'nothing (Chiefmate was not running)'}${r.crew.length ? ` and the crew's processes under it: ${r.crew.join(', ')}` : ''}`;
        console.log(r.dryRun ? `Would stop ${what}, then start Chiefmate (${r.start}).` : `Stopped ${what}. Chiefmate ${r.started ? 'started and answers' : 'did not answer within a minute after starting'}.`);
      } else if (action === 'stop-orphans') {
        const list = await watch.rescueStopOrphans(args, { dryRun });
        if (!list.length) console.log('No orphan process found.');
        for (const p of list) console.log(`${dryRun ? 'Would stop' : 'Stopped'} ${p.name} ${p.pid} (${machineBytes(p.ram)}): ${p.command}`);
      } else if (action === 'resume') {
        if (!args[0]) throw new Error('Which run? node src/cli.mjs rescue resume <run>');
        const r = await watch.rescueResume(args[0], { dryRun });
        console.log(r.dryRun ? `Would resume ${r.run} (${r.status}).` : `Run ${r.run}: ${r.status}.`);
      } else throw new Error('Use: rescue restart | stop-orphans [<pid> ...] | resume <run> [--dry-run]');
      return;
    }
    case 'notify':
      notify(rest[0] ?? 'Chiefmate', rest[1] ?? 'Test notification.');
      return;
    default:
      console.log(HELP);
  }
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
