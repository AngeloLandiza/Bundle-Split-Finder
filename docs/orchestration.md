# Orchestration

How the build is run in Claude Code: one controller session that plans, dispatches and
reviews, and subagents that each do one bounded task on the cheapest model that does it well.

The controller reads this file. Subagents do not need it.

## Roles and models

| Role | Model | Does |
| --- | --- | --- |
| Controller (the main session) | `fable` | Reads the docs, writes the plan for each build step, writes the contracts other tasks depend on, dispatches tasks, spends searches, reviews each finished step, talks to the user |
| Hard implementer | `opus` | State and timing: the scan runner and resumable jobs, the service worker and alarms, budget behaviour in the extension, any change to a splitting or matching rule, debugging |
| Implementer | `sonnet` | Most tasks written up in a plan: storage wrapper, messaging, settings page, each side-panel screen, content script, Playwright tests |
| Mechanical implementer | `haiku` | Tasks where the plan already holds the full answer: scaffolding, moving fixtures into tests, the tokens stylesheet, renames, a single-file fix |
| Task reviewer | `sonnet` | Reviews one task's diff for spec and quality. Use `opus` when the diff touches budget, scan state or matching |
| `ui-reviewer` (`.claude/agents/`) | `opus` | Compares screenshots of a built screen with its mockup. Read-only |
| `docs-checker` (`.claude/agents/`) | `sonnet` | Verifies one API or config fact against current documentation. Read-only |

Rules for routing:

- **Always pass the model when dispatching.** A subagent with no model inherits the
  controller's, which is the most expensive one.
- **Escalate, do not retry.** A task that comes back blocked, or fails review twice, is
  re-dispatched one tier up or split smaller. Never the same model with the same brief.
- **Cheap needs a complete brief.** `haiku` only gets tasks whose brief contains the exact
  files, the exact behaviour and the test to pass. A task described in prose goes to `sonnet`.
- **The controller does not implement.** It writes plans and contracts and reviews. Its
  context is the project's memory; keep build output and long diffs out of it by asking
  subagents for a short report.

## Routing by build step

Steps are the ones in `v1-plan.md`.

| Step | Controller does | Dispatched |
| --- | --- | --- |
| 0 Repo runs | Runs install, typecheck, tests | Nothing |
| 1 Fixtures | Runs the recorder after the user's yes (paid) | Correct the parsers against the recordings: `sonnet`. Swap the doc-shaped samples in tests for the recordings: `haiku` |
| 2 Scan pipeline | Writes the client and store interfaces. Runs the real scan after the user's yes (paid) | Scan runner and resume logic: `opus`. In-memory store, CSV writer, command line: `sonnet` |
| 3 Extension shell | Writes the message types and the store schema | Config facts: `docs-checker`. Scaffold: `haiku`. Storage wrapper: `sonnet`. Service worker, alarms, resumable job: `opus`. Settings page: `sonnet`, then `ui-reviewer` |
| 4 Side panel | Nothing but dispatch and review | Tokens stylesheet and shared pieces first: `sonnet`. Then one task per screen and per state: `sonnet`, each followed by `ui-reviewer` |
| 5 Page chip | Nothing but dispatch and review | Side-panel and navigation facts: `docs-checker`. Content script and chip: `sonnet`. Single-page navigation, if it misbehaves: `opus` |
| 6 Check and ship | Runs validation lookups after the user's yes (paid). Confirms each correct ASIN with the user | Accuracy report: `sonnet`. Accessibility review: `opus`. Packaged build: `haiku` |

## What may run in parallel

Parallel work saves time only when tasks cannot collide.

- **Always fine in parallel:** read-only agents. Several `docs-checker` questions at once;
  a `ui-reviewer` while the next task is being implemented.
- **Implementers in parallel only in steps 4 and 5**, only after the shared files are
  merged (message types, store schema, tokens stylesheet, shared pieces), each in its own
  git worktree, at most 3 at a time. One task owns one screen's files and nothing else.
- **Never in parallel:** two tasks that edit the same file; anything in steps 0 to 3; any
  command that spends searches.

More than 3 at once does not help: every task still has to be reviewed, and review is the
slow part.

## Searches

- **Only the controller spends searches**, from one terminal at a time, after the user's
  yes. Subagents never run `fixtures:record`, `test:live` or a live scan. They work from the
  recorded files in `fixtures/` and the cache.
- This is enforced in code as well. The key, cache and ledger resolve to the main checkout
  from any git worktree, so there is one ledger. A lock file refuses a second spender while
  the first is running (`SpendLockError`).
- After every paid command the controller runs `npm run budget` and reports the numbers.

## Quality gates

Per task:

1. The implementer writes the test first, makes it pass, reviews its own diff, commits.
2. A task reviewer that did not write the code reviews the diff against the task brief.
3. For a UI task, the controller takes screenshots of every state at 360px and 480px and
   `ui-reviewer` compares them with the mockup. `CHANGES NEEDED` goes back to an implementer.

Per build step:

4. The controller runs `npm run typecheck` and `npm test` itself and reads the output. A
   subagent saying "tests pass" is not evidence.
5. The controller reviews the whole step's diff on `fable`.
6. `npm run budget`, then stop and report to the user. The next step starts on the user's go.

## Superpowers skills

Use the Superpowers skills that are installed. Read the skill list for their exact names
instead of assuming them. The ones this build expects:

| Skill | Used for |
| --- | --- |
| writing plans | One plan per build step, written from `v1-plan.md`. The design is settled, so skip brainstorming |
| subagent-driven development | Executing each plan: a fresh implementer per task, then review |
| test-driven development | Every implementer |
| systematic debugging | Any failure that is not obvious on first read |
| verification before completion | Gate 4 above |
| requesting code review | Gate 5 above |
| git worktrees, finishing a branch | Parallel tasks in steps 4 and 5, and merging each step |

Where a skill and this repo disagree, this repo wins: `CLAUDE.md`, the search budget, the
model table above, and the stop-and-report gate after each build step.
