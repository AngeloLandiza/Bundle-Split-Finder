# Prompt for Claude Code

Paste everything below the line into Claude Code, opened at the root of this repo.

---

You are building version 1 of **Bundle Split Finder**, a Chrome extension for one Amazon
seller. He buys discounted DEWALT and RYOBI bundles at Home Depot and sells each piece
separately on Amazon. The extension finds today's bundles, splits each into its parts,
matches every part to its Amazon listing, and ranks bundles by estimated profit.

## Read first, in this order

1. `CLAUDE.md` — the rules. They are not negotiable.
2. `docs/v1-plan.md` — scope, architecture, how a scan works, acceptance criteria, build order.
3. `docs/search-budget.md` — how SerpApi searches may be spent. Read it before any command
   that could reach serpapi.com.
4. `docs/orchestration.md` — which model does which task, what may run in parallel, the
   quality gates. You are the controller it describes.
5. `docs/design.md` and every file in `docs/design/mockups/` — the UI you are building.
6. `core/src/` and `core/test/` — the working core. 80 tests pass. Run `npm install`,
   `npm run typecheck` and `npm test` before changing anything.

## How to run the work

You are the controller. Run this session on the most capable model (`fable`) and keep your
own context for planning, decisions and review. You do not implement; subagents do.

- Use the Superpowers skills that are installed. Check the skill list for exact names. The
  design is settled, so skip brainstorming: for each build step, write a plan from
  `docs/v1-plan.md`, show it to me, then execute it with subagent-driven development.
- Route every task by `docs/orchestration.md`: `haiku` for mechanical tasks with a complete
  brief, `sonnet` for ordinary implementation and task review, `opus` for state, timing,
  matching rules and debugging. **Pass the model explicitly on every dispatch.** A task that
  is blocked or fails review twice goes one tier up or gets split, never retried as it was.
- Use the two project agents: `docs-checker` before relying on any Chrome, WXT or SerpApi
  detail, and `ui-reviewer` on screenshots of every UI task before I see it.
- Run read-only agents in parallel freely. Run implementers in parallel only in steps 4
  and 5, after the shared files are merged, each in its own git worktree, at most 3 at once.
- **Only you spend searches.** No subagent runs a paid command. Tell me the cost and wait
  for my yes first, as below.
- In your first reply, show me the routing you will use for step 1 as a short table: task,
  model, why. Do the same at the start of every step.

## What already exists

`core/` is pure TypeScript with no Chrome or Node imports:

- `identifiers.ts` barcode validation · `hdPage.ts` reads a Home Depot page's product data
- `decompose.ts` splits bundle model numbers (RYOBI and DEWALT rules, with real examples)
- `match.ts` grades Amazon listings: exact, strong, probable, review, reject
- `optimize.ts` best combination of listings · `money.ts` fee math and the packaging rule
- `schedule.ts` scan frequency and the monthly usage forecast
- `scanPlan.ts` splits a scan's search allowance; evaluates a bundle
- `serpapi/budget.ts`, `serpapi/client.ts` the budget guard and the only path to SerpApi
- `serpapi/parsers.ts` written from SerpApi's docs, **not yet checked against real responses**

`scripts/` has the budget report, the fixture recorder and the guarded dev client. The
ledger and cache are shared across git worktrees, and a lock allows one spender at a time.
`.claude/agents/` has `ui-reviewer` and `docs-checker`.
`reference/python-prototype/` is the original prototype; read it if a rule's intent is unclear.

## The search budget is the main constraint

The development key is SerpApi's free plan: **250 searches a month, 50 an hour**. Only
successful searches count; cached, failed and errored ones are free; the Account API is free.

- Run `npm run budget` at the start of every session and report the numbers to me.
- The month's plan: 23 to record fixtures, 42 for the validation set (8 moved by the owner on Nov 11), 15 for live tests,
  50 for one real demo run, 100 never touched. The caps are enforced in code
  (`scripts/dev-budget.ts`, `scripts/dev-client.ts`); do not change them without asking.
- Record each response once (`npm run fixtures:record`), then develop against the files.
  Default tests must never touch the network.
- Before any command that spends searches, tell me how many and wait for my yes if it is
  more than 10. Never retry a paid call automatically. Never write a loop that makes live
  calls to explore.
- If I have not put a key in `.env` yet, do everything that needs no key and tell me what
  is waiting on it.

