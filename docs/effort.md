# Effort: how hard each agent works

Every step of a run is a Claude Code session, and Chiefmate starts it with `--effort <level>`: how hard Claude works on that step. This guide says what each level changes, when to use each one and the rule Chiefmate follows. It is built on Anthropic's documentation (the sources are at the end); the advice by kind of task applies that documentation to Chiefmate's crew.

## What effort is

Effort is one control over how many tokens Claude spends on an answer: its thinking, its text and its tool calls together. It is "a behavioral signal, not a strict token budget" ([Effort][effort]). On models with adaptive thinking, such as Claude Opus 5.5, effort is the main control of how deeply Claude thinks: at a higher level it thinks more readily and at greater length; at a lower one it tends to make fewer, combined tool calls and to give shorter confirmations ([Effort][effort], [Steering thinking][steering]).

Effort changes how hard Claude works, not what it knows: a lower level doesn't make it forget anything, it makes it check less and stop sooner.

## The levels

| Level | What Anthropic says it does | Quality | Time | Usage |
|---|---|---|---|---|
| `low` | "Most efficient. Significant token savings with some capability reduction." | Enough for simple, well-defined work; misses more on hard problems | Fastest | Least |
| `medium` | "Balanced approach with moderate token savings." | Good on well-specified work | Fast | Moderate |
| `high` | "Spends as many tokens as the task needs for excellent results." | Excellent on most work | Slower | More |
| `xhigh` | "Extended capability for long-horizon work." | Better on long, agentic and coding work | Slow | High |
| `max` | "Absolute maximum capability with no constraints on token spending." | The most it can do; often a small gain over `xhigh` | Slowest | Highest |

The quotes are from [Effort][effort]. In its notes on some models, Anthropic adds that `max` "runs slower and costs more than at `xhigh`, often for only a small gain" (Claude Fable 5.2), and that on some structured-output or less intelligence-sensitive tasks it can lead to overthinking (Claude Opus 4.7) ([Effort][effort]).

**Usage.** On a Claude plan, the 5-hour window and the week are spent by the tokens the work uses, so a higher level wears them down faster on the same task. Anthropic's pages don't give figures for this; watch the Usage section after a change.

**Default.** When an agent has no effort set (the app shows "default"), Chiefmate passes none and Claude Code uses the model's own default: `medium` for Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.2 ([Model configuration][model-config]), unless the project's own Claude Code settings set an `effortLevel`. Chiefmate's agent files set their own level, so "default" shows only where you clear one.

**`max` and Claude Code.** Claude Code's settings files don't take `max` as a saved level, but the `--effort` flag takes it for the session ([Model configuration][model-config], [CLI reference][cli]). Chiefmate starts each step with the flag, so `max` works for every step. The `CLAUDE_CODE_EFFORT_LEVEL` environment variable would win over the flag; Chiefmate starts each step without this computer's `CLAUDE*` variables, so the level asked is the level used. On Claude Enterprise, an organization's cap runs a higher level at the cap instead, and with the output Chiefmate reads, Claude Code's warning goes only to its debug log: a step's record then shows the level asked, not the cap ([Model configuration][model-config]).

**Codex and Grok.** A member that runs on Codex or Grok (see the README) gets the same level when that tool has it: Codex has no `max`, so a member at `max` runs on Codex's own default, and its step shows "default".

## When to use each level

