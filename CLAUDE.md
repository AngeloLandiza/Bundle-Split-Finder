# Bundle Split Finder

A Chrome extension for one Amazon seller. It finds discounted DEWALT and RYOBI bundles on
Home Depot, splits each bundle into its parts, matches every part to its Amazon listing,
and ranks bundles by estimated profit. All data comes from SerpApi with the user's own key.

Read `docs/v1-plan.md` before changing behaviour, `docs/design.md` before touching UI, and
`docs/search-budget.md` before anything that could reach serpapi.com. The main session also
reads `docs/orchestration.md`: which model does which task, and what may run in parallel.

## Layout

    core/src/         Pure TypeScript logic. No chrome.* and no node:* imports, ever.
    core/test/        Default tests. Zero network.
    core/test-live/   Opt-in tests that spend real searches.
    scripts/          Node-only tools: budget report, fixture recorder, dev client.
    fixtures/         Recorded SerpApi responses (committed) and the validation set.
    extension/        The Chrome extension. Imports core.
    docs/             Plan, design spec, budget rules, orchestration, mockups.
    .claude/agents/   Two read-only review agents: ui-reviewer and docs-checker.
    reference/        The original Python prototype. Read-only reference.

## Commands

    npm test              unit + replay tests, no network
    npm run typecheck
    npm run ext:build     build the extension into .output/chrome-mv3
    npm run ext:dev       run the extension with live reload
    npm run budget        free: what the account has and what may be spent now
    npm run fixtures:record -- --dry-run
    npm run test:live     spends at most 2 searches
    npm run scan -- --fixtures   free: the whole pipeline on recorded responses
    npm run scan -- --limit N    spends up to N searches (demo bucket)
    npm run package              the versioned zip for the PM, in output/ (see docs/install.md)
    npm run validate -- --dry-run  free: what the validation run would spend; --replay: no network
    npm run audit -- prepare <export.json>   an audit from a real scan (see docs/audit.md)

## Rules that are not negotiable

1. **Search budget.** The development key is SerpApi's free plan: 250 searches a month,
   50 an hour. Nothing may call serpapi.com except through `SerpApiClient` in
   `core/src/serpapi/client.ts`; in Node, only via `openDevClient()` in `scripts/dev-client.ts`.
   Before any command that can spend searches, run `npm run budget`, tell the user how many
   it will spend, and wait for a yes if it is more than 10. Never raise `DEV_ALLOCATION`,
   lower the reserve, add retries around paid calls, or loop over live requests to "see what
   comes back". Record a response once, then work from the file.
   **Only the main session spends searches, one command at a time. A subagent never does**:
   it works from `fixtures/` and the cache. The ledger is shared across git worktrees and a
   lock refuses a second spender, so do not copy `.env` around or set `SERPAPI_STATE_DIR`
   to get past either.
2. **No network in default tests.** If a test needs the network it belongs in `core/test-live/`
   and must skip, not fail, when the budget is closed.
3. **The key is a secret.** Never print it, log it, commit it, put it in a URL you display, or
   write it to a fixture. In the extension it lives in `chrome.storage.local` only and is sent
   only to `https://serpapi.com`.
4. **Never guess.** A split or match that is not certain returns `needs_review` or a lower
   grade. Do not add heuristics that turn an ambiguous case into a confident answer; add a
   test with the real example instead.
5. **Estimates are labelled.** Profit comes from fee settings, not the seller's real fees.
   Any screen showing profit says it is an estimate.
6. **Design follows the spec.** Build from `docs/design.md` and the mockups in
   `docs/design/mockups/`. No UI kit, no Tailwind defaults, no gradients, no emoji, no
   decorative icons, no card-in-card layouts.

## Working style

Plan before coding and show the plan. Small commits, one concern each. A change is done when
`npm run typecheck` and `npm test` pass and any new behaviour has a test built on real data.
When a SerpApi field name is in doubt, check a recorded fixture, not the docs and not memory.
When a choice is made that the code alone does not explain, add it to `docs/decisions.md`:
version 1 will be rewritten, and the rewrite needs to know what was decided and why.
