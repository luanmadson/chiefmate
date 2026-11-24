# Chiefmate

A command center for AI agents that runs on your own computer. On a merchant ship, the chief mate answers directly to the captain and runs the crew. Here, you are the captain.

- **The manager answers to you.** You talk to Chiefmate in plain language; it hands out the work, reviews it and reports back.
- **The crew works on your projects**, one agent at a time. Each one has a face, a role and a model you can see.
- **Usage stays under control**, with limits that Chiefmate enforces by itself.

Everything the crew produces reaches you as a **pull request**. Nothing goes live without your approval.

> Chiefmate runs [Claude Code](https://claude.com/claude-code) and uses your own Claude login and plan. It is an independent project, not made by Anthropic.

## What you get

- **An app window**, with no browser bar, and six sections:

  | Section | What it is for |
  |---|---|
  | **Manager** | Talk to Chiefmate. Ask how things are going, request a job, adjust the crew. It answers with the real situation: what is running, the queue, usage and your account's plan usage. |
  | **Operations** | What the crew is doing right now: the steps, the logbook (every action of the agent at work, with the time) and the queue. |
  | **Missions** | Complete jobs with their own schedule. "Run now" starts one at any time. |
  | **Crew** | Who is on board, what each one is doing and the model behind them. Give any of them a one-off task. |
  | **Log** | Every run, with each step's report, the checks and the pull request link. |
  | **Usage** | Your Claude account's usage and the limits Chiefmate respects. |

- **Crew portraits** that show at a glance who is standing by, working, thinking or waiting for a limit to reset. The title bar tells you whether Chiefmate is online and waiting for you.
- **Scheduled missions**, for example every Monday at 9:00. They wake the computer from sleep.
- **Windows notifications**: the evening before a mission, when a run starts, when it pauses for a limit and when it is ready for your review.
- **One-off tasks** for any agent, at any time.
- **A queue that runs one thing at a time**, so agents never set off other agents.
- **English and Brazilian Portuguese.**

## The crew

| Agent | Role |
|---|---|
| Chiefmate | The manager: talks with you, queues work, reviews every mission and keeps an eye on usage |
| Generalist | Any task in a project: fixing, adjusting, researching, organizing |
| Writer | Picks the topics and writes articles from research, with a source for every claim |
| Curator | Grows the project's database with new names, dates and links, always with a source |
| Designer | Improves the site for its readers: look, navigation, pages and accessibility |
| Promoter | How the pages look on Google, ready-to-post social media posts and promotion ideas |

Each agent is a Markdown file in `agents/`. Its header sets the name, model, budget per step, time limit, tools, color and face; the instructions come after it. Edit the file, or ask the manager to. Changes apply from the next run.

Every agent runs on **Claude Opus 5.5** by default.

## How a mission runs

```
queue ─► fresh working copy ─► the crew, one after another ─► manager's review ─► checks ─► pull request
```

1. **One at a time.** The queue runs one run at a time, so no agent sets off others in a chain.
2. **A working copy.** Each project has a copy of its own for the crew, in `workspaces/<project>`, refreshed from GitHub at the start of every run. Nobody touches the folder you work in.
3. **The crew in sequence.** Each agent does its part on the run's branch and leaves a report. The next one reads what came before.
4. **The review.** The manager checks the work, fixes what is needed and writes the pull request text with its verdict.
5. **The checks.** Chiefmate runs the project's checks, pushes the branch and opens the pull request. Agents cannot push anything to GitHub.
6. **Your approval.** You review and merge on GitHub. From there, your project's own deployment does the rest.

A one-off task follows the same path, with a single agent and, if you tick the box, the manager's review.

## Requirements

- Windows 10 or 11. Scheduling, notifications and shortcuts are Windows-only. The server and the command line should run wherever Node.js does, but that is untested.
- Node.js 22 or newer.
- Claude Code, installed and signed in.
- git and the GitHub CLI (`gh`), signed in.

## Installation

```powershell
git clone https://github.com/luanmadson/chiefmate.git
cd chiefmate
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

The installer:
- creates your settings, `config/chiefmate.json`, from `config/example.json` the first time;
- starts Chiefmate in the background when you sign in to Windows;
- creates the task that wakes the computer before scheduled missions;
- creates the **Chiefmate** shortcuts on the desktop and in the Start menu;
- registers the `chiefmate:` address that the notifications use.

Run it again whenever you change a mission's schedule. To remove everything it created, run `scripts\uninstall.ps1`.

## Settings

`config/chiefmate.json` is yours: it stays on your computer and never goes to git.

| Key | What it sets |
|---|---|
| `owner` | Your name, so the manager knows who it answers to |
| `language` | `en` or `pt-BR`: the app, the notifications, the manager's answers and the reports |
| `default_model` | The model for agents that don't set one |
| `projects` | For each project: `repository`, `main_branch`, `setup` (such as `npm ci`), `checks` (such as `npm test`), the `playbook` the crew follows, a sentence `about` it and optional `agent_notes` for specific agents |
| `missions` | For each mission: the `project`, the `steps` (an agent and its part, in order), the final `review`, the `schedule` (`days` such as `["mon"]` and a `time` such as `"09:00"`) and the `eve_reminder` time |
| `limits` | The limits in the Usage section |

**To put a project under Chiefmate:**
1. add it to `projects`;
2. write a playbook in the project's repository: what each agent should do and how the project's files work;
3. create a mission for it, if you want a schedule;
4. run the installer again.

## Usage and limits

Before every step, Chiefmate checks four limits, which you can change in the Usage section:

| Limit | What happens when it is reached |
|---|---|
| Usage over the last 7 days | The run pauses and waits for you to decide |
| Usage per run | The run pauses and waits for you to decide |
| Your account's 5-hour window | The run waits for the window to reset and carries on by itself |
| Your plan's week | The run waits for the week to reset and carries on by itself |

The dollar values are **equivalents**. On a subscription plan, what counts is your account's usage in the 5-hour and 7-day windows, which Claude Code reports on every run. Each step also has its own budget and time limit.

## Security

- **Only you reach the app.** It listens on this computer only, and it refuses commands sent by other websites open in your browser.
- **Agents have limits.** They cannot push to GitHub, open or merge pull requests, or change the repository's address.
- **No connectors.** Agents run without MCP connectors and without the variables of your own Claude session.
- **Your data stays home.** Your settings, the history and the working copies (`config/chiefmate.json`, `data/`, `workspaces/`) never go to git.

## Command line

The manager uses these commands, and so can you:

```
node src/cli.mjs server                       starts Chiefmate (the shortcut does this for you)
node src/cli.mjs status                       what is running, the queue, usage and the crew
node src/cli.mjs mission <id>                 queues a mission
node src/cli.mjs task <project> <agent> "..." queues a one-off task (--review: the manager reviews it at the end)
node src/cli.mjs cancel <id>                  cancels a run
node src/cli.mjs resume <id>                  resumes a run (--ignore-limits goes past the limits this one time)
node src/cli.mjs history                      the latest runs
node src/cli.mjs report <id>                  the reports of a run
node src/cli.mjs limits --weekly 100 --per-run 40
```

## Languages

English is the source. The app, the notifications and the pull request texts follow `language` in your settings, and the manager answers in it. The translations live in `ui/locales/<language>.json`. `npm run check` checks the scripts and lists any text without a translation.

## Folders

| Folder | What it holds |
|---|---|
| `src/` | Chiefmate itself: the server, queue, schedule, runs, manager, notifications and command line |
| `ui/` | The app (HTML, CSS and JavaScript, no dependencies), the crew's faces, the translations and the icons |
| `agents/` | The crew, one file per agent |
| `config/` | `example.json`, and your `chiefmate.json` (not in git) |
| `scripts/` | Installation on Windows, launchers and checks |
| `data/` (not in git) | Runs, each step's log, the conversation with the manager, your account's usage and the schedule's state |
| `workspaces/` (not in git) | The projects' working copies |

Chiefmate has no dependencies besides Node.js. It drives Claude Code (`claude -p`), which uses your account's login and plan.

## License

Chiefmate is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE).

- **Free for noncommercial use.** You may use, study, change and share it for personal use, research, hobby projects and teaching, and organizations such as charities, schools and public institutions may use it too.
- **Commercial use needs a paid license.** To use Chiefmate in a business or in a commercial product, contact the author through [GitHub](https://github.com/luanmadson).
