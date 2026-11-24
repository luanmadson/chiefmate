# Chiefmate

A command center for AI agents that runs on your own computer. On a merchant ship, the chief mate answers directly to the captain and runs the crew. Here, you are the captain.

- **The manager answers to you.** You talk to Chiefmate in plain language; it hands out the work, reviews it and reports back.
- **The crew works on your projects**, several projects at once and one agent at a time on each. Each one has a face, a role and a model you can see.
- **Live sessions** open a conversation with Claude Code or Codex in a window of its own, for work you do together while the crew works in the background.
- **Your plan stays under control**: Chiefmate watches your account's usage and pauses before it runs out.

Everything the crew produces reaches you as a **pull request**. Nothing goes live without your approval.

> Chiefmate runs [Claude Code](https://claude.com/claude-code) and uses your own Claude login and plan. It is an independent project, not made by Anthropic.

## What you get

- **An app window**, with no browser bar, and eight sections:

  | Section | What it is for |
  |---|---|
  | **Manager** | Talk to Chiefmate. Ask how things are going, request a job, adjust the crew. It answers with the real situation: what is running, the queue, usage and your account's plan usage. You can write at any time, even while it answers (see "Talking while the manager answers" below), and you see live what it is doing. Beside the conversation, how full its context is and the context of the agent at work (see "The conversation's context" below). |
  | **Operations** | What the crew is doing right now. Each run going on (up to three at once by default, one per project) has its own block, with a discreet brass animation: the agent at work and their portrait, the step out of how many, the time counting live (for the run and for the step) and the agent's last action, updated as it happens; then the steps, the context of the agent at work and the logbook (every action of the agent, with the time). Below, the queue, numbered in the order it will run, with the next run marked and when each one is expected to start, and the live sessions: those open (alive or not, memory, for how long, a button to end them) and a button to open each profile. |
  | **Planning** | Your board of what is to be done in each project, by priority (see "Planning" below). The items waiting for you stand out at the top, and their number shows beside the section. |
  | **Missions** | Complete jobs with their own schedule. "Run now" starts one at any time. |
  | **Crew** | Who is on board, what each one is doing and the model behind them. Give any of them a one-off task. |
  | **Projects** | Which of your projects are running on this computer (development servers, node, python, IDEs, started by you or by the crew) and the memory each one uses, with a button to stop them. |
  | **Log** | Every run, with each step's report, the checks and the pull request link. |
  | **Usage** | Your Claude account's usage, when Chiefmate pauses to look after it, the week's pace and the plan's free resets. |

- **Crew portraits** that show at a glance who is standing by, working, thinking or waiting for a limit to reset. The title bar tells you whether Chiefmate is online and waiting for you, and which project is in focus: the one being worked on the longest (the mission or task, the agent at work and for how long, and the other projects being worked on at the same time) or, when nothing is running, the next one in the queue.
- **Running, seen from afar.** While a run goes on, a brass square pulses beside Operations in the sections and beside the project in focus, the window's title starts with ● (the agent, the step, how many are waiting: `● Writer 2/3 · 1 in the queue · Chiefmate`; with several runs at once, how many: `● 2 running · Chiefmate`) and the icon gets a brass square. With runs only waiting in the queue, the title starts with ○ and the square in the icon is hollow. The animations stop when Windows is set to show fewer animations (reduced motion); the app reads the state every 2.5 seconds, as it always has.
- **Scheduled missions**, for example every Monday at 9:00. They wake the computer from sleep.
- **Windows notifications**: the evening before a mission, when a run starts, when it pauses for a limit and when it is ready for your review.
- **Alerts that only warn**, as a band at the top of the app and a Windows notification, once each: when the account's 5-hour window or the plan's week passes 70% and 90%, when this computer has less than 15% of its memory free (naming the projects using the most), and about the plan's free resets.
- **One-off tasks** for any agent, at any time.
- **A queue that runs one run per project at a time**, with runs of different projects going on side by side (three at most by default), so agents never set off other agents.
- **Live sessions** with Claude Code or Codex, opened from the app or the command line, each in its own window and folder, started with the blocks of the prompt builder you choose (see "Live sessions" below).
- **It improves itself.** Chiefmate can be one of its own projects: the crew proposes improvements in pull requests and, when you merge one, your installation updates itself.
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

Each agent is a Markdown file in `agents/`. Its header sets the name, model, time limit per step, tools, color and face; the instructions come after it. To adjust an agent for your installation only, use `crew` in your settings (see below): the files in `agents/` are the defaults that everyone shares and that the self-update keeps current.

Every agent runs on **Claude Opus 5.5** by default.

**Crews by project.** A project can have a crew of its own with `"crew"` in its settings: its missions and tasks then take only its members. Each member is based on one of the agents above, with an optional name of its own and instructions for that project only:

```json
"crew": {
  "generalist": { "extra_instructions": "Instructions for this project only." },
  "frontend": { "agent": "designer", "name": "Front-end", "mcp": ["playwright"] }
}
```

A plain list (`["generalist", "designer"]`) works too. Without `crew`, a project uses the general crew. The manager is global: it reviews every project. The Crew section shows the crews grouped by project.

## How a mission runs

```
queue ─► fresh working copy ─► the crew, one after another ─► manager's review ─► checks ─► pull request
```

1. **One per project.** The queue runs one run per project at a time, in the order they were asked for. Runs of different projects go on side by side, up to `max_parallel` at once (3 by default; 1 brings back one run at a time). No agent sets off others in a chain.
2. **A working copy.** Each project has a copy of its own for the crew, in `workspaces/<project>`, refreshed from GitHub at the start of every run. Nobody touches the folder you work in.
3. **The crew in sequence.** Each agent does its part on the run's branch and leaves a report. The next one reads what came before.
4. **The review.** The manager checks the work, fixes what is needed and writes the pull request text with its verdict.
5. **The checks.** Chiefmate runs the project's checks, pushes the branch and opens the pull request. Agents cannot push anything to GitHub.
6. **Your approval.** You review and merge on GitHub. From there, your project's own deployment does the rest.

A one-off task follows the same path, with a single agent and, if you tick the box, the manager's review.

Runs going on at the same time never share a working copy: each project has its own. The reference libraries are shared, so Chiefmate runs only one update of each library at a time, and a run that asks for a library while it is being updated gets that same update. The self-update waits until every run has ended.

### What each step sees

- **Only its project.** A step gets the project's working copy and the project's own personal documentation folder (`docs`), not the whole library it lives in. Libraries in the project's `library` list come too. Everything else is denied to the file tools by permission rules: other projects' working copies, other projects' documentation folders in the libraries, the libraries the project doesn't list and Chiefmate's `data/`. The manager's review sees every library. These rules bind Claude Code's file tools (Read, Edit, Glob, Grep), not the shell: an agent that runs a command such as `cat` through Bash can still read those folders. Treat this as keeping each step's attention on its project, not as a sandbox.
- **None of your own Claude Code configuration.** Steps never load your user settings, hooks, plugins, skills, MCP servers or `~/.claude/CLAUDE.md` (`--setting-sources project,local`, `claudeMdExcludes`, `--strict-mcp-config`). This is deliberate and has no switch. The project's own instruction files (its `CLAUDE.md`, `.claude/`) still apply.
- **External tools only from Chiefmate's settings.** Declare MCP servers in `mcp_servers` and release them to a project or an agent with `"mcp": ["<name>"]`.
- **What it received, on record.** Each step writes `data/runs/<id>/<NN>-<agent>.context.md`: the system prompt, the prompt, the model, the tools allowed and denied, the MCP servers, the folders, the repository's instruction files and what Claude Code reported loading. Open it with the "Context received" button in the Log, or `node src/cli.mjs context <id> [step]`.

### When a step needs you

Some work needs a person: signing in to a site, confirming something, a step only you can take. The crew's rules tell every agent to run:

```
node <chiefmate>/src/cli.mjs needs-you "<what to do>" [--url <address>] [--wait] [--check "<command>"]
```

Chiefmate records the request in the run and shows it at once: a band at the top of the app ("Needs you: <task> — <what to do>") with a **Done** button, a mark on the window's icon and title, the app's taskbar badge and a Windows notification. With `--url`, the address opens for you:
- with `browser_cdp` set (the address of your own browser started with remote debugging, such as `http://127.0.0.1:9333`), in a new tab of that browser, where you are already signed in. Mind the risk: while remote debugging is on, any program on this computer, the crew's shell commands included, can drive that browser and its signed-in sessions. Prefer a separate browser profile for it (recent Chrome versions only allow remote debugging with their own `--user-data-dir`);
- without it, in a visible browser with Chiefmate's own profile in `data/browser-profile`, which the crew can never read (through Playwright when `playwright-core` is installed, else by starting Edge or Chrome on that profile).

With `--wait`, the agent waits until you click Done, or until its `--check` command succeeds. While it waits, the step's time limit stands still. The wait has a ceiling (`needs_you.max_wait_minutes`, 120 by default): past it, the agent goes on with what it can and the request stays open in the app. The run is never canceled for it, and shows "Waiting for you" meanwhile.

### The prompt builder (optional)

If you keep your project instructions in a document of blocks, Chiefmate can put each step's instructions together from it instead of the project's `notes`. The document is Markdown, kept outside the repository (`prompt_builder.file`):

```markdown
# Projects
// selection: one
## My project
// tags: code
// access: browser
CODE = MYPROJ
Work on {CODE}, following its documentation.

# Modules
// selection: several
## Board
Update the card on the board when you finish.

# Rules
// selection: automatic
## Code rules
// tags: code
Keep the existing comments.
```

- A first-level heading opens a section and a second-level heading a block. Lines starting with `//` set options: `selection` (`one`, `several` or `automatic`; in Portuguese `seleção: uma | várias | automática`), `tags`, `access` (`acessos`), `requires` (`requer`: blocks it brings along) and `include with` (`incluir com`). `NAME = value` sets a variable, and `{NAME}` in the text takes its value.
- A step gets the project's block (`projects.<id>.prompt_block`), the environment (`prompt_builder.environment`), the optional modules (`projects.<id>.prompt_modules`, or `--modules A,B` on a task) and the automatic blocks that match their tags, accesses or names, each under a `## <block>` heading.
- Blocks that need you live (a browser, a board, a confirmation) are kept: the agent asks for you with `needs-you`. A sentence that conflicts with the crew's rules (pushing, other branches, pull requests) is replaced by a note saying Chiefmate's rules prevail, and the adaptation is recorded in the step's context.
- Without the file, the project's `notes` are used as before.

To copy the document from Google Docs, set `prompt_builder.doc_id` and `browser_cdp`, install the optional `playwright-core` (`npm install --no-save playwright-core` in the Chiefmate folder) and run `node src/cli.mjs prompts-sync`, or use the button in the Crew section. Chiefmate borrows your browser's session to download the document's Markdown export: it never changes the document and never touches your tabs.

## Live sessions

Besides the work the crew does in the background, you can open a conversation with an agent to work together, live: review a text with Claude Code while Codex helps you with something else in another window, for example. Each session is a profile in `sessions`:

```json
"sessions": {
  "book-review": {
    "name": "Book review",
    "tool": "claude",
    "library_folder": "notes/My book",
    "prompt_blocks": ["Book (review)", "Home", "Another AI reading the book"],
    "model": "claude-opus-5-5"
  },
  "vocabulary": {
    "name": "Vocabulary",
    "tool": "codex",
    "project": "my-site",
    "prompt_blocks": ["Vocabulary"],
    "cwd": "C:\\Users\\you\\Documents\\GitHub\\my-site"
  }
}
```

- `tool`: `claude` (Claude Code) or `codex` (Codex CLI).
- Where it opens: `cwd` when you give it; for a `project`, your own clone of it (`local_clone`, or `Documents/GitHub/<repository name>`), never the crew's working copy, which is reset before every run; for a `library_folder` (`<library>/<folder>`), that folder in your own clone of the library or, failing that, in Chiefmate's read-only copy (anything changed there is lost, and the first message says so).
- `prompt_blocks`: blocks of the prompt builder, by name, in any section. They are put together as for a step: the automatic and required blocks they bring come along and the variables are filled in. Nothing is adapted to the crew's rules: you are there. Without `prompt_blocks`, the session starts with no first message.
- `model`: optional.

Open one with its **Open** button in Operations, or `node src/cli.mjs session <profile>` (`--dry-run` shows the folder, the command and the first message without opening anything). Chiefmate writes the first message to `data/sessions/<id>.md`, records the session in `data/sessions/<id>.json` and opens a Windows Terminal window (or PowerShell, when there is no Windows Terminal) in the session's folder, running the tool with that first message.

- **Claude Code** starts without your own configuration, as the crew's steps do: no user settings, hooks, plugins, skills, MCP servers or `~/.claude/CLAUDE.md` (`--setting-sources project,local`, `claudeMdExcludes`, `--strict-mcp-config`). The project's own instruction files still apply. It asks before acting, as usual.
- **Codex** gets the folder (`-C`) and the model (`-m`). It has no option to leave out its own configuration (`~/.codex`), so that still applies. When it is not signed in, the session asks for you as a step does with `needs-you`: a band at the top of the app and a Windows notification tell you to run `codex login`; the window opens by itself once you are signed in (or when you click Done).
- A first message longer than the command line allows (about 24,000 characters) is replaced by a request to read the file.

Operations lists the sessions open: whether the window's process is alive, its memory, since when, and an **End** button that closes the window and stops what the agent is doing (the conversation stays in the tool's own history). A window you close yourself is noticed within a minute or so. The sessions also count in the Projects section (in their project's memory, or in a row of their own for a library folder), where they are never offered for stopping, and the manager sees them in its situation. They are yours: the manager doesn't end them unless you ask, and the self-update doesn't wait for them.

## Requirements

- Windows 10 or 11. Scheduling, notifications and shortcuts are Windows-only. The server and the command line should run wherever Node.js does, but that is untested.
- Node.js 22 or newer.
- Claude Code, installed and signed in.
- For Codex sessions only: the Codex CLI. Windows Terminal is used for the sessions' windows when it is installed.
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
| `attribution` | `false` keeps the crew's commits and pull requests from crediting Claude (they are credited to you alone) |
| `backup_dir` | A folder of your own, such as one in a private repository, where Chiefmate keeps an up-to-date copy of these settings |
| `projects` | For each project: `repository`, `main_branch`, `setup` (such as `npm ci`), `checks` (such as `npm test`), the `playbook` the crew follows, a sentence `about` it, optional `notes` for every agent and `agent_notes` for specific ones, and an optional `language` for its pull requests and commits. Optional: `crew` (its own crew), `mcp` (external tools it releases), `prompt_block` and `prompt_modules` (the prompt builder). See also "Local delivery" below |
| `missions` | For each mission: the `project`, the `steps` (an agent and its part, in order), the final `review`, the `schedule` (`days` such as `["mon"]` and a `time` such as `"09:00"`) and the `eve_reminder` time |
| `crew` | Settings for one agent in this installation only, such as `{ "writer": { "model": "claude-opus-5-5", "max_minutes": 90, "extra_instructions": "..." } }` |
| `library` | Reference libraries: git repositories the manager and the crew may read, such as your personal documentation. Each has a `name`, a `repository`, a `main_branch` and a sentence `about` it, and optionally `local_clone`, your own clone of it, where the live sessions of its folders open. A project uses one with `"library": ["<id>"]`, or with `"docs": "<id>/<folder>"` for its personal documentation, which then takes precedence over the instructions inside the project's own repository |
| `max_parallel` | How many runs of different projects may go on at once (3 by default). Within a project, one at a time |
| `sessions` | The live sessions' profiles: `name`, `tool` (`claude` or `codex`), `project`, `library_folder` or `cwd`, `prompt_blocks` and an optional `model` (see "Live sessions") |
| `limits` | When runs pause: `pause_at_5h_window` and `pause_at_plan_week`, as shares of your account's usage (0.85 is 85%) |
| `plan_resets` | The plan's free resets, which Claude Code doesn't report: `[{ "kind": "full", "expires": "<ISO date>", "used": false, "note": "..." }]`. Easier from the Usage section or `node src/cli.mjs reset-grant` |
| `mcp_servers` | External tools (MCP servers) the crew may use, in Claude Code's format: `{ "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } }`. Nothing is released until a project or an agent lists it in `mcp` |
| `browser_cdp` | The address of your own browser with remote debugging on, such as `http://127.0.0.1:9333`: sign-ins asked by the crew open there, and the prompt builder is copied through it. Any local program can control a browser with remote debugging on: prefer a separate profile |
| `needs_you` | `{ "max_wait_minutes": 120 }`: the longest a step waits for you before it goes on without you |
| `prompt_builder` | The optional prompt builder: `{ "file": "data/manager/prompt-builder.md", "doc_id": "<Google Docs id>", "environment": "<block>" }` |
| `usage_reader` | The optional reading of your usage page on claude.ai (see below): `{ "enabled": false, "every_hours": 4 }`, and `browser` with the path to Edge or Chrome if it isn't found |

The libraries are read from a copy that Chiefmate refreshes from GitHub before use, in `workspaces/.library/`, so the crew can read them but never change the original. To have the crew change a library, add its repository as a project too: the changes then arrive as pull requests, like everything else.

**Local delivery.** For a project whose work must not go to GitHub on its own, such as a repository you share with a team, set `"deliver": "local"`. The crew works the same way, but the result is a branch handed to your own clone (`local_clone`), never pushed. You review it there and decide what to send. Related settings:
- `"main_branch": "current"` starts every run from the branch checked out in your clone, so the crew starts where you are working;
- `repository` may be your clone's folder itself, which makes copying instant and includes commits you haven't pushed;
- `clone_filter` (such as `"blob:none"`) makes a partial copy of a very large repository.

**Projects on this computer.** The Projects section finds a project's processes by its folders: `local_clone`, `repository` when it is a folder, `Documents/GitHub/<repository name>` in your user folder when it exists, the working copy in `workspaces/` and any extra folders in the project's `local_dirs`.

**To put a project under Chiefmate:**
1. add it to `projects`;
2. write a playbook in the project's repository: what each agent should do and how the project's files work;
3. create a mission for it, if you want a schedule;
4. run the installer again.

## Planning

The Planning section is your board: what is to be done in each project, kept by you and by the manager.

- **Each item** has a number, a project, a title, an optional description, a priority (high, medium or low), a status (future, to do, queued, in progress, waiting for you, completed), when it was created and last updated, and an optional link to a run (its id) or a pull request.
- **In the app:** filter by project, priority and status (open items by default, or all, or the archived ones), sort by priority (then what is waiting for you first), by the latest updated or by number, change the priority and the status right in the list, edit the rest with **Edit**, add items with the form below the list, and archive what you no longer want to see (**Restore** brings it back). The items waiting for you are highlighted at the top.
- **Items follow their runs.** Queue a task or a mission with `--plan <n>` (or link a run to an item with `plan set <n> --run <id>`) and the item changes by itself: queued while the run waits, in progress while it runs, waiting for you when it ends with a pull request to approve (the link to the pull request is kept) or a branch delivered locally, completed when it ends with nothing to approve, and back to "to do" if it fails or is canceled. You can still change the status by hand: the item only moves again when its run does.
- **The manager keeps it too**, with the `plan` commands (see "Command line"), and gets a short summary with each of your messages: the open high-priority items and the ones waiting for you.
- **Where it lives:** `data/plan.json`, outside the repository. The first time, if the manager kept a board in `data/manager/plan.md` (a Markdown table with the columns #, Projeto, Item, Prioridade, Situação), Chiefmate imports it, keeping the numbers; a status it doesn't recognize goes into the description, and the item stays "to do" or the closest status.

## Usage and limits

Chiefmate measures what really counts on a subscription plan: your account's usage in the 5-hour window and in the plan's week, which Claude Code reports on every run. There are no spending caps in dollars.

- **Before a run starts and before every step**, Chiefmate checks your account (the same account for every run going on). If the 5-hour window or the plan's week is above the share you set in the Usage section (85% and 90% by default), the run waits for the reset and then carries on by itself.
- **If the account runs out in the middle of a step**, that step starts over after the reset.
- **Each step has a time limit** (in the agent's header), in case an agent gets stuck.
- **Alerts at 70% and 90%** of the 5-hour window and of the plan's week, once per threshold and window. They don't pause anything.
- **The plan's free resets.** Claude Code doesn't report them, so you record them in the Usage section or with `reset-grant`. Chiefmate shows the ones available and the week's pace (the share used against the share of the week gone by, and whether there is slack). It warns you when the week passes 90% with one available, and 3 days and 1 day before one expires unused.

### Talking while the manager answers

The conversation never makes you wait.

- **Write at any time.** While the manager answers (or renews the conversation), what you send goes to a queue shown under the conversation, marked "queued". Until it is delivered, you can edit or remove each message there.
- **The queue goes together.** When the answer ends, the queued messages go as the next message, in the order you sent them and with the time of each. In the conversation they show when they were sent and when they were delivered. The queue survives a restart of Chiefmate.
- **Interrupt.** The **Interrupt** button ends the current answer at once. The conversation goes on in the same session: whatever the manager had written so far stays, marked "interrupted", and your next message tells it the answer was interrupted, so it checks what it may have left half done. Then the queue goes.
- **See what it is doing.** While it answers, the conversation shows the time it has been at it and its last action (the command it ran, the file it read), updated as it happens, as Operations does for the crew.
- **The same from the command line:** `chat say`, `chat edit`, `chat remove`, `chat interrupt` and `chat` to read the conversation, the last action and the queue (see "Command line"). The manager itself can't write to its own conversation.

### The conversation's context

Every turn of Claude Code reports how much of the model's context window it filled. Chiefmate shows it as a bar, in tokens and as a share, for the conversation with the manager and for the agent at work, with the number of times Claude Code compacted each one on its own.

- **The manager's conversation** carries on from message to message, so it grows. Below 75% of the window, Claude Code's own compaction takes care of it, and the conversation notes each compaction. Above 75%, as soon as the manager is free, it writes a short summary of the conversation (`data/manager/handoff.md`); your next message then starts a new conversation that opens with that summary and the manager's notes (`data/manager/notes.md`). The conversation says when this happens. The **New conversation** button starts over at any time, keeping only the notes.
- **Each agent's step** starts with a new session, so nothing is renewed: the context is shown, compactions go to the logbook, and the step's record keeps the context it ended with.
- The manager also gets both in the situation it receives with each of your messages.

### Reading claude.ai (optional, off by default)

Chiefmate can read your account's usage page on claude.ai, to keep the limits and the free resets up to date without you.

1. `node src/cli.mjs claude-login` opens a browser window (Microsoft Edge or Google Chrome) with a profile of Chiefmate's own, in `data/browser-profile`. Sign in to claude.ai there and close the window.
2. Turn the reading on in the Usage section, or with `node src/cli.mjs usage-reader on`.

From then on, the server (never an agent) opens only the usage page, with no window, at most once every few hours (`every_hours`, 4 by default, never less than 2). It only reads the page: it never clicks anything on your account and never applies a reset. When the page shows free resets, it updates `plan_resets` and notes the source and the time. When it can't read the page, or the page doesn't have what it looks for, your own record stays and the Usage section says so. It drives the browser through its DevTools protocol, the way Playwright does, so Chiefmate keeps having no dependencies.

**The risks, before you turn it on:**
- `data/browser-profile` holds a signed-in claude.ai session. Anyone, or any program, that can read your user folder can use it. It never goes to git, and the crew is told never to read it, but it is a real credential on disk. To revoke it, sign out of that session on claude.ai and delete the folder.
- Automated access to claude.ai may go against its terms of use, and the site may block it, ask you to sign in again or change the page. The reading is kept to one page and a few times a day, but the choice is yours.
- The page has no fixed format: the values are found by their words, in English and Portuguese, and may be missed or misread. The Usage section shows the lines it relied on.

## Chiefmate improves itself

Chiefmate can be one of its own projects. Its crew then works on Chiefmate the same way it works on any project, and you stay in charge of what goes in.

1. **Add Chiefmate as a project** in your settings, pointing at your copy of this repository, with `"language": "en"`, `"checks": ["npm run check", "npm run smoke"]` and `"playbook": "docs/playbook.md"`. The [playbook](docs/playbook.md) tells the crew how Chiefmate is built and which rules a change must keep.
2. **Ask for improvements**, in the Manager section or as a task on that project. Ideas for later go to the repository's issues: the manager can open them for you.
3. **Or give it a routine**: a mission on that project, for example once a week, that works through the open issues.
4. **Approve.** Every improvement arrives as a pull request. When you merge it, your installation updates itself within ten minutes, once the crew is free. It checks the new version first: if the checks fail, it stays on the current one and tells you.

The self-update only touches Chiefmate's own files. Your settings, the history and the working copies are never in git, so they are never overwritten. If Chiefmate's files were changed by hand in your installation, it does not update, and the app says so.

## Security

- **Only you reach the app.** It listens on this computer only, and it refuses commands sent by other websites open in your browser.
- **Agents have limits.** They cannot push to GitHub, open or merge pull requests, or change the repository's address.
- **Each step sees only its project.** Other projects' working copies and documentation, the libraries a project doesn't list and Chiefmate's `data/` are denied to the file tools by permission rules (see "What each step sees"). A shell command can still read them: this is not a sandbox.
- **None of your own configuration.** Agents run without your Claude Code settings, hooks, plugins, skills, `~/.claude/CLAUDE.md` and MCP servers, and without the variables of your own Claude session. The only external tools are those in `mcp_servers`, released by project or agent.
- **Sign-ins are yours.** Agents never type passwords: they ask for you with `needs-you`, and the address opens in your browser. The address comes from the agent (only `http` and `https`), so look at it before you act on it. With `browser_cdp`, remote debugging leaves that browser open to any local program: use a profile of its own.
- **Your data stays home.** Your settings, the history and the working copies (`config/chiefmate.json`, `data/`, `workspaces/`) never go to git.
- **Stopping processes asks first.** The Projects section and `stop-project` show what will stop and end only those processes. They never stop Chiefmate, what started it, the crew at work (cancel the run for that) or a live session (end it in Operations).
- **Live sessions** run Claude Code without your own configuration, like the steps; Codex keeps its own (`~/.codex`), which it has no option to leave out. A session works in your own folders, with you present and the tool asking before it acts: the crew's rules (no push, no pull requests) are not imposed on it.
- **The optional claude.ai reading** keeps a signed-in browser profile in `data/browser-profile`. See its risks above.

## Command line

The manager uses these commands (all but the `chat` ones, which are yours), and so can you:

```
node src/cli.mjs server                       starts Chiefmate (the shortcut does this for you)
node src/cli.mjs status                       what is running, the queue, usage and the crew
node src/cli.mjs mission <id>                 queues a mission (--plan <n>: item n of the planning board follows it)
node src/cli.mjs task <project> <agent> "..." queues a one-off task (--review: the manager reviews it at the end;
                                              --modules A,B: optional blocks of the prompt builder; --plan <n>)
node src/cli.mjs plan [list]                  the planning board's open items (--project, --status, --priority; --all)
node src/cli.mjs plan add <project> "..."     adds an item (--priority high|medium|low, --status, --description)
node src/cli.mjs plan set <n> --status ...    changes an item (--title, --description, --project, --priority, --run,
                                              --pr, --archive, --restore)
node src/cli.mjs plan done <n>                marks an item as completed
node src/cli.mjs chat [n]                     the conversation with the manager: the last n messages, what it is doing, the queue
node src/cli.mjs chat say "..."               writes to the manager; while it answers, the message waits in the queue
node src/cli.mjs chat edit <id> "..."         changes a message still in the queue (chat remove <id> takes it out)
node src/cli.mjs chat interrupt               ends the current answer; the conversation goes on and the queue goes next
node src/cli.mjs session [<profile>]          opens a live session (--dry-run shows what it would open); with no profile,
                                              lists the profiles and the sessions open
node src/cli.mjs session end <id>             ends a live session
node src/cli.mjs cancel <id>                  cancels a run
node src/cli.mjs resume <id>                  resumes a run (--ignore-limits goes past the limits this one time)
node src/cli.mjs history                      the latest runs
node src/cli.mjs report <id>                  the reports of a run
node src/cli.mjs context <id> [step]          what each step received: prompt, model, tools, folders, MCP servers
node src/cli.mjs needs-you "..." [--url <address>] [--wait] [--check "<command>"]
                                              for a step: asks you to act and, with --wait, waits for Done
node src/cli.mjs prompts-sync                 copies the prompt builder's document from Google Docs
node src/cli.mjs limits --window-5h 0.85 --plan-week 0.9
node src/cli.mjs ram                          the projects running on this computer and their memory
node src/cli.mjs stop-project <id> [--yes]    lists a project's processes; with --yes, stops them
node src/cli.mjs reset-grant [list]           the plan's free resets (add <YYYY-MM-DD> "<note>", used <n>, remove <n>)
node src/cli.mjs claude-login                 signs in to claude.ai, for the optional usage reading
node src/cli.mjs usage-reader on|off|now      turns the reading on or off, or reads now
```

## Languages

English is the source. The app, the notifications and the reports follow `language` in your settings, and the manager answers in it. A project's pull requests and commits follow the project's own `language`, if it has one. The translations live in `ui/locales/<language>.json`.

## Development

- `npm run check` checks the syntax of every script and lists any text without a translation.
- `npm run smoke` starts a temporary Chiefmate on a spare port, with no queue, schedule or updates and with records of its own in a temporary folder (`CHIEFMATE_DATA`), and checks that the app and the API answer. It never starts a real answer of the manager.
- [docs/playbook.md](docs/playbook.md) has the rules for changing Chiefmate, for the crew and for people alike.

## Folders

| Folder | What it holds |
|---|---|
| `src/` | Chiefmate itself: the server, queue, schedule, runs, manager, notifications, self-update and command line |
| `docs/` | The playbook for changing Chiefmate |
| `ui/` | The app (HTML, CSS and JavaScript, no dependencies), the crew's faces, the translations and the icons |
| `agents/` | The crew, one file per agent |
| `config/` | `example.json`, and your `chiefmate.json` (not in git) |
| `scripts/` | Installation on Windows, launchers and checks |
| `data/` (not in git) | Runs, each step's log and context, the live sessions' first messages and records, the planning board (`plan.json`), the conversation with the manager, your account's usage, the schedule's and the alerts' state and, if you use the claude.ai reading, its browser profile |
| `workspaces/` (not in git) | The projects' working copies |

Chiefmate has no dependencies besides Node.js. It drives Claude Code (`claude -p`), which uses your account's login and plan. The only optional one is `playwright-core`, for copying the prompt builder from Google Docs (and, if present, for the browser that opens for sign-ins): Chiefmate loads it only when needed and says how to install it when it is missing.

## License

Chiefmate is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE).

- **Free for noncommercial use.** You may use, study, change and share it for personal use, research, hobby projects and teaching, and organizations such as charities, schools and public institutions may use it too.
- **Commercial use needs a paid license.** To use Chiefmate in a business or in a commercial product, contact the author through [GitHub](https://github.com/luanmadson).
