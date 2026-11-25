# Chiefmate

A command center for AI agents that runs on your own computer. On a merchant ship, the chief mate answers directly to the captain and runs the crew. Here, you are the captain.

- **The manager answers to you.** You talk to Chiefmate in plain language; it hands out the work, reviews it and reports back.
- **The crew works on your projects**, several projects at once and one agent at a time on each. Each one has a face, a role and a model you can see.
- **Live sessions** open a conversation with Claude Code or Codex inside the app, for work you do together while the crew works in the background: what the agent says and each of its actions show as they happen.
- **Your plan stays under control**: Chiefmate watches your account's usage and pauses before it runs out.

Everything the crew produces reaches you as a **pull request**. Nothing goes live without your approval.

> Chiefmate runs [Claude Code](https://claude.com/claude-code) and uses your own Claude login and plan. It is an independent project, not made by Anthropic.

## What you get

- **An app window**, with no browser bar, and nine sections:

  | Section | What it is for |
  |---|---|
  | **Conversation** | Talk to Chiefmate, the manager. Ask how things are going, request a job, adjust the crew. It answers with the real situation: what is running, the queue, usage and your account's plan usage. You can write at any time, even while it answers (see "Talking while the manager answers" below), and you see live what it is doing. The conversation takes the whole page, with nothing beside it; **Focus on the conversation** hides everything else (see "Focus mode" below). |
  | **Decisions** | What only you can decide, as compact cards with one-click buttons (see "Waiting for your decision" below). |
  | **Operations** | What the crew is doing right now. Each run going on (up to three at once by default, one per project) has its own block, with a discreet brass animation: the agent at work and their portrait, the step out of how many, the time counting live (for the run and for the step) and the agent's last action, updated as it happens; then the steps, the context of the agent at work and the logbook (every action of the agent, with the time). Click the agent at work, or "Watch and talk", to open its panel (see "Talking to an agent at work" below). Below, the queue, numbered in the order it will run, with the next run marked and when each one is expected to start, and the live sessions: those open (in the app or in a window, their state, memory, for how long, a link to the conversation and a button to end them) and a button to open each profile. Beside it, the crew on board (each member's state and model), whether Claude Code, the account and Chiefmate's update are fine, the next scheduled mission, the account's usage and how full the contexts are (the manager's and the agent's at work, see "The conversation's context" below). |
  | **Planning** | Your board of what is to be done in each project, by priority (see "Planning" below). The items waiting for you stand out at the top as important notices, and a mark beside the section counts them (see "What needs you" below). |
  | **Missions** | Complete jobs with their own schedule. "Run now" starts one at any time. |
  | **Crew** | Who is on board, what each one is doing and the model behind them, and the crews by project, each with its team lead above it when it has one. Give any of them a one-off task. Click a member at work to open its panel. A member waiting its turn says what it waits for: "Waiting for Generalist: <task>" (the agent at work on its run) or "Waiting for <project>: <task>" (the run ahead of it in the queue). |
  | **Projects** | Which of your projects are running on this computer (development servers, node, python, IDEs, started by you or by the crew) and the memory each one uses, with a button to stop them. |
  | **Log** | Every run, with each step's report, the checks and the pull request link. |
  | **Usage** | Your Claude account's usage, when Chiefmate pauses to look after it, the autopilot's switch and limits, the week's pace and the plan's free resets. |

- **A page for each project** (see "Project pages" below), reached from the list of projects at the top of the window or by clicking a project's name in the crews by project, the focus, the Projects section, Planning and Missions.
- **Crew portraits** that show at a glance who is standing by, working, thinking or waiting for a limit to reset. The title bar tells you whether Chiefmate is online and waiting for you, and which project is in focus: the one being worked on the longest (the mission or task, the agent at work and for how long, and the other projects being worked on at the same time) or, when nothing is running, the next one in the queue. A click on a project in focus that is being worked on opens the panel of its agent at work; a click on its name opens its page.
- **Running, seen from afar.** While a run goes on, a brass square pulses beside Operations in the sections and beside the project in focus, the window's title starts with ● (the agent, the step, how many are waiting: `● Writer 2/3 · 1 in the queue · Chiefmate`; with several runs at once, how many: `● 2 running · Chiefmate`) and the icon gets a brass square. With runs only waiting in the queue, the title starts with ○ and the square in the icon is hollow. The animations stop when Windows is set to show fewer animations (reduced motion); the app reads the state every 2.5 seconds while it is in view, and once a minute with its tab hidden or the phone's screen off. The state comes compressed, and when nothing changed the server answers with no body at all, so following Chiefmate from a phone costs little mobile data.
- **Scheduled missions**, for example every Monday at 9:00. They wake the computer from sleep.
- **Windows notifications**: the evening before a mission, when a run starts, when it pauses for a limit and when it is ready for your review. The urgent ones (a step needs you, a live session asks your permission, a run or a mission failed, the account above 90%, low memory, a free reset expiring within a day) stay on screen until you open or dismiss them.
- **News from the manager**: when a run ends, fails or pauses, a pull request waits for you, a step needs you, an update is installed or blocked, an alert goes off or a live session ends, the manager writes you a short notice in the conversation on its own (see "News from the manager").
- **Alerts that only warn**, as notices in the app (see "What needs you" below) and a Windows notification, once each: when the account's 5-hour window or the plan's week passes 70% and 90%, when this computer has less than 15% of its memory free (naming the projects using the most), and about the plan's free resets.
- **What needs you, by level.** Every notice has one of three levels, drawn the same way everywhere (see "What needs you" below).
- **Focus mode.** **Focus on the conversation**, at the top of the Conversation, leaves only the conversation on the whole window: no title bar, menu, notices, cards nor panels. One thin line stays on top, with the manager's state, the sections that need you (each with its count, in its level's color) and **Leave focus** (or Esc). A click on a section opens it, with everything back. The app remembers the mode until you leave it.
- **One-off tasks** for any agent, at any time.
- **A direct talk with each project's agent in charge** (its team lead, or the main member of its crew), from the project's page: it answers and plans with you, and what is to be done goes to the manager as a request, which the manager authorizes, holds or brings to you (see "Talking to the agent in charge" below).
- **A queue that runs one run per project at a time**, with runs of different projects going on side by side (three at most by default), so agents never set off other agents.
- **Live sessions** with Claude Code or Codex, opened from the app or the command line, each in its own folder and conversation inside the app (or, if you prefer, in a window of its own), started with the blocks of the prompt builder you choose (see "Live sessions" below).
- **A prompt builder screen** for your document of blocks (kept in a library, or in a file): choose the blocks and see each one come into the prompt, edit the prompt, then open a live session with it, send it with a task or copy it (see "The prompt builder in the app" below).
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

**Team leads by project.** A project can also have a team lead, with `"lead"` in its settings (all optional):

```json
"lead": { "name": "Site lead", "agent": "manager", "extra_instructions": "Instructions for the lead of this project only." }
```

- `agent` is the lead's base agent (`manager` by default): its model, face and instructions, plus the role of team lead. `model` and `max_minutes` may be set too.
- **It keeps the project's memory** in `data/projects/<id>/memory.md`: the decisions, the history, your preferences in this project and what was tried. Chiefmate gives the memory to the lead in every run of the project and saves the version the lead returns at the end of its step; the crew's steps read it too. The lead never opens `data/` itself.
- **It plans requests.** The manager sends a project with a lead its work with `node src/cli.mjs ask <project> "<request>"`. The run starts with a short planning step: the lead splits the request into at most 3 tasks for the project's crew, and Chiefmate puts them in the same run, linked to the request, one after another. With no task to do (the request is unclear or already done), the run ends there and says why.
- **It reviews first.** After the crew's steps, in every run of the project (requests, missions and tasks), the lead does a first review and writes an opinion. The final review and the talk with you stay with the manager, whose final review gets the lead's plan and opinion.
- **It only runs when the project has work**, as steps of the project's runs, and sees only its project and the project's own documentation, like any step. It reads and judges, but never edits the project's files.

Everything the lead decides stays in the run (`lead` in `data/runs/<id>.json`: the plan, what it left out and why, the opinion) and in the logbook. The Crew section shows each lead above its project's crew, with its memory's size and date; Operations shows the request, the lead's plan and, after its review, its opinion, under the run's steps. The manager gets one line per lead in its situation, with what the lead is on.

## How a mission runs

```
queue ─► fresh working copy ─► the crew, one after another ─► manager's review ─► checks ─► pull request
```

1. **One per project.** The queue runs one run per project at a time, in the order they were asked for. Runs of different projects go on side by side, up to `max_parallel` at once (3 by default; 1 brings back one run at a time). No agent sets off others in a chain.
2. **A working copy.** Each project has a copy of its own for the crew, in `workspaces/<project>`, refreshed from GitHub at the start of every run. Nobody touches the folder you work in.
3. **The crew in sequence.** Each agent does its part on the run's branch and leaves a report. The next one reads what came before.
4. **The review.** The manager checks the work, fixes what is needed and writes the pull request text with its verdict.
5. **The checks.** Chiefmate runs the project's checks, pushes the branch and opens the pull request. Agents cannot push anything to GitHub.
6. **Your approval.** You review and merge: on GitHub, with **Approve** on its card in Decisions (see "Waiting for your decision"), with **Merge** in the run's page of the app, or by telling the manager "yes" for that run in the conversation. Nothing is merged without your authorization. From there, your project's own deployment does the rest.

A one-off task follows the same path, with a single agent and, if you tick the box, the manager's review. A request to a project's team lead (`ask`) does too: the lead's planning first, then the tasks it planned, its first review and the manager's final review.

### Titles and summaries

Every run says what it does in a few words, so you understand it in seconds without reading the instruction:
- **A short title and a summary.** When a run is queued, it gets a title (up to about 60 characters, in your language, saying what will be done, such as "Prompt builder: read from the library and highlight blocks") and a summary of one or two sentences (what it is and why). They come from the lightest model (`quick_model`, Haiku by default: one short call, with no tools) and, until it answers or when it can't, from the instruction's first sentence. The manager gives its own with `--title` and `--summary`, and then nothing is generated. A mission keeps its name, and its description as the summary.
- **What the agent is doing now.** While a step works, Operations, the focus, the project's page and the agent's panel show one plain line, taken from its actions: "reading the code (runs.mjs)", "running the tests", "waiting for you".
- **A final summary.** Every step's report starts with three parts: **What was done** (up to 3 short items), **What changes for you** (one sentence) and **Needs you?** (no, or yes and what). The app shows them first and folds the full report below. At the end, the run gets one too, written from its steps; the same summary opens the pull request's text.
- **Everywhere.** The title and summary are what Operations, the focus, the project's page, Planning, the Log, the Windows notifications, the manager's notices and the manager's situation show. Older runs get theirs when the app lists them, and their final summary when you open them.

