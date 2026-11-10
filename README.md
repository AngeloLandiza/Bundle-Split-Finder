# Bundle Split Finder

Chrome extension that finds discounted tool bundles on Home Depot, splits each into its
parts, matches every part to its Amazon listing and ranks bundles by estimated profit.

This repo is the starting point for version 1: a tested TypeScript core, the search-budget
tooling, the plan and the design. The extension itself is built next (see `docs/dev-prompt.md`).

    npm install
    npm run typecheck
    npm test                 # 80 tests, no network
    cp .env.example .env     # then paste a SerpApi key
    npm run budget           # free: what the account has, what may be spent

| Read | For |
| --- | --- |
| `docs/v1-plan.md` | Scope, architecture, scan flow, acceptance criteria, build order |
| `docs/search-budget.md` | How searches are counted and how the free 250 are spent |
| `docs/design.md` + `docs/design/mockups/` | The extension's design |
| `docs/orchestration.md` | Which model does which task, what runs in parallel, the quality gates |
| `docs/dev-prompt.md` | The prompt to start development in Claude Code |
| `CLAUDE.md` | Rules for any agent working in this repo |

What is and is not verified: the core logic is tested on data read from live pages on
2026-11-09. The SerpApi parsers follow SerpApi's documentation and have not yet been run
against real responses; recording fixtures is step 1.
