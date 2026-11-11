# Step 5: Side Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The side panel the owner keeps open all day: deals in sections, a bundle's detail, the review queue, and the first-run, scanning, limit, error and stale states, with every paid button showing its price.

**Architecture:** The panel is a React page that reads everything from the service worker through typed messages, as the settings page does. `core/` gains the two rules the panel needs: review answers that a later scan keeps, and paid actions started from a button (verify one listing, look up waiting parts) through the same client and budget guard as a scan. The worker serves the report `buildReport()` already makes, plus the owner's packaging answers.

**Tech Stack:** TypeScript, WXT 0.21, React, plain CSS with the tokens in `extension/styles/tokens.css`, Vitest with React Testing Library and WXT's fake browser, Playwright for screenshots and flows.

**Spec:** `docs/design.md` (Side panel, Behaviour, Words, Do not), mockups `Main`, `Detail`, `FirstRun`, `Limit` in `docs/design/mockups/`, `docs/v1-plan.md` ("Direction update", acceptance criteria 1, 9), `docs/decisions.md`, `CLAUDE.md`.

## Where this stands (step 5 complete, 2026-11-10)

Branch `step-5-side-panel`, not merged. Gate run by the controller on the final commit: typecheck clean, 448 core and 372 extension tests, 30 end-to-end tests. Every screen passed `ui-reviewer` at 360 and 480px: shell, Deals, Detail, Review, first run and the error notice. A final whole-branch review on Opus found five problems that only show when worker and panel run together (progress row, offline at start, unmatched parts, stale quotes, a match answer's price); all were fixed and re-checked. No searches spent; 14 of 250 used this month.

Owner decisions 1 to 6 above were approved on Nov 10. Rulings made during the build are in `docs/decisions.md` (Design, Matching and splitting, Pipeline, Extension).

Who did what: Task 1 Sonnet; 2 Opus; 3 Opus; 4 to 8 Sonnet; small test fixes Haiku; the final fix wave Opus. Reviews: Opus for 2, 3 and the whole branch; Sonnet for 1 and 4 to 8; `ui-reviewer` (Opus) per screen.

Known, left as polish: "Try again now." can show beside a still-disabled Scan now in the hourly block's last minute; an offline refusal under Look up or Verify shows the raw network sentence; a scan message that joins several sentences, and the account check's own HTTP wording, are not put into words. No recorded response yields a match question, so that screen is covered by unit tests only. Open question for the owner: should Scan now show its count?

Next: step 6, the chip on Home Depot product pages and the This page tab.

## Decisions this plan asks the owner for (recommended answers)

1. **Deals are shown in sections**, as decided on Nov 10: Confirmed, Review: inactive listing, Review: missing listing, Contents not known. Section labels follow the Limit mockup (`READY · 3`), rows follow the Main mockup. The Main mockup predates the sections.
2. **The This page tab comes with step 6** (the chip). Step 5 shows Deals and Review only.
3. **Packaging.** The answer to "Do these arrive individually boxed?" is saved per bundle model. A "No, loose" bundle keeps its place but carries an amber `Loose` tag, and its estimate line says loose parts cannot be listed as New on Amazon. There are no eBay prices in version 1.
4. **Review choices need one additive field in `decompose.ts`.** When a DEWALT short code fits several models, the result lists them as alternatives. No rule changes.
5. **Panel buttons that spend searches follow Scan now's budget.** They may use the reserve, show their cost on the button, run one at a time, and are refused while a scan runs.
6. **Packaging answers live in `chrome.storage.local`** as one small map, not in a new IndexedDB store, so no database upgrade is needed.

## Global Constraints

- No SerpApi search in this step's development: every test replays recordings. Only `SerpApiClient` calls serpapi.com, through the budget guard. No retries around a paid call.
- The key never reaches a page. Pages send typed messages; the worker answers only the extension's own pages.
- Every profit figure is labelled an estimate. Every control that spends searches says how many, on the control, before the click.
- Build to the mockups and `docs/design.md`: token colors only, Barlow and JetBrains Mono from the bundled files, mono tabular figures right aligned, a real minus sign, currency with two decimals, ROI as a whole percent, sentence case, no emoji, no decorative icons, no card in a card, no shadows in the panel, real elements only, visible 2px ink focus ring, 120ms opacity on view change at most, `prefers-reduced-motion` respected.
- Vocabulary in the UI: bundle, part, listing, search, scan, estimate.
- Width 360 to 480px: nothing overflows; long titles wrap or clip with the full title available.
- Keep the last data on screen while loading; no spinners or skeletons.
- `core/src/` has no `chrome.*` or `node:*` imports. Default tests use no network.
- A change is done when `npm run typecheck` and `npm test` pass. Small commits, one concern each, staged by file name.

## Review Focus

1. A scan runs while the panel is open: the last data stays, the progress row moves, Stop works, and the report refreshes when the scan ends. Tasks 4 and 5.
2. A paid button is pressed twice quickly, or while a scan runs: at most one action, never above the allowance, a refusal is one plain sentence. Tasks 3 and 6.
3. The owner answers a review question and a scan runs afterwards: the answer stands, for split and for match questions. Task 2.
4. No scan yet, a scan that found nothing, SerpApi unreachable: the panel says why in one sentence and never shows invented data. Tasks 5 and 8.
5. 360px wide with a long title and a four-figure profit: nothing overflows and the figures stay aligned. Tasks 4 to 8, by screenshot.

## Routing

| Task | Model | Why |
| --- | --- | --- |
| 1 Contracts, report and packaging messages | sonnet | Worker messaging with a written contract |
| 2 Review answers that scans keep | opus | Splitting and scan state |
| 3 Paid actions from the panel | opus | Search budget |
| 4 Panel shell and shared pieces | sonnet | UI, then `ui-reviewer` |
| 5 Deals tab, with the limit notice | sonnet | One screen, then `ui-reviewer` |
| 6 Detail | sonnet | One screen, then `ui-reviewer` |
| 7 Review tab | sonnet | One screen, then `ui-reviewer` |
| 8 First run, error and stale states | sonnet | One screen, then `ui-reviewer` |
| 9 Step gate | controller | Gates 4 to 6 of `docs/orchestration.md` |

Code reviews: Opus for Tasks 2 and 3; Sonnet for the rest. `ui-reviewer` once per screen after its code review's fixes, on screenshots at 360 and 480px, re-checked by resuming it. Order: 1; then 2 and 4 in parallel; then 3; then 5, 6 and 7 in parallel worktrees (each owns its screen's files and its own e2e spec); then 8; then 9.