## Decisions already made

- **No server.** Everything runs in the extension: Manifest V3, a service worker, a side
  panel, a content script on homedepot.com, and a settings page.
- **He supplies his own SerpApi key** in Settings. It is stored in `chrome.storage.local`
  and sent only to serpapi.com.
- **Scan frequency is his setting**: only on click (default), every 6 or 12 hours, once a
  day at a time he picks, or every N hours. Use `chrome.alarms`; catch up a missed run once.
- **Home Depot only, DEWALT and RYOBI by default.** No Lowe's, no Amazon seller API, no eBay.
- **Scans are resumable jobs** saved in IndexedDB, because the service worker can be
  suspended at any time.
- **Profit is an estimate** from his fee settings and is always labelled so.

## Stack

TypeScript, React, Vitest. Use WXT for the extension build unless its current docs show a
reason not to; say so before scaffolding if you want something else. IndexedDB through a
small typed wrapper (`idb` is fine). Playwright for end-to-end tests with the unpacked
extension. Plain CSS with the tokens in `docs/design.md`: no Tailwind, no component library.
Bundle the Barlow and JetBrains Mono woff2 files locally.

Check current documentation, not memory, for: the Chrome `sidePanel` API (opening it from a
content-script click), `chrome.alarms` limits, service worker lifetime, WXT's config and
entrypoint layout, and every SerpApi field name. Tell me what you verified and where.

## Build order

Work through the steps in `docs/v1-plan.md` ("Build order"). At the end of each step, run
typecheck and tests yourself, review the whole step's diff, then stop and give me: what was
built, the test count, which model did which task and what had to be escalated, the searches
spent (from `npm run budget`), and anything you were unsure about. Do not start the next
step until I say go.

0. Repo runs. Typecheck and tests green. No searches.
1. Record fixtures (at most 9 searches, after my yes). Correct `parsers.ts` against the
   recordings and replace the doc-shaped samples in `core/test/fixtures.ts` with them.
2. Scan pipeline in `core/` behind interfaces for the client and the store, with an
   in-memory store for tests. Add `npm run scan -- --limit N` that writes
   `output/run_<time>.csv` and `output/review_<time>.csv` and prints searches used. Test it
   end to end on fixtures first. The real run uses the `demo` bucket and needs my yes.
3. Extension shell: manifest, service worker, storage, messaging, settings page with key
   check, frequency, searches per scan, reserve and the live forecast.
4. Side panel: Deals, Detail, Review, and the first-run, scanning, limit and error states.
5. Content script on Home Depot product pages: read the page for free, show the chip, feed
   the This page tab. Handle single-page navigation.
6. Validation set of about 30 bundles in `fixtures/validation.json`, the accuracy report
   from acceptance criterion 6, an accessibility pass, and a build I can load unpacked.

## Quality bar for the UI

This must look and feel like a tool a professional built by hand, not a generated demo.

- Match the mockups to the pixel for spacing, type sizes and colors; read the values from
  the mockup files instead of estimating.
- Build every state in `docs/design.md`, not only the happy path. An unbuilt state is a bug.
- Real elements, full keyboard support, visible focus, 4.5:1 contrast.
- No gradients, shadows in the panel, emoji, decorative icons, oversized rounded cards,
  or filler text. If you want to add a visual element that is not in the spec, ask first.
- After each UI task, open the extension in a browser, take screenshots of every state at
  360px and 480px panel widths, and give them to `ui-reviewer` with the mockup. Fix
  everything it reports before showing me. It did not write the code; you and the
  implementer did, so its verdict counts and yours does not.

## Testing

- `core/` stays covered by unit tests built on real examples. Keep them passing.
- UI: component tests for each state with a fake store.
- End to end with Playwright: load the unpacked extension, serve a local test page that
  contains the real product data block from `core/test/fixtures.ts`, and replay recorded
  SerpApi responses through a mocked fetch. These tests spend zero searches.
- Budget behaviour gets its own tests in the extension: a scan stops at the run cap, a
  scheduled scan cannot touch the reserve, a clicked action can, and a suspended scan
  resumes without paying twice.

## How to work with me

Plan before coding and show me the plan for each step. Keep commits small. When something
in the docs is wrong or unclear, say so and propose a fix instead of working around it. If a
real example breaks a rule in `core/`, add it as a test first, then fix the rule.

Start with step 0, then your plan and routing table for step 1.
