# Playbook: improving Chiefmate

The guide for the crew, and for anyone, changing Chiefmate itself. Read it whole before you start.

Chiefmate improves itself: the crew works on a copy of this repository and every change ends in a pull request. When the owner merges it, each installation updates itself within minutes, once its crew is free. That is why the rules below matter: a careless change reaches running installations.

## How the code is organized

| Place | What it holds |
|---|---|
| `src/server.mjs` | The app's web server and API. It listens on this computer only. |
| `src/runs.mjs` | How a run goes: the working copy, the crew in sequence, the review, the checks and the pull request. Several runs (of different projects) go on at once: what the app shows of each is in `live`, by run id. |
| `src/queue.mjs`, `src/schedule.mjs` | One run per project at a time, runs of different projects side by side up to `max_parallel`; missions on their days and times. |
| `src/sessions.mjs` | The live sessions: the profiles, the first message from the prompt builder, the window (Windows Terminal or PowerShell) that runs Claude Code or Codex, and finding, measuring and ending their processes. |
| `src/manager.mjs` | The conversation with the manager: the queue of messages sent while it answers (delivered together when it ends), the interruption that keeps the session, and the renewal with a summary when its context fills up. |
| `src/machine.mjs` | This computer: the projects' processes, their memory and stopping them (Windows). |
| `src/planning.mjs` | The owner's planning board (`data/plan.json`): its items, the import of the manager's old `data/manager/plan.md`, the items that follow their runs (through `onRunSaved` in `src/store.mjs`) and the summary for the manager. |
| `src/plan.mjs` | The plan's free resets, the week's pace and the alerts (usage, memory, resets), which only warn. |
| `src/usagepage.mjs` | The optional, read-only reading of the account's usage page on claude.ai, through Edge or Chrome. |
| `src/claude.mjs` | Runs Claude Code headless (`claude -p`), without the user's own configuration, and follows each action and how full the context is. |
| `src/access.mjs` | What each step may see: its folders, the permission rules that deny the rest, its MCP servers and the repository's instruction files. |
| `src/needs.mjs` | When a step needs the owner (`needs-you`): the request, the notice, the address opened in the browser and "Done". |
| `src/prompts.mjs`, `src/promptsync.mjs` | The optional prompt builder: reading the document of blocks, putting a step's instructions together, and copying it from Google Docs. |
| `src/workspace.mjs` | git and the projects' working copies. |
| `src/update.mjs` | The self-update. |
| `src/store.mjs`, `src/config.mjs`, `src/i18n.mjs`, `src/notify.mjs`, `src/util.mjs`, `src/cli.mjs` | Records, settings and the crew, translations, Windows notifications, helpers and the command line. |
| `ui/` | The app: plain HTML, CSS and JavaScript modules, with no build step. `faces.js` draws the crew. |
| `agents/` | The crew's default instructions. |
| `config/example.json` | The settings template. Each installation's `config/chiefmate.json` is private and never in git. |
| `scripts/` | Installation on Windows, launchers, `check.mjs` and `smoke.mjs`. |

## Rules

1. **English everywhere**: code, comments, documentation and commit messages.
2. **Every text the user sees is translated.** On the server it goes through `t()` (`src/i18n.mjs`); in the app, through `t()` (`ui/i18n.js`) or a `data-t` attribute in `ui/index.html`. Write `t()` with a plain quoted string, and add each new text to `ui/locales/pt-BR.json` with a Brazilian Portuguese translation. `npm run check` fails when one is missing.
3. **No dependencies.** Node.js built-ins and plain browser APIs only. No build step. The one exception is optional: `playwright-core`, loaded on demand for the prompt builder's copy (and the sign-in browser), with a clear message when it is missing. Nothing else may need it.
4. **Keep the settings compatible.** Installations update themselves, and their settings are not in this repository. A new setting needs a default in the code. Never rename or remove a setting without migrating it automatically.
5. **Security is not negotiable.** Don't weaken any of these:
   - the server listens on 127.0.0.1 only;
   - the Host, Origin and `x-chiefmate` checks on every command;
   - the tools agents may never use (`ALWAYS_DISALLOWED` in `src/runs.mjs`, and the conversation's list in `src/manager.mjs`);
   - the removal of the Claude session's variables in `src/claude.mjs`, and the flags that keep the user's own Claude Code configuration out of every step and every live Claude Code session (`--setting-sources project,local`, `claudeMdExcludes`, `--strict-mcp-config`; `sessionArgs` in `src/sessions.mjs`);
   - what each step may see (`src/access.mjs`): only its project, its own documentation folder and the libraries it lists;
   - the rule that only Chiefmate pushes branches and opens pull requests.

   Any change in these places must be explained in the pull request, under a "Security" heading.
6. **The look**: dark and formal, with thin lines, square corners and brass as the only accent color. No rounded, generic web look. The crew's faces are line art.
7. **Windows scripts** (`.ps1`, `.vbs`) are ASCII-only, with CRLF line endings. A launcher starts Chiefmate with `node src/cli.mjs server --log` and never redirects its output (`>> dataserver.log`): cmd keeps a redirected file locked while Chiefmate runs, and the self-update could not restart it.
8. **One improvement at a time**, small and complete. Update the README and this playbook when your change makes them outdated.

## Where the work comes from

1. The open issues of this repository (`gh issue list --state open`), oldest first, unless one is labeled `priority`.
2. If there are none: what you can see is weak. A bug, an unclear text, a confusing screen, a missing piece of documentation.

Pick one thing and finish it. Say in your report which issue it closes, if any.

## How to test

- `npm run check`: the syntax of every script, and the translations.
- `npm run smoke`: starts a temporary Chiefmate on a spare port, with records of its own in a temporary folder, and checks that the app and the API answer. Never let it send a real message to the manager: that starts Claude Code.
- For a change in the app's look, describe in your report what changed and where, so it can be checked without reading code.

## The pull request

Chiefmate opens it. Its text is in English:
- what changed for the people who use Chiefmate;
- the files;
- how it was tested;
- when relevant, a "Security" section.
