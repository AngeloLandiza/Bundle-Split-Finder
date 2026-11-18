# Step 6b: what the first real run showed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three faults the owner's first real scan exposed and remove the two chores it put on him, so the tool is fit to hand to his PM.

**Architecture:** Four independent tasks on disjoint files, run in parallel worktrees and merged by cherry-pick. Splitting stays in `core/src/decompose.ts` and `core/src/pageSplit.ts`; the Home Depot reader in `extension/lib/hdReader.ts`; the two panel features in their own components.

**Tech Stack:** WXT 0.21 MV3, React, plain CSS tokens, Vitest, Playwright e2e on `e2e/replay-server.ts`.

**Spec:** `docs/v1-plan.md`, `docs/design.md`, `docs/decisions.md`; the owner's request of Nov 17 ("do what you recommend to get the perfect product for my PM"); the evidence below.

## Evidence (owner's real run, Nov 17)

- Scan 1 in his Chrome: "Home Depot refused a page; the rest are read next scan." Nothing read, 14 of 15 bundles not known, 3 searches. Scan 2 minutes later read every page. The same in-tab fetch, run by the controller in a tab that had been open a few seconds, returned 200 with `window.__APOLLO_STATE__` for 6 pages at concurrency 3. Likely cause: the doorway tab asks before Home Depot's own page has settled in a cold session. Not proven: the reader keeps no status.
- PSK1212SB ("ONE+ 18V Lithium Starter Kit with (1) 2.0 Ah Battery, (1) 4.0 Ah Battery, and Charger", item 339206615) was offered "PSK12B + PSK12B". Its own page says: `Includes: (1) PBP004 18V ONE+ 4Ah Lithium Batteries, (1) PBP003 18V ONE+ 2Ah Lithium Battery, (1) PCG002 18V ONE+ Charger, and operator’s manuals`. `RYOBI_SB` (decompose.ts:65) splits 1212 into two identical halves; the page's models are never offered, because a RYOBI page is read only through the model-number forms (pageSplit.ts R5).
- 10 of 12 split questions offered one reading that the bundle's page confirmed (kit + accessory set, kit + battery). The owner did not want to answer them one at a time.
- The owner's PM needs every bundle in one file; Deals only exports one bundle, from Detail.

## Global Constraints

- CLAUDE.md rules, all of them. Never guess: a split that is not certain stays `needs_review`; a new reading is offered as a choice, never chosen for the owner.
- No SerpApi call anywhere; tests are on recorded or captured data. Hand-made cases only where none exists, labelled.
- Copy: vocabulary bundle, part, listing, search, scan, estimate. Never "item" or "component" in the UI. Buttons are verbs. Real elements only. Focus ring 2px ink, 2px offset.
- Each task runs `npm run typecheck`, `npm test`, and `SPLIT_FINDER_E2E_PORT=<port> npm run test:e2e`; all pass.
- New decisions are written as decisions.md text in the report; the controller edits docs.

## Review Focus

1. A RYOBI bundle whose page Includes list names deeper kit contents (PCL1600K2-PBP003, page 341644756) must not get a page reading that drops its battery; it keeps its model-number reading only. (Task 1 test.)
2. A special buy with two different halves (PBLRC2501SB) still expands exactly as today. (Task 1 test.)
3. Accept all with one question already answered elsewhere (stale `seen`) must not answer it; the rest still save. (Task 3 test.)
4. A Home Depot answer that is not 200 after the settle wait still stops reading at once, as today; the wait never makes a refusal look like success. (Task 2 test.)
5. Download all with zero bundles: the button is not shown. (Task 4 test.)

---

### Task 1 (Opus): special-buy halves and the RYOBI page's own reading (Rulings 75, 76)

**Files:** Modify `core/src/decompose.ts` (RYOBI_SB form), `core/src/pageSplit.ts` (R5, RYOBI). Test: new `core/test/page-reading.test.ts`, plus existing tests unchanged.

**Interfaces:** Produces no new exports. `splitWithPage` may return an extra entry in `alternatives`.

- **Ruling 75.** A RYOBI special buy whose two 2-digit halves are equal (PSK1212SB) is not a two-part special buy: the form offers no reading for it and the model falls through to the forms after it, as if the pattern did not match.
- **Ruling 76.** In `splitWithPage`, RYOBI, when the result would be unresolved and carries no reading at all (`alternatives` empty or absent), and the page's `Includes` bullets name models: offer one reading, the models exactly as the page writes them (no added B), deduplicated, in page order, without the bundle's own model. It stays `needs_review`, with the note `page names <models>`. When the model number already offers a reading, nothing is added (Review Focus 1).