Runs going on at the same time never share a working copy: each project has its own. The reference libraries are shared, so Chiefmate runs only one update of each library at a time, and a run that asks for a library while it is being updated gets that same update. The self-update pauses the runs going on and resumes them after it (or, in `"wait"` mode, waits until every run has ended: see "Chiefmate improves itself").

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

Chiefmate records the request in the run and shows it at once as an urgent notice (see "What needs you" below): the band at the top of the app ("Needs you: <task> — <what to do>") with an **I did it** button, a red mark on the window's icon and title, the app's taskbar badge and a Windows notification that stays until you see it. With `--url`, the address opens for you:
- with `browser_cdp` set (the address of your own browser started with remote debugging, such as `http://127.0.0.1:9333`), in a new tab of that browser, where you are already signed in. Mind the risk: while remote debugging is on, any program on this computer, the crew's shell commands included, can drive that browser and its signed-in sessions. Prefer a separate browser profile for it (recent Chrome versions only allow remote debugging with their own `--user-data-dir`);
- without it, in a visible browser with Chiefmate's own profile in `data/browser-profile`, which the crew can never read (through Playwright when `playwright-core` is installed, else by starting Edge or Chrome on that profile).

When the step needs you to choose rather than act, it asks a question instead:

```
node <chiefmate>/src/cli.mjs needs-you "Resend or SES?" --options "Resend|SES" [--recommend Resend] [--why "<one short sentence>"]
```

The notice then has one button per option (2 to 6), the recommended one in brass, with "Recommends: Resend" and the reason just above them, where the notice is listed (Operations, the project's page, the run's log and the agent's panel); the band at the top shows **Answer**, which leads there. A question always waits, and the option you click is what the command hands to the agent. **I did it** is kept for what you do outside the app (signing in, confirming something).

With `--wait`, the agent waits until you click **I did it**, until its `--check` command succeeds, or until you answer it in the agent's panel (see below). While it waits, the step's time limit stands still. The wait has a ceiling (`needs_you.max_wait_minutes`, 120 by default): past it, the agent goes on with what it can and the request stays open in the app. The run is never canceled for it, and shows "Waiting for you" meanwhile.

### What needs you

What needs you shows up as a notice with one of three levels, the same component everywhere in the app:

| Level | Looks like | For example |
|---|---|---|
| **Urgent** | Bright red, with a soft pulse | A step asks for you ("needs you"), a live session asks your permission, a run failed, the account above 90%, less than 15% of memory free, a free reset expiring within a day |
| **Important** | Lit brass | A pull request (or a branch delivered to your clone) waiting for your approval, an item of the board waiting for your decision or your action, a question from the manager, an update that could not be installed, the reading of the usage page failing, the account above 70%, a free reset expiring within 3 days |
| **Info** | Discreet grey | A task finished (in the last day), an update installed, a pull request waiting for someone else's review (`merge_by_owner: false`) |

- **Where you see them.** Each section in the menu has a square in the color of its most urgent notice, with how many there are; a section with an urgent notice also pulses softly. The notices with a decision card count in Decisions only. Operations, the project's page and Planning list their own notices at the top, and a run waiting for you gets a red edge. The band at the top shows, in one short line, the most urgent notice the page doesn't already list, and how many others there are ("+2 more" opens them all); a permission asked shows there without its facts, with **See** leading to them. The Conversation keeps the band for its own notices (an update installed or blocked): the others mark their sections. The window's title starts with `!!` (urgent) or `!` (important) and the notice's name, and its icon gets a square of that color.
- **They go to the archive when they no longer need you**: the request marked as done, the item of the board decided, done or discarded, the run redone, the memory back, the reading of the usage page working again. A pull request's notice leaves as soon as it is merged or closed, through Chiefmate or on GitHub, or its branch is already merged in your clone (`local_clone`): Chiefmate asks GitHub (`gh pr view`) at most every 5 minutes. Work merged that way, outside Chiefmate, also shows its run as merged ("on GitHub" or "in your clone") and makes its item on the board done. A pull request closed on GitHub without a merge marks its run as discarded and sends its item on the board back to your decision (to do, when it has no agent), instead of leaving it waiting for you; a "do now" recommendation becomes "later", so the autopilot does not redo it on its own. A failed run asks for attention for 3 days, a pull request still open for a week, a finished task for a day.
- **Archived (N)**, a small link above Operations' notices (and in the band at the top, opened), lists the archived notices, the most recent first, with when and why each left: nothing is lost. The archive keeps the last 500.
- **Mark as seen** fades a notice (an info one goes to the archive): it stays in the list, out of the counts, the title and the icon. A step's request has no "seen": only **I did it** (or an option of its question) clears it (a live session's permission: **Allow**, or **Refuse** in its conversation).
- **Calm by design.** The colors keep their contrast on the dark panels, the level is also written ("Urgent", "Important"), and the pulse stops when Windows is set to show fewer animations.

### Waiting for your decision

What only you can decide waits as a card in **Decisions**, a section of its own (its mark in the menu counts the cards), so you decide with one click instead of writing "yes" or "no":
- **What a card says.** Compact, the essentials first: what it is, with the project beside its number ("PR #34 of Chiefmate", "Item #12 of Riffdex"), its title, the manager's recommendation in a few words ("Recommends: Approve with caveats", read after "Recommendation:" in the final review's verdict) and the buttons. The rest (what changes if you approve, what to watch out for, such as checks that failed or no final review, the recommendation's reason, the review's full verdict, what was done and the links) is folded under **Details**. The card's color is its notice's level.
- **Whose decision it is.** Each card carries a badge with the approval level the manager gave its run, item or question: **Level 2 · needs you** and **Level 3 · only you** stand out; **Level 1 · the manager settles it** is quiet, and those cards fold under **The manager will settle it (N)**, below what needs you; a card with no level shows a neutral **Level ?**. The menu's mark counts the cards of levels 2, 3 and ?, never those of level 1. The manager sets the level when it queues the work (`--level 1|2|3` on `task`, `ask` and `mission`, or later with `level <run id> <1|2|3>`), triages a proposal (`plan triage --level`, `plan set --level`) or asks (`ask-owner --level`). Level 1 is low-risk work within what you already approved or told the manager to handle alone; level 2, what you approve (new features that go live, money, personal data, security, new accounts, a change of direction, a new project); level 3, what is never done without you. A level 1 merge still follows the rule below: the manager merges only with your authorization, which may be a standing one you gave it for level 1 work.
- **The cards.** A pull request or a branch delivered locally, ready to merge; a crew proposal the manager triaged (its risk comes from `plan triage --risk`); a question the manager asked you, with one button per option (`ask-owner`, below); and a request of a project's agent in charge that the manager brought to you, with **Authorize**, **Wait** and **Refuse** (see "Talking to the agent in charge").
- **The buttons.** **Approve** merges the work (confirmed first, through the same path as `merge <id> --yes`) or turns the proposal into a task; a question has its options instead, the one the manager recommends in brass. **Not now** fades the card to the end, under "Left for later", where it stays pending. **Discard** closes the pull request on GitHub (it can be reopened there; the branch stays), leaves a local branch unmerged, discards the proposal (restorable in Planning) or drops the question. **Talk about this** starts your message to the manager with the item quoted.
- **On a phone.** The same cards, with the buttons' short labels (**Approve**, **Later**, **Discard**, **Talk**), each as wide as its label.
- **The manager hears of it.** Every click reaches the manager as news (`owner_decided`; a merge as `merged`), so it doesn't ask again. A notice with a card has **Decide** where it is listed, which opens Decisions.
- **Questions from the manager.** When the manager needs you to choose, it asks with `node src/cli.mjs ask-owner "<question>" --context "<explanation>" --options "Yes|No|Wait" [--recommend <option>] [--project <id>]`. Your answer comes back to it as news. The crew can't use it: a step asks with "needs you".
- **Work someone else reviews.** In a project with `"merge_by_owner": false`, its pull requests and branches show "Waiting for a third-party review", with no **Approve** or **Discard** (**Hide** instead of **Not now**): an info notice that leaves when the work is merged or closed, or when you hide it.

### Merging with your authorization

A finished run's work goes in only when you say so. Chiefmate merges it itself, so the crew and the manager still can't run `gh pr` or `git push`:
- **From the app.** Its card's **Approve** (see above), or **Merge** on the run's page in Operations: a finished run with a pull request (or a branch delivered locally) has it. It shows what is merged and how many checks failed; your confirmation is the authorization.
- **Through the manager.** When a run is ready and reviewed, the manager tells you its card is waiting, naming the pull request or branch with its project (`node src/cli.mjs merge <id>` shows them). If you tell it "yes" for that run in the conversation, it runs `merge <id> --yes`. Without it, never; an answer to one of its questions is never a merge's yes.
- **What a merge does.** A pull request is merged on GitHub (`gh pr merge --merge`); a merged pull request of Chiefmate itself is installed at once, as with `update-check`. A branch delivered locally is merged into the branch it started from in your clone (`local_clone`), with nothing sent to GitHub: the clone must have that branch checked out and no changes left to commit, and a merge with conflicts is undone.
- **The copies you read.** After a merge, the project's reference library (a library whose `repository` is the project's own) is brought up to date, and, for a pull request, your own clone moves forward to the merged branch, only by a fast forward: when it has another branch checked out, changes not committed, or commits of its own, it is left as it is and the app (and the manager) tell you to update it yourself. Chiefmate's own installation updates itself.
- **When it fails.** The error shows in the app, and the manager hears of it at once (`merge_failed`). A conflict with the main branch is the crew's to solve: the manager queues a task that brings the run's branch up to date and solves it, and tells you in one line; its new pull request (or branch) replaces the old one. A branch settles by itself once the new one is merged; the old pull request is closed by the manager (or by you) with `node src/cli.mjs close-pr <old run> --replaced-by <new run> --yes`, which comments on it naming the new one and records who asked. It refuses unless the new run, of the same project and with its pull request open or merged, works on the same board item or names the old run (its id, branch or pull request) in its instruction. Anything else (your clone on another branch or with changes, GitHub refusing for another reason), the manager tells you what to do.
- **After it.** The run shows "Merged", by you or by the manager; its item on the board becomes done, and its pull request notice goes away. A merge from the app is news to the manager (`merged`). The crew can never merge: the command refuses to run inside a step.

### Talking to an agent at work

A click on an agent at work (in Operations, the Crew section, the crews by project or the project in focus) opens a panel at the side of the app:

- **Live, step by step.** The step and the task, then each action of the agent (a command it ran, a file it read or edited, a search) and the text it writes, read from the step's log (`data/runs/<id>/<NN>-<agent>.jsonl`) as it grows. The panel scrolls by itself while you are at its end, follows the run to its next step and never reloads the app.
- **Direct talk.** Write to the agent in the panel. Your message reaches it without losing its work: Chiefmate waits for the actions under way to finish (at most 2 minutes), stops the agent at that safe point and resumes the same Claude Code session (`--resume`) with your message as its next turn, on the same branch and working copy, with the step's clock kept. The agent answers you in one short message, shown next to yours, and goes on. Every step keeps its session for this.
- **The agent can ask you too.** A request the agent makes with `needs-you` (see above) shows in the panel. While the agent waits for it (`--wait`), what you write answers the request: the waiting command hands your answer over and nothing is interrupted.