---

### Task 1: Contracts, report and packaging messages

**Files:** Modify `core/src/scan/types.ts` (the three shared types below), `extension/lib/messages.ts`, `extension/lib/worker.ts` (+ test), `extension/lib/prefs.ts` (+ test).

**Interfaces (write exactly; `ReviewAnswer`, `PaidAction` and `Quote` go in `core/src/scan/types.ts`, `messages.ts` imports and re-exports them):**

```ts
// extension/lib/messages.ts — added to Request
  | { type: 'getReport' }                                                          // Reply<PanelReport>
  | { type: 'setPackaging'; model: string; packaging: 'retail_boxed' | 'loose' }   // Reply<null>
  | { type: 'answerReview'; id: string; answer: ReviewAnswer }                     // Reply<null>  (Task 2)
  | { type: 'quote'; action: PaidAction }                                          // Reply<Quote> (Task 3)
  | { type: 'runPaid'; action: PaidAction }                                        // Reply<null>  (Task 3)

export interface PanelReport extends ScanReport {
  /** The owner's packaging answers by bundle model, upper case. A model not here is not answered. */
  packaging: Record<string, 'retail_boxed' | 'loose'>;
}
/** An index into the review item's `choices` (split) or `candidates` (match), or none of them. */
export type ReviewAnswer = { choice: number } | { none: true };
export type PaidAction =
  | { kind: 'verify'; brand: string; model: string; asin: string }
  | { kind: 'lookUp'; parts: { brand: string; model: string }[] };
export interface Quote {
  /** Searches the action would spend now. */
  searches: number;
  /** One plain sentence when it may not run now; null when it may. */
  refusal: string | null;
}
```

- [ ] Tests first: `getReport` returns `buildReport`'s sections and review plus the packaging map; `setPackaging` saves, upper-cases the model, survives a worker restart, rejects any other value with a plain sentence. `answerReview`, `quote` and `runPaid` reply `{ ok: false }` with `Not available yet.` until Tasks 2 and 3 replace them.
- [ ] Implement; packaging map under one key in `chrome.storage.local`, validated on read like settings. Commit.

### Task 2: Review answers that scans keep

**Files:** `core/src/decompose.ts` (additive only), `core/src/pageSplit.ts`, `core/src/scan/types.ts`, `core/src/scan/runner.ts`, new `core/src/scan/answers.ts`, tests; `extension/lib/worker.ts` (+ test) for `answerReview`.