- [ ] Step 1: tests first, with bullets captured from Home Depot on Nov 17 (label them so):
  - `decompose('RYOBI','PSK1212SB', title, emptyCatalog)` has no `alternatives` containing `PSK12B`.
  - `splitWithPage` for PSK1212SB with the page bullet above: `status 'needs_review'`, `alternatives` deep-equals `[['PBP004','PBP003','PCG002']]`.
  - PCL1600K2-PBP003 with page 341644756's two Includes bullets (copied into the test from the evidence file the controller names in the dispatch) keeps `alternatives` `[['PCL1600K2','PBP003']]` and nothing else.
  - PBLRC2501SB unchanged (existing tests stay green).
  - The recorded-data acceptance tests (214 probable-or-better pairs, criterion 5) unchanged; report before and after counts.
- [ ] Step 2: run, see them fail. Step 3: implement. Step 4: all suites pass. Step 5: commit.

### Task 2 (Sonnet): the Home Depot reader waits for its page and says what it got

**Files:** Modify `extension/lib/hdReader.ts`, its test; `core/src/scan/types.ts` (`PageOutcome` refused gains `status?: number`); `core/src/scan/runner.ts` only for the refusal note.

- The doorway tab, once loaded, waits `settleMs` (default 2500, injectable) before the first in-tab fetch. Nothing else changes: no retry, no second doorway, no other headers (a retry after a refusal is not allowed; it would be working around Home Depot's check).
- A refused page records the HTTP status it got (0 when the fetch threw). The runner's note becomes `Home Depot refused a page (HTTP 403); the rest are read next scan.`, or `(no answer)` for 0. Keep the panel's notice working: check where the sentence is matched in the panel and update that mapping and its tests.
- Tests with the existing fakes: the first `runInTab` happens no sooner than `settleMs` after load; a 403 still stops and skips the rest (Review Focus 4); the status reaches the note.

### Task 3 (Sonnet, Opus review): Review offers "Accept all" for one-reading questions

**Files:** Create `extension/entrypoints/sidepanel/AcceptSuggested.tsx` (+ `.css`), modify `ReviewTab.tsx` to place it, tests in `ReviewTab.test.ts` or a new `AcceptSuggested.test.ts`.

- Which questions: open split questions whose `choices` has exactly one reading. Shown only when there are at least 2.
- Block at the top of Review, before the one-at-a-time question: heading `<N> bundles have one suggested answer`, then a list, one line each: model (figure face) and its parts joined by ` + ` (figure face). Then a primary button `Accept all <N>` and one line under it: `Each bundle gets the parts shown. Questions with more than one answer stay below.`
- The button sends the existing `answerReview` message with `{ choice: 0, seen }` for each, one after another, using each question's own `seen`. A reply that refuses (stale question) is skipped and counted; any other failure stops and shows its sentence. Afterwards: `Accepted <k> of <N>.` plus, when skipped, ` <s> had changed and are still open.`; focus moves to that sentence. Review Focus 3 is a test.
- Real `<button>`, list as `<ul>`, figure face for models, design tokens only. Screenshots at 360 and 480 when `SPLIT_FINDER_SHOTS` is set.

### Task 4 (Sonnet): Download all deals

**Files:** Modify `extension/entrypoints/sidepanel/DealsTab.tsx` (+ `.css`), test in `DealsTab.test.ts`.

- A secondary button `Download CSV` on the Deals summary row (`15 bundles · scanned just now`), left of Sort. It downloads `bundlesCsv(rows)` of every bundle in the current sort order through the panel's existing `api.download`, named `split-finder-deals-<YYYY-MM-DD>.csv` (the owner's local date). Not shown with zero bundles (Review Focus 5). Test on the replayed rows (DealsReal pattern): the file has a header and one line per bundle in sort order.

### Task 5 (controller): merge, docs, QA, real-browser proof

- Cherry-pick the four after the controller's own typecheck, test and e2e. Rulings 75, 76 and the Task 2–4 decisions into `docs/decisions.md`. A QA walkthrough by a subagent on the replay, ui-reviewer on the new screens, then the owner reloads the extension and scans once in his Chrome.

## Where this stands (2026-11-17)

Built and merged on `step-6b-real-run`, not yet on main. Controller's gate on the merged branch: typecheck clean, 721 core and 563 extension tests, 38 of 38 end-to-end.

- Task 1 (Opus): Rulings 75 and 76, with counts; two fix rounds; Opus review and an independent re-check.
- Task 2 (Sonnet): the reader's settle wait and the refusal's HTTP status; Sonnet review.
- Task 3 (Sonnet): Accept all; Opus review, UI review, one fix round, independent re-check.
- Task 4 (Sonnet): Download CSV; Sonnet review, UI review, one fix round checked by the controller.
- QA walkthrough (Opus): all six flows pass; its Major (no source link in Accept all rows) and the whole-branch review's Important (page readings bulk-accepted) fixed in one final round (Sonnet), reviewed by Opus and the UI reviewer.

Open: the real-browser check in the owner's Chrome (reload, scan, Accept all, Download CSV). Whether the settle wait cures the cold-start refusal is unproven until a refusal is seen with its status, or not seen again.