Every exchange is kept in the run (`talk` in `data/runs/<id>.json`). At the end of the step, its report gets a section "Direct talk with <you> during this step" ("<you> guided: …", "<agent> answered: …"), which the next steps and the manager's final review read. The manager also gets a summary of the latest direct talk in the situation it receives with each of your messages, and the review checks that the work follows what you said. A message can only go to a step going on: between two steps, or when the run was canceled or hit the account's limit before it was delivered, it is marked as not delivered.

### The prompt builder (optional)

If you keep your project instructions in a document of blocks, Chiefmate can put each step's instructions together from it instead of the project's `notes`. The document is Markdown, kept outside the repository: in a library (`prompt_builder.library_file`, see below) or in a file on this computer (`prompt_builder.file`):

```markdown
# Projects
// selection: one
// label: Project
// DOCS = folder Docs{CODE}
## My project
// tags: code
// CODE = MYPROJ
Work on {CODE}, following its documentation ({DOCS}).

# Modules
// selection: several
## Board
// access: Trello
Update the card on the board when you finish.
## Start the system
// requires: code
Start it in development mode.

# Rules
// selection: automatic
## Code rules
// include with: code
Keep the existing comments.
## Browser sign-in
// include with: access
Open the browser and wait for me to sign in ({ACCESS}).

# Ready choices
// selection: combinations
My project with the board = My project + Board + Start the system
```