| Kind of work | Level | Why |
|---|---|---|
| The manager: final reviews and the conversation | `max` | It judges everyone's work and decides what reaches you. A miss there costs more than the tokens. |
| Review of someone else's work (team lead, a crew review) | `xhigh` to `max` | Finding what is wrong takes reading everything and checking sources. |
| Hard code: a bug with no clear cause, a change across many files, security, concurrency | `xhigh` | Long agentic coding is what `xhigh` is for ([Effort][effort]). |
| Ordinary code and site work: a feature with a clear scope, a page, a fix | `high` | Clear work that still has to come out right with no one watching. For agentic coding, Anthropic suggests `medium` for well-specified tasks and `high` for harder or longer ones (its advice for Claude Sonnet 5.5, [Effort][effort]). |
| Research and writing that must be right (articles, sources, facts) | `high` to `xhigh` | Many searches and reads, and every claim needs a source. Anthropic recommends `xhigh` for exploratory tasks such as repeated tool calling and detailed web search (its advice for Claude Opus 4.7, [Effort][effort]). |
| Data with sources (the curator's lists, dates, links) | `high` | Careful but repetitive: each item is checked the same way. |
| Browsing with a sign-in (a site's panel, a form, reading an account) | `medium` to `high` | Most of the work is reading pages and clicking, and the waits for you don't use effort. Use `high` when the site is unfamiliar or a form has consequences. |
| Simple, mechanical tasks: a text adjustment, renaming, moving files, a status reading | `low` to `medium` | Anthropic's suggestion for simple tasks and subagents is `low` ([Effort][effort]). |

Anthropic's advice is to start at the model's default and move one level at a time: up for long work that needs many turns and double-checking, or that you can't quickly check yourself; down for simple work, for as long as the quality holds. Too low a level tends to stop early and come back with unfinished work ([Choosing the right effort level][academy]). Most of Chiefmate's crew starts one level above it, at `high`, because its work runs with no one watching and reaches you only as a pull request: lower a member where its results stay as good, and raise it where it stops early or misses what more care would catch.

## Chiefmate's rule

1. **The manager stays at `max`**, in reviews and in the conversation. It lowers its own level only where that costs nothing in quality.
2. **Each crew member gets the level its kind of task needs**, by the table above; a project can have levels of its own for its crew (for example, the curator at `medium` on a project of simple lists).
3. **When the plan's usage is tight**, lower first the levels of simple, mechanical work, never the reviews.
4. **Your own changes are yours**: the manager adjusts levels as needed, says so in one line, and doesn't undo what you set.

## Seeing and changing it

- **In the app**, the Crew section shows each agent's model and effort as a colored mark, with a picker beside it: the manager has two, one for its reviews and one for the conversation. The crews by project, and the Crew tab of each project's page, have the same mark and picker for that project's crew: a change there counts for that project only. "Effort changes" at the bottom of the Crew section lists the latest: who, when, from and to.
- **On the command line**:

  ```
  node src/cli.mjs effort                                  each agent's effort and where it comes from
  node src/cli.mjs effort --project <id>                   the crew of one project
  node src/cli.mjs effort writer xhigh                     for this installation
  node src/cli.mjs effort curator medium --project <id>    for that project only
  node src/cli.mjs effort manager high --chat              the manager's conversation
  node src/cli.mjs effort writer default                   back to the level before it
  node src/cli.mjs effort history [--project <id>]         the recorded changes
  ```

- **When it counts.** From the next step on: a run going on keeps the step at work as it is, and its next steps (the final review included) use the new level.
- **Where it shows.** Each step of a run records the level it ran with: the run's page in the Log, `node src/cli.mjs report <id>` and the pull request's table show it, with the changes made while the run went on.

## Where a level comes from

The last one found wins:

1. the agent's file, `agents/<id>.md` (`effort`, and `chat_effort` for the manager's conversation);
2. this installation's settings, `crew.<id>.effort` (and `crew.manager.chat_effort`);
3. a member of a project's own crew or its team lead, `projects.<id>.crew.<member>.effort` and `projects.<id>.lead.effort`, or an agent of your own, `agents.<id>.effort` (see [crew.md](crew.md));
4. the project's own levels, `projects.<id>.effort`: `{ "<member id>": "<level>" }`, written by the app and `effort --project`.

The changes are recorded in `data/effort-history.jsonl`.

## Sources

- [Effort][effort] (Claude Platform Docs): the levels, what each does, and defaults and starting points by model.
- [Steering thinking][steering] (Claude Platform Docs): effort and adaptive thinking, thinking and tool calls.
- [Model configuration][model-config] (Claude Code Docs): effort in Claude Code, defaults, precedence and caps.
- [CLI reference][cli] (Claude Code Docs): the `--effort` flag.
- [Choosing the right effort level in Claude Code][academy] (Claude Academy): start at the default and move one level at a time.

[effort]: https://platform.claude.com/docs/en/build-with-claude/effort
[steering]: https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost
[model-config]: https://code.claude.com/docs/en/model-config
[cli]: https://code.claude.com/docs/en/cli-reference
[academy]: https://academy.claude.com/tutorials/choosing-the-right-effort-level-in-claude-code
