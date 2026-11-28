# Agents: who they are, their memory, their record and their rank

Each crew member is an agent of its own: a name, a base agent (its role), the projects it works in, a specialty, a rank and a status, plus a memory in each of its projects and a record of everything it did. This is the first of three phases (see "What comes next" at the end).

## Three kinds of agent

| Kind | Where it comes from | Its key | Works in |
|---|---|---|---|
| Your own agent | `agents.<id>` in the settings | its id, such as `ana` | the projects it lists |
| A base agent | `agents/<id>.md` (generalist, writer, curator, designer, promoter), adjusted by `crew.<id>` | its id, such as `writer` | every project without a crew of its own |
| A project's member | `projects.<project>.crew.<member>` | `<member>@<project>`, such as `generalist@site` | that project only |

Without `agents` in the settings, nothing changes: the base agents and the projects' crews are the agents, with the same ids as before. The manager is global and every project's team lead (`projects.<id>.lead`) stays its project's: neither is among the agents.

An agent of your own joins the crew of each project it lists, whether that project has a crew of its own or uses the general crew. One with the id of a member of a project's own crew takes that member's place there. Its id can't be a base agent's, `manager` or `lead`.

```json
"agents": {
  "ana": {
    "name": "Ana", "base": "designer", "projects": ["site"],
    "specialty": "Accessible front end", "instructions": "Check the contrast of every color you add.",
    "model": "claude-opus-5-5", "effort": "high", "tool": "claude", "max_minutes": 60,
    "rank": "junior", "status": "active", "hired_at": "2026-11-27"
  }
}
```

- `base` gives the face, the tools and the instructions (`agents/<base>.md`, with the installation's notes for that base, `crew.<base>.extra_instructions`); `instructions` comes after them, under "Your own instructions", and the prompt says who the agent is (name, specialty, rank).
- `model`, `effort`, `tool` and `max_minutes` override the base's. The effort follows [docs/effort.md](effort.md): `effort <id> <level>` writes `agents.<id>.effort`, and `projects.<id>.effort` still sets it for one project.
- `status`: `active`, or `inactive` for an agent that takes no new work (tasks, missions, the team lead's plans and the board stop offering it). A run already queued for it still runs. The base agents and the projects' members take `status` too, in `crew.<id>` and in the project's crew. A base agent's status and rank are its own, in the general crew: a project's member or team lead based on it keeps its own.
- Tasks, missions, `ask` (the lead plans for the agents of the project's crew) and `plan triage --agent` take the agent's id, or its key: `generalist@site` names the member `generalist` of the project `site`.

## Its memory, one per project

`data/agents/<key>/memory/<project>.md`, outside the repository. Every crew step reads the agent's memory in that project at the start of its prompt and returns it, whole and updated, in a `~~~agent-memory` block at the end of its last message: short lessons for its next tasks there (what worked, the owner's preferences, the project's pitfalls), never secrets nor personal data. Chiefmate takes the block out of the report and saves it once the step is done.

- **Isolation.** The memory of an agent in one project never reaches another project: a step reads only the file of its run's project.
- **Ceiling.** At most 4,000 characters. The agent keeps the most important first and merges or drops what no longer helps; past the ceiling, only the start is kept, with a note asking it to condense.
- Not the manager's nor a team lead's (the lead keeps the project's memory, `data/projects/<id>/memory.md`). `"agent_memory": false` in the settings turns it off for the whole crew.

## Its record

Every crew step that runs is recorded once when its run ends: each step of a run done and, in a failed run, only the step that failed (the steps done wait for its end after a retry or resume, so a failure after them, such as another member's step or the delivery, is not counted against them). It goes to the same register that tells how Codex and Grok do (`data/manager/tools-quality.jsonl`, now for every tool), with the agent behind it. A step redone by `retry` is recorded again, as a new attempt. The runs that ended before this record existed are read from their own files, so the record starts with the history already there.

- **Tasks**: steps that ran. **Approved with no correction**: the step done, no check failed, the run done and the final review fixed nothing in it. **Corrected by the review**: what the review's "Corrections:" line names for the agent (the review writes one line, member by member: `Corrections: writer: two claims without a source; curator: none`); without names, its commits or a line about the whole work count for every step. **Failed**: the step failed. **Mean time** of a step and **last activity**.
- **Defects found**: the defects of Chiefmate the agent reported from a step (`defect report`).

## Its rank

| Rank | What it means | Up, over its latest 20 tasks | Down, over its latest 20 tasks (from 5 tasks on) |
|---|---|---|---|
| Junior | Small, well-bounded tasks, always with the manager's review | 5 tasks or more, 70% or more with no correction, no failure | — |
| Mid-level | The usual tasks of its role (the rank by default) | 10 tasks or more, 80% or more, at most 1 failure | under 50%, or 3 failures or more |
| Senior | Larger tasks and work in several parts | 20 tasks or more, 85% or more, at most 1 failure | under 60%, or 3 failures or more |
| Team lead | Leads a project's team | — | under 70%, or 3 failures or more |

A higher rank means more autonomy and responsibility: larger tasks, reviewing colleagues, leading a team, a higher effort. In this phase the rank is shown and weighed, and changes only this way:

1. Chiefmate checks the criteria (`RANK_RULES` in `src/agents.mjs`) and shows what the record suggests, to the manager (its situation) and to you (the Crew section). A suggestion changes nothing.
2. The manager proposes: `node src/cli.mjs agents propose <key> --rank <rank> --why "<one sentence>"`. The proposal becomes a card in Decisions, with the agent's recent record.
3. You decide on the card (or on the agent's card in the Crew section): **Approve** changes the rank in the settings at once; **Keep as is**, a discard or an answer in your own words keep it. The manager hears of it.

Hiring, deactivating and changing a rank directly are yours: the app, or the command line in your own terminal. The manager may adjust an agent (name, specialty, instructions, model, effort, tool, time limit, projects) with `agents set`.

## Where to see and change it

- **The app**, Crew section: the summary first (agents active, the manager's proposals waiting for you, what the records suggest, how the ranks work), then the org chart of each project (the manager, the team lead and the agents ranked team lead, then the agents), each agent's row with its rank, specialty and record; its card unfolds with the tool, model and effort, the whole record, its latest tasks, its memory in that project (read when opened) and **Adjust**, **Deactivate** or **Reactivate**. **Hire an agent** opens the same form for a new one. A project's Crew tab shows its org chart.
- **The command line**: `agents` (all of them, or `--project <id>`), `agents show <key>`, `agents memory <key> --project <id>`, `agents history [<key>]`, `agents add <id> --base <agent> --projects <id>[,<id>]`, `agents set <key> ...`, `agents deactivate|activate <key>` and `agents propose`. Every change goes to `data/agents/history.jsonl` (who, when, from and to).
- **The manager** sees the agents by project in its situation, with their names, ranks and records, the inactive ones, its proposals waiting for you and what the records suggest.

## What comes next

- **Phase 2: requests between agents.** An agent asks another for help or a review through Chiefmate, never directly: the request goes to the project's team lead (or to the manager where there is none), who accepts it, sends it to the right agent and follows it, all on the record. The rank sets what each one may ask and review (seniors review juniors' work; team leads plan and supervise). An agent ranked team lead may become a project's `lead`.
- **Phase 3: HR.** The manager proposes hiring an agent (its base, specialty, projects and why) and dismissing one whose record stays under its rank's floor, on cards like the rank's; you decide. A dismissal deactivates; its memory and record stay.