**Interfaces:**

```ts
// Decomposition gains (decompose.ts):
  /** Whole readings the model number allows when it cannot choose, e.g. kit + DCF891B and kit + DCF921B. */
  alternatives?: string[][];
// splitWithPage puts both readings on a disagreement:  alternatives: [modelReading, pageReading]
// ReviewItem gains (types.ts):
  /** Split questions: the readings the owner can choose from, each a list of parts. Empty for match questions. */
  choices: string[][];
// answers.ts
export async function applyReviewAnswer(store: ScanStore, id: string, answer: ReviewAnswer, now: number): Promise<void>;
```

Rules: a split answer `{ choice: i }` sets the bundle's split to `{ components: choices[i], status: 'resolved', notes: ['parts chosen by you'] }` and the item's answer to the parts joined by `,`; `{ none: true }` answers `none` and leaves the bundle in Contents not known. A match answer `{ choice: i }` saves `{ status: 'matched', asin: candidates[i].asin, grade: null, decidedBy: 'user' }`; `{ none: true }` saves `{ status: 'none', decidedBy: 'user' }`. Every later scan keeps a user's split (the runner reads the answered item before splitting) and a user's match (already the rule). An answer to an unknown id, an answered item or an index out of range is refused with a plain sentence. A stored review item without `choices` (saved before this step) reads as `[]`.

- [ ] Tests first, on recorded data: the DEWALT short code that fits two models yields two choices; 337440459's page with model `DCK200D1P1WB606` yields the model-number and the page readings; answering a choice resolves the bundle and the next scan keeps it; a match answer survives a scan; `none` answers; refusals. Every existing test passes.
- [ ] Implement; the worker's `answerReview` calls `applyReviewAnswer` and broadcasts state. Commit per concern.

### Task 3: Paid actions from the panel

**Files:** new `core/src/scan/paid.ts` (+ test), `core/src/scan/runner.ts` (share the lookup step, no behaviour change), `extension/lib/worker.ts` (+ test).

**Interfaces:**

```ts
export function quotePaid(action: PaidAction, saved: { listingAnswers: (brand: string, model: string) => boolean }, budget: BudgetView): Quote;
export async function runPaid(deps: { client: SearchClient; budget: BudgetView; store: ScanStore; now: () => number }, action: PaidAction): Promise<void>;
```

Rules: `verify` costs 1 search (`engine=amazon_product` for the ASIN): the detail page upgrades the match's grade by the existing grading, or sets it to review with the reason. `lookUp` costs 1 search per part that no saved listing already answers: each runs the scan's own lookup step and its rules. The quote refuses with the budget's own sentence when the cost does not fit the manual-trigger budget (the reserve may be used, down to zero). The worker refuses while a scan runs (`A scan is running.`) and runs one paid action at a time (a second request gets the same refusal). Ledger labels `panel:verify` and `panel:lookup`. Errors are stored without the key.

- [ ] Tests first, replayed: verify `B0B3JWF5ZV` for `PBLRC25B` upgrades the grade from the recorded detail page; look up `PBLRC01B` matches from the recorded search; a part a saved listing answers costs 0; a quote above the budget refuses and `runPaid` then spends nothing; two `runPaid` at once spend once; during a scan both refuse.
- [ ] Implement. Commit per concern.

### Task 4: Panel shell and shared pieces