- A first-level heading opens a section and a second-level heading a block; the document's order is the prompt's order. Lines starting with `//` set options (each also in Portuguese):
  - on a section: `selection` (`seleção`): `one` (`uma`), `several` (`várias`), `automatic` (`automática`), `combinations` (`combinações`: ready choices, one per line, `Name = Block + Block`) or `ignore` (`ignorar`); `label` (`rótulo`): the prefix of its blocks' headings, as in `## Project: My project`.
  - on a block: `tags`; `access` (`acessos`): services it needs signed in, joined into `{ACCESS}` (`{ACESSOS}`); `requires` (`requer`): the block can only be chosen when these blocks or tags are chosen; `include with` (`incluir com`): when an automatic block comes in.
  - In `requires` and `include with`, a comma asks for every item and a vertical bar for any of them (`home | work`); `always` (`sempre`) holds for any choice and `access` (`acessos`) when a chosen block needs a sign-in. An automatic block without `include with` comes in when it shares a tag or an access with the blocks chosen, or always when it has neither.
  - `NAME = value` sets a variable (on a section, it serves all its blocks), and `{NAME}` in the text takes its value. A value can hold other variables, of the block, its section or the other blocks chosen; a variable left with no value stays as `{NAME}` and is reported (in the step's context, in a session's dry run and in the app's prompt builder).
- A step gets the project's block (`projects.<id>.prompt_block`), the environment (`prompt_builder.environment`), the optional modules (`projects.<id>.prompt_modules`, or `--modules A,B` on a task) and the automatic blocks their choice brings, each under its heading, except the automatic blocks the project turned off (`projects.<id>.prompt_exclude`, also left out of its live sessions). A requirement not met is reported in the step's context.
- Blocks that need you live (a browser, a board, a confirmation) are kept: the agent asks for you with `needs-you`. A sentence that conflicts with the crew's rules (pushing, other branches, pull requests) is replaced by a note saying Chiefmate's rules prevail, and the adaptation is recorded in the step's context.
- Without the file, the project's `notes` are used as before.

Where the document comes from:

- **A library** (recommended): `"library_file": "<library>/<path>"`, such as `"notes/PROMPTS/PROMPTS_BUILDER.md"` for a library `notes` in `library`. It is read from Chiefmate's copy of that library (`workspaces/.library/<library>`), which comes before `file`; `file` is used only while that copy has no such file yet. The copy is brought up to date from GitHub before every run, and by **Reload document** (the prompt builder screen), **Update from the library** (the Crew section) or `node src/cli.mjs prompts-sync`. The screens show the document's path and the date and message of its last commit (the copy is shallow: its history is deepened when needed to find it). To change the document, change it in the library and send it to GitHub.
- **A file on this computer**: `"file": "<path>"`, read as it is.
- **Google Docs** (optional): to copy the document from Google Docs into `file`, set `prompt_builder.doc_id` and `browser_cdp`, install the optional `playwright-core` (`npm install --no-save playwright-core` in the Chiefmate folder) and run `node src/cli.mjs prompts-sync`, or use the button in the Crew section or **Reload document** in the prompt builder screen. Chiefmate borrows your browser's session to download the document's Markdown export: it never changes the document and never touches your tabs. Without `doc_id` (or with `library_file`), the app says nothing about Google Docs.

### The prompt builder in the app

**Builder** in the menu (`#builder`, or `#builder/<id>` with a project chosen), or the **Builder** tab of a project's page (`#project/<id>/builder`), works with the whole document as you would by hand:

- The ready combinations are buttons at the top (on a project's screen, the ones with its block; **All** shows the others). Each section lists its blocks: one per section for `one`, any number for `several`. A block whose `requires` is not met can't be marked. The automatic blocks come in by themselves, marked "automatic" with a dashed margin and the reason under their name (came in with its `include with`, by sharing a tag or an access, by its `requires`, or always), and can be turned off or marked by hand.
- The final prompt is shown block by block, as it is put together, variables filled in (the ones without a value are underlined and pointed out). Each block has a color of its own, the same on its checkbox and in the margin of its part of the prompt (solid when chosen, dashed when it came in by itself). A block marked comes into the prompt with a brass background that fades in about 2 seconds, and the prompt scrolls to it; a block unmarked leaves with a brief red mark. With reduced motion asked for by the system, nothing fades or scrolls smoothly. **Edit** shows the prompt as text, to change it before it goes anywhere; changing the blocks writes it again.
- **Open live session** opens Claude Code or Codex in your clone of the project (with the project's profile for that tool), with this prompt as the first message, as it is, and shows the conversation in the project's **Live** tab. When that profile already has a session open in the app, write to it there, or end it first.
- **Send as a task** queues a task for a member of the project's crew, with the manager's review if you want it. The steps get this prompt as the project's instructions, instead of the one put together from the document (lines that conflict with the crew's rules are still adapted). The instruction is optional: without one, the agent does what the prompt asks.
- **Copy** puts it on the clipboard, and **Reload document** brings the document up to date: the library's copy from GitHub (with `library_file`), a new copy from Google Docs (with `doc_id` and `browser_cdp`) or the file on this computer read again.
- The last choice made for each project is remembered (`data/prompt-builder-choices.json`); the first time, the screen starts with the project's block, the environment and its modules (**Work live**, on the project's page, always starts with these). The screen shows where the document comes from and how recent it is (for a library, its last commit and when the copy was updated), and warns when the copy is more than 7 days old.

## Project pages

Each project has a page of its own in the app (`#project/<id>`): pick it in the list of projects at the top of the window, or click the project's name in the crews by project, the focus, the Projects section, Planning or Missions.

At the top:

- **The name**, the sentence `about` it, and **one line of status**: whether the crew is working on it (and on what), it is in the queue or stopped; its memory on this computer; and the branch checked out in your clone.
- **The main actions**:
  - **Talk to the agent in charge** opens the **In charge** tab, with the conversation with the project's agent in charge (see "Talking to the agent in charge" below).
  - **Work live** opens the project's **Builder** tab with its usual blocks (its block, the environment and its modules), ready for a live session, a task or the clipboard. Without a prompt builder, it opens a live session with Claude Code in the **Live** tab.
  - **New task for the crew** goes to the form in **Tasks and history**: who does it (a member of the project's crew or, when the project has a team lead, a request for the lead to plan), what to do and whether the manager reviews it.
  - **Start environment** / **Stop environment**, for a project with `dev_start` in its settings (such as `"dev_start": "npm run dev"`): runs that command in your clone, in a window of its own (Windows Terminal, or PowerShell), through `node src/cli.mjs dev-run <project>`. Its processes count in the project's memory, marked "development environment", and stopping it closes the window with everything it started. From the command line: `node src/cli.mjs dev <project>` (`--dry-run` shows what would run) and `dev stop <project>`.
- **More**: **Open folder** (your clone in File Explorer), **Open in VS Code** (shown when the `code` command is found), **Live session: Claude Code** and **Live session: Codex** (in the app, in the **Live** tab), and **Open in an external window: Claude Code** and **: Codex**, for who prefers the tool's own window. A session opens in your clone of the project, with the project's own profile for that tool when `sessions` has one; otherwise an automatic profile (`project-<id>-claude`, `project-<id>-codex`), never written to the settings, whose first message has the project's sentence `about` it, its block of the prompt builder (`prompt_block`) and the environment (`prompt_builder.environment`), when there is a copy of the prompt builder. A Claude Code session uses `default_model`.
- **Waiting for you**, as notices of their level (see "What needs you"), when something of the project needs you: the crew's requests (`needs-you`), with **I did it** or a question's options, a live session's permission requests, with **See** and **Allow**, and the board's items waiting for you.

Below, the tabs (`#project/<id>/<tab>`):

- **At a glance**: the crew now, the last run and the open items on the board, each opening its tab; **the project** (your own clone, `local_clone` or `Documents/GitHub/<repository name>`, and its branch; how its work is delivered, a pull request or a branch handed to your clone with `"deliver": "local"`; the repository, the site, the personal documentation and the development environment's command); and **the project on this computer**: its state, its memory and its processes, with the button to stop them, and its development environment.
- **In charge** (`charge`): the project's agent in charge, its requests to the manager with their state, and your conversation with it (see below). Its mark counts the requests still open.
- **Live** (`live`): the project's live sessions in the app and their conversation (see "Live sessions"): those open, with their state and memory, a **New session** button per tool, the latest ended ones (to read or resume) and, below, the conversation of the one chosen (`#project/<id>/live/<session>`).
- **Crew** (`crew`): its crew, with its team lead above it when it has one, each with what it is doing (a click on a member at work opens its panel); and its live sessions, those open with **End** and its profiles with **Open**.
- **Tasks and history** (`tasks`): its runs going on and in the queue, each with a button to cancel it, the form for a new task, and its recent history: the latest runs, with their result, the pull request and a **Reports** button that opens each step's report in the Log.
- **Planning** (`planning`): its open items on the planning board, with a button that opens Planning filtered by the project.
- **Files** (`files`): the project's folders, to browse and open in the viewer (see "Viewing files"): the crew's working copy, your clone, the libraries and the extra folders of `viewer`.
- **Context** (`context`): see below.
- **Builder** (`builder`, when `prompt_builder` is set): the prompt builder with the project chosen (see "The prompt builder in the app").

Without your own clone of the project, the buttons that need it are disabled and the page says to set `local_clone`.

### Viewing files

The app opens documents itself, read only, on this computer and through the remote access alike, so you don't need the computer at hand to see what a task made:

- **Images** (PNG, JPEG, WebP, GIF, SVG and others) fill the screen, with **Actual size** for zoom and a gallery of the folder's images (or the run's): the arrows, the keyboard's arrows, or a swipe on the phone.
- **PDF** opens in the browser's own reader (on a phone, in a tab of its own).
- **Markdown** shows formatted, and **text** files as they are.
- **CSV and XLSX** show as a table, with one tab per sheet, a fixed header and the row numbers; a preview shows at most 5,000 rows, and says so. The workbook is read with Node.js itself (an XLSX file is a zip of XML parts): no dependency.
- **Any other file** shows its name, size and date, with **Download**.

Where it opens from: the file paths in the conversation with the manager, the news, the steps' reports and the runs' summaries become links (a relative path is looked for in the run's files, then in the project's copies: your clone, its reference library and the crew's working copy; when several have it, the newest wins and the viewer says which copy it came from; when none has it, the message says where it looked and which copy is behind its origin's main branch, such as a clone without a merge done on GitHub; a full path that no longer exists is looked for the same way in the project's other copies); each run in the Log has **Files**, what it created or changed on its branch (with thumbnails of its images), read from its branch even after the crew moved on; and each project's **Files** tab browses its folders.

What it may open (its roots): each project's working copy (`workspaces/<id>`), your own clone of it, the reference libraries (`workspaces/.library`) and the folders you add in `viewer.extra_roots`. Nothing else, and never, even inside them, Chiefmate's `data/` and `config/chiefmate.json`, `.git`, `node_modules`, `.env` files, keys (`*.pem`, `*.key`, `id_rsa`…) or anything named for secrets. Each file is at most 50 MB. See "Security".

### The Context tab

The page's **Context** tab (`#project/<id>/context`) shows everything that is passed to whoever works on the project, put together by the same code the runs use, in the real order and with the source of each part:

- **For each member of the project's crew, its team lead and the manager's final review**: the system prompt added to Claude Code's own (the agent's `agents/<id>.md`, the installation's `crew.<id>.extra_instructions`, the project crew member's or the team lead's extra instructions, the lead's role); the repository's instruction files Claude Code would load (`CLAUDE.md` at the start, those in subfolders when it works there; `AGENTS.md` is listed but only Codex reads it by itself); then the first message, part by part: the run and the task (shown with placeholders), the project memory kept by the team lead, the project instructions from the prompt builder (each block with how it came in: chosen as the project's block, the environment or a module, by "include with", by a shared tag, by "requires" or always), the project's `notes` and `agent_notes`, the libraries and the personal documentation, and Chiefmate's rules for the crew. Then the model and effort, the folders allowed and the paths denied, the tools allowed and denied, and the MCP servers.
- **Sizes**: each part, each block and each member's total, in approximate tokens (about 4 characters per token). Claude Code's own system prompt and tool definitions are not counted.
- **What each live session of the project opens with**: its first message and its blocks.
- **Since the last run**: for each member, what changed against the last `.context.md` a real step of the project wrote (the model, the system prompt, each section of the prompt, the blocks, the folders, the tools, the MCP servers and the instruction files). The run's own parts (its task, the reports before) are not compared.

Below, **Change the context**: turn the prompt builder's optional modules on (`prompt_modules`) and its automatic blocks off for the project (`prompt_exclude`), and edit the project's `notes` and, for each member, its extra instructions (the team lead's and a project crew member's stay in the project; a member of the general crew's are the agent's notes for the whole installation, `crew.<id>.extra_instructions`) and its `agent_notes`. **Preview** shows each setting that changes and what each member and live session would get (the lines that leave and come in, and the size before and after); **Save** writes the settings and records the change in `data/projects/<id>/context-history.jsonl`, shown as the tab's history. Nothing is saved without a preview of the same changes.

From the command line: `node src/cli.mjs project-context <project> [member]` prints the same, with the texts (`--short` leaves them out, `--json` gives the data).

### Talking to the agent in charge

Each project has an agent in charge: its team lead when it has one (`lead`), else the first member of its own crew, or the generalist of the general crew. **Talk to the agent in charge**, on the project's page, opens your conversation with it in the **In charge** tab (`#project/<id>/charge`). It is one conversation per project, kept: the next time, it carries on where it stopped (a conversation that ended resumes when you write).

- **It talks, answers and plans, and changes nothing.** It is a live session in the app (see "Live sessions" below) with a profile of its own, `project-<id>-charge`, never written to the settings: it opens in your clone of the project (or in the crew's working copy, when there is no clone), reads the project's files, its own documentation and the web, and has no shell and no editing. It never publishes anything. It sees only its project: other projects' working copies and clones, the libraries the project doesn't list and Chiefmate's `data/` are out of reach, as for a step. It has no external tools (MCP).
- **It carries the project's context, and only this project's**, given again with every message: its own instructions (a team lead based on the manager doesn't bring the manager's work), its role in this conversation, the project's sentence, site and `notes`, the project's memory kept by the team lead (`data/projects/<id>/memory.md`, read only here) and its requests with their state.
- **A request to the manager.** When there is something to do, the agent agrees on it with you and sends it to the manager: what you asked, what it intends to do, its size (S, M or L, shown as P, M and G in Portuguese), its risk and, when you said so, that it can be done now. The conversation shows "Request #N sent to the manager"; the manager hears of it as news (`owner_request`) and in its situation.
- **The manager's answer**, with `node src/cli.mjs request <id> approve|hold|ask-owner|reject --note "<why>"`:
  - **approve** queues the work for the project, linked to the request: an `ask` for its team lead, else a task for the agent in charge with the manager's review. It goes the usual way: the crew, the reviews and a pull request (or a local branch) that you approve;
  - **hold** leaves it waiting, with the reason;
  - **ask-owner** brings it to you as a card in Decisions, with **Authorize**, **Wait** and **Refuse**: your click decides the request at once;
  - **reject** refuses it and says why.
- **Where you see it.** Each answer comes back to the conversation as a line ("The manager authorized request #3…"), and the agent reads its requests' state with every message. The **In charge** tab lists the requests with their state: **With the manager**, **Authorized** (with its run and the run's state; **Done** once merged), **Waiting**, **With you** (with **Decide**, which opens Decisions) and **Refused**; the answered ones fold under "Answered".
- **What still holds.** The manager answers within its usual rules (the account's usage, the size of what it queues, your authorization for what is big or risky), and nothing goes live without your approval.

The requests are kept in `data/manager/owner-requests.json`; the conversation, as any live session's, in `data/sessions/`.

## Live sessions

Besides the work the crew does in the background, you can open a conversation with an agent to work together, live, inside the app: review a text with Claude Code while Codex helps you with something else in another project, for example. Several sessions go on at once (one open in the app per profile: a project has one per tool, and a book can have two profiles of its own). Each session is a profile in `sessions`:

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
- `prompt_blocks`: blocks of the prompt builder, by name, in any section. They are put together as for a step: the automatic blocks they bring come along and the variables are filled in. Nothing is adapted to the crew's rules: you are there. Without `prompt_blocks`, the session starts with no first message.
- `model`: optional.
- `mcp`: optional, the external tools (`mcp_servers`) released to the profile, as `["playwright"]`. A Claude Code session also gets those released to its project (`projects.<id>.mcp`), in the app and in a window; `--dry-run` lists them.
- Each project also gets an automatic profile per tool it has no profile of, opened from its page (see "Project pages"). Operations lists only the profiles in your settings.

Open one with its **Open** button in Operations, from the project's page (the **Live** tab, **Work live**, **More** or the prompt builder), or with `node src/cli.mjs session <profile>` (`--dry-run` shows the folder, the command and the first message without opening anything). Chiefmate writes the first message to `data/sessions/<id>.md` and records the session in `data/sessions/<id>.json`. Opening a profile that already has a session open in the app shows that one.

**In the app** (the default), the conversation is shown in the project's **Live** tab, or in a view of its own (`#session/<id>`) for a session outside the projects, linked from Operations:

- **Each message is one turn** of the tool, run headless in the session's folder and resuming the same conversation of the tool every time: `claude -p` with `stream-json` and `--resume` (as the conversation with the manager), or `codex exec --json` and then `codex exec resume <thread>`. The first message is the first turn.
- **What the agent says and does shows as it happens**: its text, and each action (commands run, files read, edited or written, searches), with the time; a failed action in red. While it works, its last action and the time of the turn are shown.
- **The queue**: messages sent while the agent works wait in the session's queue (where they can be removed) and go together, in order, as the next turn. **Interrupt** stops the turn at once; the conversation goes on, and the next message tells the agent it was interrupted.
- **The state** is always in view: working, paused for an update, your turn (the agent waits for you), asks your permission, or ended. **End** stops the turn going on; the history stays, and **Resume** (or simply writing) carries on in the same conversation of the tool.
- **The history** of each session is kept in `data/sessions/<id>.jsonl`: your messages, the agent's text, its actions, the permissions and the notes (interrupted, ended, resumed). The raw output of the tool goes to `data/sessions/<id>.raw.jsonl`. `node src/cli.mjs session log <id> [n]` prints the last entries; `node src/cli.mjs session say <id> "<message>"` writes to it.
- **The manager writes to a session only when you ask it to** (`session say <id> "<message>" --owner-asked`): the message shows as "Manager, at your request", and the agent is told who wrote it.
- **Claude Code** starts without your own configuration, as the crew's steps do: no user settings, hooks, plugins, skills, MCP servers of your own or `~/.claude/CLAUDE.md` (`--setting-sources project,local`, `claudeMdExcludes`, `--strict-mcp-config`); its only external tools are those released to its project or profile (`mcp`). The project's own instruction files still apply. Reading, editing and the terminal are allowed without asking; what leaves the computer or changes where it goes (`git push`, `gh pr`, `gh repo`, `git remote`, and a change on GitHub through its API, such as `gh api` or a web request opening a pull request) is refused until you allow it, however the command is written (`git -C <folder> push`, inside `bash -c`, after `cd x &&`): Chiefmate's own guard checks each command before it runs. A refused action becomes a **permission request**, in brass at the top of the conversation, on the project's page and in Operations, with a short line in the band at the top of the app and a Windows notification. It says in plain words what will happen, where (the repository and branch, or the folder), what changes, whether it can be undone and the risk (low, medium, high or unknown), with the command folded under **See the command**: **Allow** lets it for the rest of the session and tells the agent to go ahead; **Refuse** closes it.
- **Codex** runs with its own configuration (`~/.codex`), in a `workspace-write` sandbox and without asking (`approval_policy="never"`): there is no one to ask in the middle of a turn, so what its sandbox refuses comes back as a failed action, and you decide in the conversation. When it is not signed in, the session asks for you as a step does with `needs-you`: a band at the top of the app and a Windows notification tell you to run `codex login`; the session starts by itself once you are signed in (or when you click **I did it**).
- A turn's processes count in the session's memory while it runs; between turns, a session in the app uses no memory.
- **An update doesn't cut a turn off.** A Claude Code turn going on pauses at a safe point (the actions under way finish first), shown as "Paused for an update", and carries on by itself after the restart, in the same conversation; a Codex turn is awaited. A turn cut off otherwise (Chiefmate stopped or crashed) is noted in the history, and the next message tells the agent. When Claude Code's conversation is not where Chiefmate expected after such a cut ("Session ID ... is already in use"), the turn tries again resuming it.

**In a window of its own**, for who prefers it (**Open in an external window** in the project's **More** menu, or `--window` on the command line): Chiefmate opens Windows Terminal (or PowerShell, when there is no Windows Terminal) in the session's folder, running the tool with the first message. Claude Code starts without your own configuration and asks before acting, as usual; Codex gets the folder (`-C`) and the model (`-m`). A first message longer than the command line allows (about 24,000 characters) is replaced by a request to read the file. A window you close yourself is noticed within a minute or so, and its conversation stays in the tool's own history.

Operations lists the sessions open: in the app or in a window, their state, memory, since when, a link to the conversation and an **End** button. The sessions also count in the Projects section (in their project's memory, or in a row of their own for a library folder), where they are never offered for stopping. The manager gets one line per session in its situation (where it is, its state, its last action or its permission request, and the last thing the agent said) and reads a session's history with `session log <id>`. They are yours: the manager doesn't end them or write to them unless you ask, and the self-update doesn't wait for them.

## Requirements

- Windows 10 or 11. Scheduling, notifications and shortcuts are Windows-only. The server and the command line should run wherever Node.js does, but that is untested.
- Node.js 22 or newer.
- Claude Code, installed and signed in.
- For Codex sessions only: the Codex CLI (with `codex exec --json` and `codex exec resume`). Windows Terminal is used for the sessions opened in a window of their own, when it is installed.
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
- registers the `chiefmate:` address that the notifications use;
- creates the watchdog's task, which checks Chiefmate every 10 minutes from outside it (see "The watchdog").

Run it again whenever you change a mission's schedule. To remove everything it created, run `scripts\uninstall.ps1`.

## Settings

`config/chiefmate.json` is yours: it stays on your computer and never goes to git.

| Key | What it sets |
|---|---|
| `owner` | Your name, so the manager knows who it answers to |
| `language` | `en` or `pt-BR`: the app, the notifications, the manager's answers and the reports |
| `default_model` | The model for agents that don't set one |
| `quick_model` | The model of the short calls that write the runs' titles, summaries and final summaries (`"haiku"` by default, with no tools); `false` turns them off, and the instruction's first sentence and the steps' own summaries are used instead |
| `attribution` | `false` keeps the crew's commits and pull requests from crediting Claude (they are credited to you alone); always off in a project with `no_trace` |
| `backup_dir` | A folder of your own, such as one in a private repository, where Chiefmate keeps an up-to-date copy of these settings |
| `viewer` | The file viewer: `extra_roots`, a list of more folders (absolute paths) it may open besides the projects' folders and the libraries. Empty by default |
| `ui` | The app's own settings: `voice_input`, the microphone for dictation in the message fields (see "Dictation"). On by default; `false` hides it |
| `projects` | For each project: `repository`, `main_branch`, `setup` (such as `npm ci`), `checks` (such as `npm test`), the `playbook` the crew follows, a sentence `about` it, optional `notes` for every agent and `agent_notes` for specific ones, and an optional `language` for its pull requests and commits. Optional: `crew` (its own crew), `lead` (its team lead, see "The crew"), `mcp` (external tools it releases), `prompt_block`, `prompt_modules` and `prompt_exclude` (the prompt builder), `dev_start` (the command that starts its development environment from its page, such as `npm run dev`), `merge_by_owner: false` when someone else reviews and merges its work (its cards then have no Approve). See also "Local delivery" below |
| `missions` | For each mission: the `project`, the `steps` (an agent and its part, in order), the final `review`, the `schedule` (`days` such as `["mon"]` and a `time` such as `"09:00"`) and the `eve_reminder` time |
| `crew` | Settings for one agent in this installation only, such as `{ "writer": { "model": "claude-opus-5-5", "max_minutes": 90, "extra_instructions": "..." } }` |
| `library` | Reference libraries: git repositories the manager and the crew may read, such as your personal documentation. Each has a `name`, a `repository`, a `main_branch` and a sentence `about` it, and optionally `local_clone`, your own clone of it, where the live sessions of its folders open. A project uses one with `"library": ["<id>"]`, or with `"docs": "<id>/<folder>"` for its personal documentation, which then takes precedence over the instructions inside the project's own repository |
| `max_parallel` | How many runs of different projects may go on at once (3 by default). Within a project, one at a time |
| `sessions` | The live sessions' profiles: `name`, `tool` (`claude` or `codex`), `project`, `library_folder` or `cwd`, `prompt_blocks` and optionally `model` and `mcp` (see "Live sessions") |
| `limits` | When runs pause: `pause_at_5h_window` and `pause_at_plan_week`, as shares of your account's usage (0.85 is 85%) |
| `plan_resets` | The plan's free resets, which Claude Code doesn't report: `[{ "kind": "full", "expires": "<ISO date>", "used": false, "note": "..." }]`. Easier from the Usage section or `node src/cli.mjs reset-grant` |
| `mcp_servers` | External tools (MCP servers) the crew may use, in Claude Code's format: `{ "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } }`. Nothing is released until a project or an agent lists it in `mcp` |
| `browser_cdp` | The address of your own browser with remote debugging on, such as `http://127.0.0.1:9333`: sign-ins asked by the crew open there, and the prompt builder is copied through it. Any local program can control a browser with remote debugging on: prefer a separate profile |
| `needs_you` | `{ "max_wait_minutes": 120 }`: the longest a step waits for you before it goes on without you |
| `prompt_builder` | The optional prompt builder: `{ "library_file": "<library>/<path>", "file": "data/manager/prompt-builder.md", "doc_id": "<Google Docs id>", "environment": "<block>" }` (`library_file` or `file`; `doc_id` only to copy it from Google Docs) |
| `auto_update_mode` | How the self-update installs an approved update (see "Chiefmate improves itself"): `"pause"` (the default) pauses the work going on at a safe point, installs and resumes it by itself; `"wait"` installs only once no run is going on and the manager is free |
| `autopilot` | The optional autopilot (see "Planning"): `{ "enabled": false, "week_pace": 0.95, "stop_at_5h_window": 0.85, "quiet_hours": "", "daily_report": "08:00" }`. `quiet_hours` such as `"23:00-07:00"`; `daily_report: false` turns the report off. Read on every check, with no restart |
| `manager_updates` | The manager's news in the conversation (see "News from the manager"): `true` (the default, every event), `false` (none) or a list of the events that wake it, such as `["run_failed", "pr_ready", "needs_you"]` |
| `usage_reader` | The optional reading of your usage page on claude.ai (see below): `{ "enabled": false, "every_hours": 4 }`, and `browser` with the path to Edge or Chrome if it isn't found |
| `watchdog` | The watchdog (see "The watchdog"): `{ "rescuer": true, "model": null, "max_minutes": 15, "every_minutes": 60 }`. `rescuer: false` keeps Claude out of it (you are only told); `model` is the rescuer's (`default_model` when null); `every_minutes`, the shortest time between two rescues |
| `remote_access` | The optional use from your laptop and phone through Tailscale Serve (see "Remote access" below): `{ "enabled": false, "host": "<pc>.<tailnet>.ts.net", "logins": ["<your Tailscale login>"], "port": 4748 }`. Off by default; read when Chiefmate starts |

The libraries are read from a copy that Chiefmate refreshes from GitHub before use, in `workspaces/.library/`, so the crew can read them but never change the original. To have the crew change a library, add its repository as a project too: the changes then arrive as pull requests, like everything else.

**Local delivery.** For a project whose work must not go to GitHub on its own, such as a repository you share with a team, set `"deliver": "local"`. The crew works the same way, but the result is a branch handed to your own clone (`local_clone`), never pushed. You review it there and decide what to send. Related settings:
- `"main_branch": "current"` starts every run from the branch checked out in your clone, so the crew starts where you are working;
- `repository` may be your clone's folder itself, which makes copying instant and includes commits you haven't pushed;
- `clone_filter` (such as `"blob:none"`) makes a partial copy of a very large repository;
- with `local_clone` set, the first copy borrows the objects your clone already has (`git clone --reference-if-able`), so only what it lacks is downloaded. The copy then depends on that clone: don't delete or move it;
- `no_trace` (on by default with local delivery; `false` turns it off) keeps Chiefmate out of what others see: the branch gets a neutral name from the run's title, `wip/<title>` (another prefix with `"deliver_branch": "work/"`, and `-2`, `-3`... when your clone already has that name, never overwritten), the commits Chiefmate makes carry the run's title, and the crew is told never to name Chiefmate or an AI in commits, file names (temporary ones too), code or documentation. Before the final review and again before the handover, the run's commits, file names and added lines are searched for traces (only the run's own: commits already on a branch of the repository, such as the main branch's merged in during the run, and the lines they brought are left alone): the review must remove them, and while any is left the branch is not handed over;
- `"deliver_branch": "current"` hands the work straight onto the branch checked out in your clone, by a fast forward, without switching branches: only when the clone is still on the branch the run started from and has no changes to tracked files. The run is then already merged; otherwise the work stays on its neutral branch for you to merge.

**Projects on this computer.** The Projects section finds a project's processes by its folders: `local_clone`, `repository` when it is a folder, `Documents/GitHub/<repository name>` in your user folder when it exists, the working copy in `workspaces/` and any extra folders in the project's `local_dirs`. The development environment started from the project's page counts too, with everything it started.

**Remote access (optional).** To use the app from your laptop or phone, with this computer on, Chiefmate works behind [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve): your devices join one private network (a tailnet), and Serve gives the app a private HTTPS address that only that network reaches. Nothing opens to the internet, and the app still listens on this computer only.
1. Install Tailscale on this computer, the laptop and the phone, signed in with the same account (with two-factor sign-in on). On this computer, turn on **Run unattended** and turn off key expiry for it in the admin console.
2. In the admin console, turn on MagicDNS and HTTPS certificates. Give this computer a neutral name: it appears in public certificate logs.
3. Let only your own user reach this computer, on port 443, in the access rules. Allow by user, not by tag: tagged devices send no identity, and Chiefmate refuses them.
4. Run `tailscale serve --bg 4748` once (it survives restarts).
5. In the settings, set `remote_access` with `"enabled": true`, `host` (this computer's name in the tailnet, such as `pc.tailnet.ts.net`) and `logins` (your Tailscale login, such as `you@example.com`), and restart Chiefmate.
6. Open `https://<host>` on the other device. On the phone, "Add to home screen" makes it an app.

**On the phone**, the app fits the screen and keeps its size: nothing is wider than the screen, the title bar keeps the work in focus, and a bar at the bottom holds Conversation, Decisions, Operations and Projects, with **More** for the other sections, Planning first (each with its count and mark, on one line under its name). The conversations with the manager and with a live session fill the screen, with the message field fixed at the bottom and kept above the keyboard. While the keyboard is open in a conversation, only its last messages and the field stay: the bottom bar, the notices, the title bar and the headers step aside, the field grows up to five lines and then scrolls inside, Send stays beside it (and keeps the keyboard open for the next message), and everything comes back in place when the keyboard closes. On a touch screen, Enter starts a new line and only Send sends (the field says just "Write to the manager"); on a computer, Enter sends and Shift+Enter starts a new line. Tables become cards, the notices band keeps one notice of at most three lines, and buttons are at least 44 px high on a touch screen. The app doesn't put the cursor in the manager's field by itself there, so the keyboard opens only when you tap it.

Chiefmate then opens a second listener, on `127.0.0.1:4748`, for Serve alone. It answers only when the address is the tailnet name, a command comes from that same address (Origin) with the `x-chiefmate` header, and the `Tailscale-User-Login` that Serve adds is one of `logins`. Serve removes that header when a device sends it, and Funnel (the public internet) sends none, so a Funnel turned on by mistake is refused too. What opens a window or a program on this computer (a folder, VS Code, a development environment, a session in a window) is refused from there: do it on the computer. The app's own port refuses the tailnet name, so pointing Serve at it doesn't work.

**To put a project under Chiefmate:**
1. add it to `projects`;
2. write a playbook in the project's repository: what each agent should do and how the project's files work;
3. create a mission for it, if you want a schedule;
4. run the installer again.

## Planning

The Planning section is your board: what is to be done in each project, kept by you and by the manager.

- **Each item** has a number, a project, a title, an optional description, a priority (high, medium or low), a status (proposed, waiting for your decision, approved, future, to do, queued, in progress, waiting for you, completed, discarded), when it was created and last updated, an optional agent to do it and an optional link to a run (its id) or a pull request.
- **In the app:** filter by project, priority and status (open items by default, or all, or the archived ones), sort by priority (then what is waiting for you first), by the latest updated or by number, change the priority and the status right in the list, edit the rest with **Edit**, add items with the form below the list, and archive what you no longer want to see (**Restore** brings it back). The items waiting for you are highlighted at the top.
- **Items follow their runs.** Queue a task or a mission with `--plan <n>` (or link a run to an item with `plan set <n> --run <id>`) and the item changes by itself: queued while the run waits, in progress while it runs, waiting for you when it ends with a pull request to approve (the link to the pull request is kept) or a branch delivered locally, completed when it ends with nothing to approve, and back to "to do" if it fails or is canceled. You can still change the status by hand: the item only moves again when its run does.
- **The manager keeps it too**, with the `plan` commands (see "Command line"), and gets a short summary with each of your messages: the proposals waiting for its triage, your decisions pending, the approved items waiting their turn, the open high-priority items and the ones waiting for you.
- **Proposals from the crew, decided by you.** The work the crew finds along the way doesn't get done on the side, nor flood the queue:
  1. **Propose.** Any agent or team lead, during or at the end of its step, proposes an item with `plan propose <project> "<short title>" --summary "<1-2 sentences>" --agent <member> --priority ...`. It comes in as "proposed", with its author (the step's agent) and run. The crew's rules ask for proposals with a clear gain only, one per idea, checking the board first so nothing is repeated, and never for fixes within a task already approved or the next run of a mission (those are just done).
  2. **Triage, by the manager.** New proposals wake the manager (the `plan_proposed` news, grouped within a minute). It merges duplicates and discards what makes no sense (`plan discard <n> --reason "..."` or `--duplicate-of <m>`; nothing is lost), sets the priority, the agent and the order, and writes a short recommendation: do now, later or discard (`plan triage <n> --recommend now|later|discard --agent ... --note "..."`). The team leads don't triage; the manager never decides for you.
  3. **Your decision.** At the top of Planning, **Decide** (in the important level, also in the attention band and on the project's page) lists the triaged items in order, each with its title, a one-line summary, the manager's recommendation and the agent's face and name, and three large buttons: **Do**, **Later** and **Discard** (which asks for an optional reason). Drag the items to change their order. "Do" turns the item into a task for its agent, with the manager's review, linked to the item; "Later" leaves it for the future; "Discard" sets it aside under "Discarded items", where **Restore** brings it back. On the command line: `plan approve|later|discard <n>` and `plan order <n> <n> ...`.
  4. **No flooding.** At most one task coming from these approvals waits or goes on per project at a time; the other approved items wait their turn, in your order, and the next one starts when the one before ends.
  5. **The autopilot (optional, off by default).** So the work doesn't stop while you are away: when a project's queue empties (nothing of it queued, waiting, going on or paused), Chiefmate wakes the manager (the `idle` news) with that project's items triaged "do now", in your order, and the manager puts the first one that still makes sense on the queue for you (`plan approve <n> --autopilot`), at most one per project at a time. Items recommended "later" always wait for you, and approved items waiting their turn start by themselves. It stops when the 5-hour window passes `stop_at_5h_window` (85%), when the plan's week is ahead of the pace that ends it at `week_pace` (95%; a straight line from 0% when the week starts), and during the optional `quiet_hours` (such as `"23:00-07:00"`). Each empty queue wakes the manager once, until its items or its last run change. Once a day at `daily_report` (08:00), if it did anything, the manager tells you in a short notice (`autopilot_report`) what it queued by itself and where each item is now. Turn it on and set its limits in the Usage section (from the phone too, with the remote access), with `node src/cli.mjs autopilot on` (see "Command line") or in the settings; the Usage section also shows whether it may act now or why it waits, and what it did today: the items it queued, where each is now, and the empty queues it woke the manager for; the items it approved are marked as decided by `autopilot`. It needs the `idle` news on in `manager_updates`.
  - The quick filters above the list show the **Proposed items**, what **Needs you** (decisions and pull requests) and the **Discarded items**, with their counts; a project's page shows its decisions pending under what waits for you.
- **Where it lives:** `data/plan.json`, outside the repository. The first time, if the manager kept a board in `data/manager/plan.md` (a Markdown table with the columns #, Projeto, Item, Prioridade, Situação), Chiefmate imports it, keeping the numbers; a status it doesn't recognize goes into the description, and the item stays "to do" or the closest status.

## Project radar

The Radar section keeps ideas for new systems and sites with high potential. They belong to no project: they are Chiefmate's own, and you choose when to turn one into a project.

- **Each idea** has a short title, a one-sentence summary, the problem and its audience, the fundamentals (the size of the market or the demand, competitors with links, the search trend or interest, the revenue model, your advantage, the risks), scores from 1 to 5 for potential, effort and risk, its sources with links, the date and a status: new, in study, chosen, discarded or became a project. An optional trend series (such as a search index by year) draws a small line on its card.
- **In the app:** a plain summary first (how many new ideas wait for you), a chart of potential by effort (the best bets are up and to the left; click a point to see its card), then the cards, highest potential first, with the status as a colored label and the fundamentals and sources folded under each card. Three large buttons decide: **I want this** puts a proposal on the planning board (under the project `radar`, high priority) for the manager to turn into a project; **Later** leaves the idea in study; **Discard** moves it to the bottom of the page, where **Back to the radar** brings it back. The menu shows how many new ideas there are.
- **Who feeds it:** the manager and a weekly mission, with the `radar` commands (see "Command line"). Every idea needs at least one source with an http(s) link, and an idea whose title is already on the radar (discarded ones included) is refused. A step of a run only adds and updates ideas: the decisions are yours. The manager's situation says how many new ideas wait for you and which chosen ones are waiting to become projects; once the new project exists, the manager marks the idea with `radar set <n> --status project --project <id>`.
- **Where it lives:** `data/radar.json`, outside the repository.

## Usage and limits

Chiefmate measures what really counts on a subscription plan: your account's usage in the 5-hour window and in the plan's week, which Claude Code reports on every run. There are no spending caps in dollars.

- **Before a run starts and before every step**, Chiefmate checks your account (the same account for every run going on). If the 5-hour window or the plan's week is above the share you set in the Usage section (85% and 90% by default), the run waits for the reset and then carries on by itself.
- **If the account runs out in the middle of a step**, that step starts over after the reset.
- **Each step has a time limit** (in the agent's header), in case an agent gets stuck.
- **Alerts at 70% and 90%** of the 5-hour window and of the plan's week, once per threshold and window. They don't pause anything.
- **The autopilot** (optional; see "Planning"): its switch, its limits (the 5-hour window, the week's pace, the quiet hours and the daily report's time), whether it may act now and what it did today.
- **The plan's free resets.** Claude Code doesn't report them, so you record them in the Usage section or with `reset-grant`. Chiefmate shows the ones available and the week's pace (the share used against the share of the week gone by, and whether there is slack). It warns you when the week passes 90% with one available, and 3 days and 1 day before one expires unused.

### Talking while the manager answers

The conversation never makes you wait.

- **Write at any time.** While the manager answers (or renews the conversation), what you send goes to a queue shown under the conversation, marked "queued". Until it is delivered, you can edit or remove each message there.
- **The queue goes together.** When the answer ends, the queued messages go as the next message, in the order you sent them and with the time of each. In the conversation they show when they were sent and when they were delivered. The queue survives a restart of Chiefmate.
- **Interrupt.** The **Interrupt** button ends the current answer at once. The conversation goes on in the same session: whatever the manager had written so far stays, marked "interrupted", and your next message tells it the answer was interrupted, so it checks what it may have left half done. Then the queue goes.
- **See what it is doing.** While it answers, the conversation shows the time it has been at it and its last action (the command it ran, the file it read), updated as it happens, as Operations does for the crew.
- **The same from the command line:** `chat say`, `chat edit`, `chat remove`, `chat interrupt` and `chat` to read the conversation, the last action and the queue (see "Command line"). The manager itself can't write to its own conversation.

### Dictation

Every message field (the conversation with the manager, the live sessions, the agent in charge of a project and the direct talk with an agent at work) has a microphone button beside **Send**, so you can dictate instead of typing.

- **One tap listens, another stops.** While it listens, the button turns red, pulses and says "Listening…". A few seconds of silence stop it too. On a computer, **Ctrl+M** in the field does the same.
- **The words go where the cursor is**, without erasing what you typed; those still being heard show as you speak. Nothing is sent by itself: you review the text and press **Send**.
- **In the app's language** (`language`, Brazilian Portuguese or English).
- **Where it works:** in browsers with speech recognition (Chrome, Edge, Safari, also on phones), on `localhost` or over https (the remote access). Elsewhere, such as Firefox, the button doesn't show.
- **Privacy:** the browser sends the audio to its maker's voice service (Google's in Chrome, Microsoft's in Edge, Apple's in Safari) to be transcribed; Chiefmate never receives the audio, only the text you send. The first use says so once, with **Turn dictation off**; `"ui": { "voice_input": false }` in the settings does the same, and `true` brings it back.

### News from the manager

The manager doesn't only answer: when something you should know about happens, it tells you in the conversation on its own.

- **The events**, by the names `manager_updates` uses: a run finished (`run_finished`), failed (`run_failed`) or paused (`run_paused`); a pull request ready and waiting for your approval (`pr_ready`); a run's work you merged from the app (`merged`), or a merge of yours that failed (`merge_failed`, told at once: the manager queues the fix of a conflict and tells you in one line); a step or a live session that needs you (`needs_you`); an update installed (`update_installed`) or blocked (`update_blocked`); a memory alert (`memory_alert`) or an alert about the account's usage or the plan's free resets (`usage_alert`); a live session that ended on its own (`session_ended`; not one you ended from Chiefmate); a new proposal on the planning board (`plan_proposed`), which the manager triages before telling you what waits for your decision; what the watchdog found and did (`watchdog`); with the autopilot on, a project's queue that emptied with items triaged "do now" (`idle`), which the manager may put on the queue, and the autopilot's daily report (`autopilot_report`); you stepping out or coming back (`away`, `back`; see "Away mode"); your click on a decision card (`owner_decided`: an answer, an approval, "not now" or a discard; see "Waiting for your decision"); a request a project's agent in charge sent from its talk with you (`owner_request`; see "Talking to the agent in charge"), which the manager answers.
- **How it goes.** Chiefmate wakes the manager with a short system message that describes the events and is marked as not coming from you; the manager reads the situation, as with any message, and writes a short, clear notice: what happened and, when something needs you, what to do. It doesn't queue or change anything because of a notice alone.
- **Grouped.** Events within a minute of the first one go together, as one message. If the manager is answering, they wait in the queue under the conversation ("news for the manager", which you can remove but not edit) and go with your queued messages; then the manager answers you and mentions them in the same reply. The news survives a restart, such as the one after an update; news older than an hour when Chiefmate starts is dropped.
- **In the conversation**, a notice has a look of its own: a brass rule on the left, a "notice" tag and the events it is about.
- **Each notice is a turn of the manager**, so it counts on your account's usage like a message of yours. To have fewer, list only the events you care about in `manager_updates`, or set it to `false`. The Windows notifications don't change.

### Away mode

The **Away mode** button, at the top of every screen next to the manager's face, is for when you step out or go to sleep. One click and the manager is told (`away`), and answers in a line or two with what goes on alone meanwhile; the button turns brass and shows since when you are away.

- **The work goes on alone**: runs, the queue, missions and the autopilot carry on as usual.
- **What can wait, waits.** The news that only informs (a run finished, failed or paused, a pull request ready, an update, a memory or usage alert, a live session that ended, the autopilot's report) doesn't wake the manager; it is kept for later. The Windows notifications that aren't urgent don't show either (they stay in the records). A step that needs you, the watchdog, new proposals and the autopilot's empty queues still reach the manager, which does its own part (the triage, the next item) and asks you nothing that can wait.
- **Back.** Click the button again: the manager gets everything kept meanwhile (`back`) and writes you one summary, the most important first, with what waits for you and the questions it kept. The app opens the conversation.

`away` and `back` always reach the manager, whatever `manager_updates` says.

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

## The watchdog

Chiefmate can stop, hang or get stuck, and then it can't tell you so itself. The watchdog checks it from outside: a Windows task (`\Chiefmate\Watchdog`, created by the installer) runs `node src/cli.mjs watch` every 10 minutes while you are signed in, in a process of its own, apart from Chiefmate and its updates.

1. **The check uses no AI.** It looks at whether Chiefmate answers (for about a minute, so a restart after an update isn't taken for a problem), a queue that doesn't start a run ready to go for two checks in a row, a run with no new action for an hour (unless it waits for you), an update installing for over 75 minutes or approved and not installed for over two hours, a live session that doesn't start or whose last turn failed, the computer's free memory and Chiefmate's own, and orphan processes: git, Claude Code (headless) or Codex left alive for over half an hour after what started them ended.
2. **The rescuer, only when it is stuck.** When Chiefmate doesn't answer, the queue, a run or an update is stuck, or there are orphans, the watchdog calls the rescuer: Claude Code, without your configuration, that may read Chiefmate's files and logs and run a closed list of safe actions, and nothing else (it can't change a file):
   - `rescue restart`: stops Chiefmate's server (only the process on its port, and only if it is Chiefmate) with the crew's processes under it, never a live session's or a development environment's window, and starts it as the sign-in does. The runs going on start their step over. Refused while an update installs;
   - `rescue stop-orphans [<pid> ...]`: stops orphan processes, as the watchdog finds them;
   - `rescue resume <run>`: resumes a paused or failed run, at most once a day per run.

   What needs more (code to fix, settings, a decision, a sign-in) is left for you: the rescuer says what to do. It runs at most once an hour (`every_minutes`), for at most 15 minutes.
3. **You and the manager hear of it.** A Windows notification (urgent when something needs you or Chiefmate is stuck) and a notice in the manager's conversation (the `watchdog` news). When Chiefmate doesn't answer, the notice waits for its next start, within the hour. A warning that doesn't need the rescuer (memory, a session, a blocked update) is told once, and again only after six hours.

`node src/cli.mjs watch --dry-run` shows what the watchdog sees, without saving, telling or doing anything. Its state and log are in `data/watch/`, with the rescuers' logs. Turn the rescuer off with `"watchdog": { "rescuer": false }`; to stop the checks, disable the task in the Task Scheduler.

## Chiefmate improves itself

Chiefmate can be one of its own projects. Its crew then works on Chiefmate the same way it works on any project, and you stay in charge of what goes in.

1. **Add Chiefmate as a project** in your settings, pointing at your copy of this repository, with `"language": "en"`, `"checks": ["npm run check", "npm run smoke"]` and `"playbook": "docs/playbook.md"`. The [playbook](docs/playbook.md) tells the crew how Chiefmate is built and which rules a change must keep.
2. **Ask for improvements**, in the Manager section or as a task on that project. Ideas for later go to the repository's issues: the manager can open them for you.
3. **Or give it a routine**: a mission on that project, for example once a week, that works through the open issues.
4. **Approve.** Every improvement arrives as a pull request. When you merge it, your installation updates itself within ten minutes (at once when the merge goes through Chiefmate, or if the manager runs `node src/cli.mjs update-check` after a merge on GitHub). It checks the new version first: if the checks fail, it stays on the current one and tells you. Once it restarts, the app window loads the new version by itself (it waits while you are writing or have a dialog open).

**The work going on doesn't hold the update back.** With `auto_update_mode` at `"pause"` (the default), and whenever you click **Update now** (in the Manager section, under "Crew on board", while an approved update waits) or run `node src/cli.mjs update-now --yes`:
1. no new run starts and the manager starts no new answer: your messages wait in the queue;
2. each run going on pauses at a safe point: its agent finishes the action under way (at most two minutes), and its step is kept to resume the same Claude Code session (`--resume`), told that Chiefmate was updated and should carry on where it stopped. A run preparing its working copy (a first download, say) stops at once and prepares it again when it resumes; a run running its checks or opening its pull request pauses at its next step, or ends first. Meanwhile, "Crew on board" says which runs the update waits for and what each is doing;
3. the update waits for the manager to finish its answer. To not wait, click **Interrupt the manager's answer** in the same place (or add `--interrupt-manager`): the conversation goes on in the same session;
4. the turns of the live sessions in the app pause the same way (a Codex turn is awaited) and carry on by themselves after the restart; their windows and the sessions waiting for your message are left as they are;
5. Chiefmate installs, checks the new version and restarts. The paused runs go first in the queue and resume by themselves, and the messages in the queue go to the manager. If the checks fail, Chiefmate goes back to the version it had and resumes everything the same way (that version is not tried again on its own: a newer one, or **Update now**, is).

With `"wait"`, the update installs only once no run is going on, the manager is free and no live session's turn is going on. Either way, if the work doesn't pause within an hour, Chiefmate stays on the current version, resumes everything and tries again later. Sessions in a window and development environments are never paused or waited for.

The self-update only touches Chiefmate's own files. Your settings, the history and the working copies are never in git, so they are never overwritten. If Chiefmate's files were changed by hand in your installation, it does not update, and the app says so.

## Security

- **Only you reach the app.** It listens on this computer only, and it refuses commands sent by other websites open in your browser. Its answers can't be framed by other sites. With the optional remote access, your other devices reach it only through Tailscale Serve, with your Tailscale login (see "Remote access"). Any program on this computer can reach that second listener and claim a login, as it can already reach the app itself.
- **Agents have limits.** A project's agent in charge, in its talk with you, only reads: no shell, no editing, no external tools. The crew cannot push to GitHub, open or merge pull requests, or change the repository's address. Claude Code's rules (`git push`, `gh pr`, `gh repo`, `git remote`) only match a command's first words, so Chiefmate's own guard (`src/guard.mjs`) checks each command of the crew's steps and the manager's conversation before it runs, and refuses any publication however it is written: `git -C <folder> push`, inside `bash -c`, after `cd x &&`, or a change on GitHub through its API (`gh api`, or a web request opening a pull request). Each refusal is noted in `data/runs/<run>/<step>.guard.jsonl` (a step) or `data/manager/guard.jsonl` (the manager).
- **The watchdog's rescuer has a closed list.** It runs without your configuration, may read Chiefmate's folder (not the claude.ai browser profile) and run only the `rescue` actions and a few read-only commands; it can't change files. The `rescue` actions refuse to run inside a crew's step or the manager's answer.
- **Merging needs you.** Chiefmate merges a run's work only with your authorization (see "Merging with your authorization"). The crew never merges; the manager only asks.
- **Each step sees only its project.** Other projects' working copies and documentation, the libraries a project doesn't list and Chiefmate's `data/` are denied to the file tools by permission rules (see "What each step sees"). A shell command can still read them: this is not a sandbox.
- **None of your own configuration.** Agents run without your Claude Code settings, hooks, plugins, skills, `~/.claude/CLAUDE.md` and MCP servers, and without the variables of your own Claude session. The only external tools are those in `mcp_servers`, released by project or agent.
- **The short calls have no tools.** The titles, summaries and final summaries come from `quick_model` with every tool off (`--tools ""`), in a folder of Chiefmate's data, without your configuration: they only read the text they are given and write a few lines.
- **Sign-ins are yours.** Agents never type passwords: they ask for you with `needs-you`, and the address opens in your browser. The address comes from the agent (only `http` and `https`), so look at it before you act on it. With `browser_cdp`, remote debugging leaves that browser open to any local program: use a profile of its own.
- **Your data stays home.** Your settings, the history and the working copies (`config/chiefmate.json`, `data/`, `workspaces/`) never go to git.
- **The file viewer only reads.** No route of it writes, moves or deletes a file. It opens only what is inside its roots (see "Viewing files"), checked on the real path once links and Windows junctions are followed, with `..`, other letter cases, streams and network paths refused; `data/`, `config/chiefmate.json`, `.git`, `node_modules`, `.env` files, keys and secrets are refused even inside them. Its answers are never cached (you may open the app on someone else's computer), can't be used by another website, nor by another port of this computer, and never run in the app: HTML and SVG opened on their own are downloads, an SVG is an image only inside the viewer, and everything else is sandboxed. The remote access asks for your login here too.
- **Stopping processes asks first.** The Projects section and `stop-project` show what will stop and end only those processes. They never stop Chiefmate, what started it, the crew at work (cancel the run for that) or a live session (end it in Operations).
- **Live sessions** run Claude Code without your own configuration, like the steps; Codex keeps its own (`~/.codex`). A session works in your own folders, with you present: the crew's rules (no push, no pull requests) are not imposed on it. In the app, Claude Code edits and runs commands without asking, but pushing, pull requests and changing remotes wait for your permission; Codex works in its `workspace-write` sandbox. In a window, the tool asks before it acts, as usual.
- **The optional claude.ai reading** keeps a signed-in browser profile in `data/browser-profile`. See its risks above.

## Command line

The manager uses these commands (all but the `chat` ones, which are yours), and so can you:

```
node src/cli.mjs server [--log]               starts Chiefmate (the shortcut does this for you); --log writes to data/server.log
node src/cli.mjs status                       what is running, the queue, usage and the crew
node src/cli.mjs mission <id>                 queues a mission (--plan <n>: item n of the planning board follows it)
node src/cli.mjs task <project> <agent> "..." queues a one-off task (--review: the manager reviews it at the end;
                                              --modules A,B: optional blocks of the prompt builder; --plan <n>)
node src/cli.mjs ask <project> "..."          queues a request for the project's team lead, who plans it into at most
                                              3 tasks for the crew and reviews them first (--plan <n>)
                                              mission, task and ask take --title "..." (at most about 60 characters) and
                                              --summary "..." (one or two sentences): nothing is generated for them;
                                              and --level 1|2|3, the approval level its decision card shows
node src/cli.mjs level <run id> <1|2|3|none>  sets (or clears) a run's approval level
node src/cli.mjs plan [list]                  the planning board's open items (--project, --status, --priority; --all)
node src/cli.mjs plan add <project> "..."     adds an item (--priority high|medium|low, --status, --description)
node src/cli.mjs plan set <n> --status ...    changes an item (--title, --description, --project, --priority, --agent, --run,
                                              --pr, --level, --archive, --restore)
node src/cli.mjs plan done <n>                marks an item as completed
node src/cli.mjs plan propose <project> "..." for the crew: proposes an item (--summary "<1-2 sentences>", --agent <member>,
                                              --priority); the manager triages it, you decide
node src/cli.mjs plan triage <n> --recommend now|later|discard
                                              for the manager: the item waits for your decision (--agent, --priority,
                                              --note "<why>", --risk "<what to watch>", --order <position>, --level 1|2|3)
node src/cli.mjs plan approve|later|discard <n>
                                              your decision: "approve" makes it a task for its agent, one per project
                                              at a time, in your order (discard: --reason "...", --duplicate-of <m>;
                                              plan restore <n> brings it back)
node src/cli.mjs plan approve <n> --autopilot for the manager, with the autopilot on: puts an item triaged "now" on the
                                              queue of a project whose queue is empty, within the autopilot's limits
node src/cli.mjs plan order <n> <n> ...       puts these items first in your order
node src/cli.mjs radar [list]                 the project radar, highest potential first (--status <s>; --all: discarded too)
node src/cli.mjs radar show <n>               an idea with its fundamentals and sources
node src/cli.mjs radar add "<title>" --summary "..." --potential 1-5 --effort 1-5 --risk 1-5 --source "<name> <https://...>"
                                              adds an idea (repeat --source and --competitor "<name> <https://...>"; also
                                              --problem, --audience, --market, --trend, --revenue, --advantage, --risks,
                                              --series "2024:40,2025:55"; or --file <idea.json>)
node src/cli.mjs radar set <n> ...            changes an idea (the same options, --status, --project)
node src/cli.mjs radar choose|later|discard|restore <n>
                                              your decision: "choose" puts a proposal on the planning board for the
                                              manager to turn the idea into a project (discard: --reason "...")
node src/cli.mjs chat [n]                     the conversation with the manager: the last n messages, what it is doing, the queue
node src/cli.mjs chat say "..."               writes to the manager; while it answers, the message waits in the queue
node src/cli.mjs chat edit <id> "..."         changes a message still in the queue (chat remove <id> takes it out)
node src/cli.mjs chat interrupt               ends the current answer; the conversation goes on and the queue goes next
node src/cli.mjs session [<profile>] [--window] opens a live session, in the app (--window: in a window of its own;
                                              --dry-run shows what it would open); with no profile, lists the profiles
                                              and the sessions open
node src/cli.mjs session log <id> [n]         a session's history: its last n entries (40)
node src/cli.mjs session say <id> "<message>" [--owner-asked]
                                              writes to a session in the app (queued while the agent works); the
                                              manager does it only when you ask, with --owner-asked
node src/cli.mjs session end <id>             ends a live session
node src/cli.mjs dev <project>                starts the project's development environment ("dev_start") in a window of
                                              its own (--dry-run shows what would run); dev stop <project> stops it
node src/cli.mjs cancel <id>                  cancels a run
node src/cli.mjs resume <id>                  resumes a run (--ignore-limits goes past the limits this one time)
node src/cli.mjs ask-owner "<question>" --options "Yes|No|Wait" [--context "..."] [--recommend <option>] [--project <id>] [--level 1|2|3]
                                              for the manager: a question for you, as a card with one button per option
node src/cli.mjs request [list] [--project <id>] [--all]
                                              the requests of the projects' agents in charge (--all: answered ones too);
                                              request show <id> shows one whole
node src/cli.mjs request <id> approve|hold|ask-owner|reject [--note "..."] [--recommend approve|hold|reject]
                                              the manager's answer: approve queues the work (an ask for a team lead, else
                                              a task with the review; --title and --summary as above), hold leaves it
                                              waiting, ask-owner makes it a card for you, reject refuses it; --note is
                                              required except to approve
node src/cli.mjs merge <id> [--yes]           a finished run's merge: shows the pull request (or the local branch), the checks and
                                              the review's verdict; with --yes, merges it (only with your authorization)
node src/cli.mjs close-pr <id> --replaced-by <id> [--yes]
                                              a pull request replaced by a newer run's: shows both; with --yes, closes
                                              it on GitHub with a comment naming the new one (the branch stays)
node src/cli.mjs update-check                 looks for an approved update now (after a merge), instead of within 10 minutes
node src/cli.mjs update-now [--yes]           installs the approved update now, pausing the work going on and resuming it
                                              after the restart (--interrupt-manager: doesn't wait for the manager's answer)
node src/cli.mjs history                      the latest runs
node src/cli.mjs report <id>                  the reports of a run
node src/cli.mjs context <id> [step]          what each step received: prompt, model, tools, folders, MCP servers
node src/cli.mjs project-context <project> [member] [--short] [--json]
                                              everything the project's crew gets now, by source, with sizes in tokens,
                                              its live sessions' first messages and what changed since the last run
node src/cli.mjs needs-you "..." [--url <address>] [--wait] [--check "<command>"]
                                              for a step: asks you to act and, with --wait, waits for "I did it"
node src/cli.mjs needs-you "..." --options "A|B" [--recommend A] [--why "..."]
                                              for a step: asks you to choose, one button per option, and waits
node src/cli.mjs prompts-sync                 brings the prompt builder's document up to date (the library's copy, or Google Docs)
node src/cli.mjs limits --window-5h 0.85 --plan-week 0.9
node src/cli.mjs autopilot [on|off] [--week-pace 0.95] [--window-5h 0.85] [--quiet 23:00-07:00|off] [--report 08:00|off]
                                              the autopilot's settings, whether it may act now and what it did in the last day
node src/cli.mjs ram                          the projects running on this computer and their memory
node src/cli.mjs watch [--dry-run] [--json]   the watchdog's check (the Windows task runs it every 10 minutes); --dry-run only
                                              shows what it sees
node src/cli.mjs rescue restart|stop-orphans|resume <run> [--dry-run]
                                              the rescuer's safe actions, yours too (see "The watchdog")
node src/cli.mjs stop-project <id> [--yes]    lists a project's processes; with --yes, stops them
node src/cli.mjs reset-grant [list]           the plan's free resets (add <YYYY-MM-DD> "<note>", used <n>, remove <n>)
node src/cli.mjs claude-login                 signs in to claude.ai, for the optional usage reading
node src/cli.mjs usage-reader on|off|now      turns the reading on or off, or reads now
```

## Languages

English is the source. The app, the notifications and the reports follow `language` in your settings, and the manager answers in it. A project's pull requests and commits follow the project's own `language`, if it has one. The translations live in `ui/locales/<language>.json`.

## Development

- `npm run check` checks the syntax of every script and lists any text without a translation.
- `npm test` runs the unit tests (`scripts/unit.mjs`, with `node:test`): the file viewer's checks of paths and its CSV and XLSX readers.
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
| `data/` (not in git) | Runs, each step's log and context, the live sessions' first messages and records, the prompt builder's last choice per project, the planning board (`plan.json`), the project radar (`radar.json`), the team leads' project memories (`projects/<id>/memory.md`), the history of the changes made in each project's Context tab (`projects/<id>/context-history.jsonl`), the conversation with the manager, your account's usage, the schedule's and the alerts' state, the watchdog's state and logs (`watch/`) and, if you use the claude.ai reading, its browser profile |
| `workspaces/` (not in git) | The projects' working copies |

Chiefmate has no dependencies besides Node.js. It drives Claude Code (`claude -p`), which uses your account's login and plan. The only optional one is `playwright-core`, for copying the prompt builder from Google Docs (and, if present, for the browser that opens for sign-ins): Chiefmate loads it only when needed and says how to install it when it is missing.

## License

Chiefmate is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE).

- **Free for noncommercial use.** You may use, study, change and share it for personal use, research, hobby projects and teaching, and organizations such as charities, schools and public institutions may use it too.
- **Commercial use needs a paid license.** To use Chiefmate in a business or in a commercial product, contact the author through [GitHub](https://github.com/luanmadson).