**Files:** `extension/entrypoints/sidepanel/*` (App, Header, Tabs, ProgressRow, StatusBar, `sidepanel.css`), new `extension/lib/format.ts` (+ test), new `extension/lib/pageClient.ts` (the options page's `worker.ts` and `useAppState.ts` moved here; the settings page imports them from here), `e2e/panel-shell.spec.ts`.

- Header: mark, `Split Finder`, **Scan now** (ink) or **Stop** while a scan runs, settings icon button opening the settings page. Tabs: Deals and Review with counts; Review's count is an amber tag above zero. Progress row under the tabs while scanning: `Scanning · page 3 of 4 · 12 searches used`, from `lastJob`. Footer: next scan time on the left (or `Scans when you click Scan now`), searches left with a small meter on the right. Sort control (Profit, ROI, Discount) remembered in `localStorage`, guarded by try/catch.
- `format.ts`: `money(n)` → `$1,234.50`; `profit(n)` → `+$337.30` / `−$22.70` (U+2212); `roi(fraction)` → `45%` / `−6%`; `when(ms, now)` → relative under an hour, else local time, or local date and time when not today.
- [ ] Tests first: format cases above; the shell renders the counts and switches Scan now to Stop on a state change; e2e screenshots of the shell at 360 and 480px (idle and scanning). Commit; `ui-reviewer` against `Main.dc.html` header, tabs and footer.

### Task 5: Deals tab, with the limit notice

**Files:** `extension/entrypoints/sidepanel/Deals*.tsx`, its CSS, test, `e2e/panel-deals.spec.ts`.

- Sections in order Confirmed, Review: inactive listing, Review: missing listing, Contents not known, each `LABEL · n` (Limit mockup), empty sections hidden. Rows as in the Main mockup: title, brand and model, price, discount and match state on the left; estimated profit and ROI right aligned; a loss row in the loss color; a Contents not known row shows `Needs your answer` (amber tag) when a review question is open, else `Contents not known`. Sort applies within each section. A row is a link to Detail; Enter opens it.
- Limit notice at the top when the last job stopped at a limit (Limit mockup): what stopped it in one sentence, how many parts wait, `Change the limit`. Rows of bundles whose parts wait show **Look up · N searches** (Task 3 quote, then `runPaid`).
- Empty: no scan yet (`No scan yet. Scan now looks at Home Depot's DEWALT and RYOBI bundles.`); a scan that found nothing (`The last scan found no bundles.`). Stale line `Prices seen 4 days ago` when the oldest shown price is older than the freshness setting.
- [ ] Tests first, from a report built on the replayed recordings: section order and counts, sort, loss formatting, the limit notice and Look up cost, empty texts. e2e screenshots at 360 and 480 (list, limit, empty). Commit; `ui-reviewer` against `Main` and `Limit`.

### Task 6: Detail

**Files:** `extension/entrypoints/sidepanel/Detail*.tsx`, CSS, test, `e2e/panel-detail.spec.ts`.

- As the Detail mockup: back to Deals, Open on Home Depot; brand, title, model, price seen time; headline estimated profit and ROI; cost, sells for, after fees; the estimate line with the fee settings and a Change link; `PARTS · n`, one block per part with model, short name, price, nets, ASIN link, grade label (`Barcode verified`, `Verified`, `Title match`, `Chosen by you`, `No listing`), and **Verify · 1 search** for Title match; the packaging question until answered, then the answer and a way to change it; `Loose` handling per decision 3; **Copy ASINs** (primary) and **Export row** (a one-row CSV download). Escape goes back.
- [ ] Tests first: values from a replayed report; Verify shows its quote and is disabled with the refusal sentence when refused; packaging answer saves; Copy ASINs copies the ASINs joined by a space. e2e screenshots at 360 and 480 (unanswered and answered packaging). Commit; `ui-reviewer` against `Detail`.

### Task 7: Review tab

**Files:** `extension/entrypoints/sidepanel/Review*.tsx`, CSS, test, `e2e/panel-review.spec.ts`.

- One question at a time, oldest first: the bundle or part, the reason in one sentence, a `<fieldset>` of radio choices (split: each reading as its parts; match: each candidate's title, price and ASIN), plus `None of these`; **Save answer** saves and shows the next question; a count `2 of 5`. Empty: `Nothing needs your answer.`
- [ ] Tests first: a split question and a match question from the replayed report; answering sends `answerReview` with the right index and moves on. e2e screenshots at 360 and 480. Commit; `ui-reviewer` against `docs/design.md` (no mockup).

### Task 8: First run, error and stale states

**Files:** `extension/entrypoints/sidepanel/FirstRun.tsx`, `Notice.tsx`, CSS, test, `e2e/panel-states.spec.ts`.

- First run as the FirstRun mockup when there is no key; nothing on it can spend a search (acceptance criterion 1). A failed scan start or a SerpApi error: the state's `problem` sentence and **Retry · up to N searches** (the scan's allowance). Offline: `SerpApi could not be reached. Check the connection, then retry.`
- [ ] Tests first: no key shows first run and no paid control; an error shows its sentence and the retry cost. e2e screenshots at 360 and 480. Commit; `ui-reviewer` against `FirstRun`.

### Task 9: Step gate (controller)

- [ ] Typecheck, `npm test`, `npm run test:e2e`, read the outputs; review the step's diff; `npm run budget`.
- [ ] Load the built panel in the owner's Chrome with the replayed or saved data and check each screen against its mockup at 360 and 480px.
- [ ] `docs/decisions.md` entries for the six decisions above and anything the build decided; "Where this stands" here. Stop and report.
