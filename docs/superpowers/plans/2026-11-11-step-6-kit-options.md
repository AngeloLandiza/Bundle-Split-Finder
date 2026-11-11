# Step 6: Kits inside bundles, and ways to sell. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break a kit inside a bundle down to its items from the kit's own Home Depot Includes list, and offer each way to sell as an option. Each option carries its estimate and its leftovers.

**Architecture:**
- A pure parser turns a stored page's Includes bullets into kit items: a model or none, a name, and a quantity.
- A kit's contents come only from that kit's own stored Home Depot page. They never come from another bundle's page, and never from a title.
- `buildReport()` evaluates one option per choice of "kit whole" or "kit split into its items", with the existing `evaluateBundle()`.
- The row's headline figures follow a primary option chosen by a fixed rule.
- Scans look up a kit's items only when the kit itself has no active listing, and only after all other work. Otherwise the panel offers "Look up N items" on the option.

**Tech Stack:** TypeScript (`core/` pure), WXT 0.21, React, plain CSS tokens, Vitest, Playwright on the replay server.

**Spec:**
- The owner's answers of Nov 11, 2026, in this conversation and recorded in `docs/decisions.md` by Task 6:
  - "do all of that and give options"
  - leftovers: "everything should not be ignored"
  - "merge first"
- The PO's brief (`docs/v1-plan.md`, "Direction update"):
  - Includes lists name the models.
  - A listing may cover several products.
  - No leftover tools.
- `docs/design.md`, `docs/search-budget.md`, `CLAUDE.md`.

## Global Constraints
- **CLAUDE.md rules 1 to 6 hold.**
  - Nothing reaches serpapi.com except through `SerpApiClient`.
  - Only the controller spends searches.
  - Never guess.
  - Every profit is labelled an estimate.
  - No UI kit, gradients, emoji or decorative icons.
- **Mockups are never edited** (Ruling 31). The options section has no mockup; it follows `docs/design.md` and Detail's existing part blocks, and `ui-reviewer` checks it.
- **A kit's contents come only from a stored `BundleRecord` of the same brand and model whose `page` holds an Includes list naming at least one model.**
  - If there is none, the bundle has one option, as today.
  - Detail says "PCL1600K2's contents are not known yet: its Home Depot page has not been read."
- **Every item counts, except paperwork** (owner, Nov 11).
  - Items with no model number ("18V Charger", "Tool Bag", blades) are never looked up and are always leftovers in a split option.
  - An item named "Operator's Manual" or "Operator's Manuals" (any case, with or without the apostrophe) is dropped.
  - Leftovers are valued as today (`liquidationRate`, default 0).
- **Quantities count.** "(2)" gives qty 2, and no "(n)" gives 1.
- **Copy, exact.** Ruling 68: design.md's fixed vocabulary bans "item" in the UI, so every on-screen "item" below reads "part". The labels in core change in Task 3b, and the panel's copy in Task 4.
  - Option labels:
    - `PCL1600K2 sold whole`
    - `PCL1600K2 split into its parts`
    - With two kits: `PCL1600K2 and PCL1201K2 split into their parts`, and `PCL1600K2 split into its parts, PCL1201K2 sold whole`
  - Section heading: `Ways to sell`
  - Leftover line:
    - `Leaves nothing`
    - or `Leaves 11 parts: 18V Charger, Tool Bag, …`
      - Models with no listing come first, then unnamed items in page order.
      - `×N` follows a quantity above 1.
  - Loose note: `Parts from a kit have no retail box of their own.`
  - Primary marker: `Shown above`
  - Deals row tag when a bundle has more than one option: `N ways to sell`, for example `2 ways to sell`
- **Options per bundle:**
  - With one or two kits: 2^k options.
  - With more than two kits: two options, all whole and all split.

## Review Focus
1. **A kit with no stored page**, or a page with no Includes list naming a model: exactly one option. No contents are taken from the bundle's own page, even when that page lists loose tools (`docs/decisions.md`: an Includes list confirms, never contradicts).
2. **The owner's split answer.** A chosen or typed split that names a kit is expanded like any split. "None of these" gives no options. An answer is never changed by the expansion.
3. **Budget.**
   - A scan never plans a kit-item lookup ahead of any kit-level lookup or refresh.
   - A scan never plans one while the kit has an active listing, or before the kit has been looked up.
   - Free matches from saved Amazon listings fill items without spending.
   - The panel's "Look up N items" quote is exact.
4. **Model collisions.** A kit item with the same model as another part of the bundle adds to that part's quantity. It is never dropped.
5. **Stale data.** When the kit's page is read again with a different list, the next report uses the new list. Nothing stored by this step must be migrated.

---

### Task 0 (controller): record the Amazon responses the options need
Spends **9 searches**. The account showed 14 of 250 used on Nov 11. Run `npm run budget` first and tell the owner the count.

- [ ] Add to `scripts/fixture-requests.ts` one `amazon-search-<MODEL>` request each, with `k: 'RYOBI <MODEL>'`, for:
  - PCL1600K2, P553
  - PCL206, PCL235, PCL500, PCL515, PCL430, PCL660
  - PBP002
- [ ] Run `npm run fixtures:record -- --dry-run`. It must list exactly those 9 as new.
- [ ] Record, run `npm run budget`, and commit the fixtures.
- [ ] Run the replay server's request matching against the 9 new files, and check each is served.

### Task 1 (Opus implementer, Opus review): Includes parser
**Files:**
- Create: `core/src/kitContents.ts`
- Create: `core/test/kit-contents.test.ts`

**Interfaces:**
- Produces:
  - `interface KitItem { model: string | null; name: string; qty: number }`
  - `parseIncludes(brand: string, bullets: string[]): KitItem[]`
  - `kitContents(bundles: BundleRecord[], brand: string, model: string): KitItem[] | null`

- [ ] **Tests first, on the recorded pages** in `fixtures/homedepot-pages/pages-2026-11-10.json`:
  - **317987591** (the plain kit PCL1600K2) parses to:
    - qty 1 each: PCL206, PCL235, PCL500, PCL515, PCL430, PCL660, PBP005, PBP002
    - the unnamed items, in page order, among them `18V Charger` and `Tool Bag`, with no leading "and", and no `Operator's Manuals`
    - no item twice
  - **341645081**: the same models.
  - **328814689**: PBLRC01 and PBLRC25, each qty 1, and nothing else, because the manual is dropped.
  - **A DEWALT page from the recordings** (DCK200D1P1W921B, or another that is recorded) parses by its own bullet form. Read it from the fixture; do not guess its format.
  - **320243741** (PCL1600K2-P553), whose bullets hold no Includes line, gives `[]`.
- [ ] **`kitContents` tests:**
  - It returns null when no stored record has that brand and model.
  - It returns null when the record has no page, or a page with no model item.
  - It returns the newest page's list when two records match.
  - It accepts the model with or without the tool-only `B` suffix, as `pageCatalog` already does.
  - It never reads the asking bundle's own page.
- [ ] Implement:
  - Split each Includes bullet on commas and " and ".
  - Read a leading "(n)".
  - A model is a whole `RYOBI_TOKEN` or DEWALT token that `OFFERABLE_PART` accepts. Everything else is an unnamed item named by its trimmed text.
- [ ] Run typecheck and `npm test`. Commit.

### Task 2 (Opus implementer, Opus review): options in the report
**Files:**
- Modify: `core/src/scan/report.ts`
- Modify: `core/src/scan/types.ts` (`SaleOption`, `BundleRow.options`)
- Modify: `extension/lib/messages.ts`, only if `PanelReport` needs the field passed through
- Tests: `core/test/report-options.test.ts`

**Interfaces:**
- Consumes: Task 1's `kitContents`, `parseIncludes` and `KitItem`.
- Produces:
  ```ts
  interface SaleOption {
    id: string;            // 'whole', or 'split:' + split kit models sorted and joined by '+'
    label: string;         // exact copy above
    splitKits: string[];
    parts: PartRow[];      // model items, one row per model, qty summed
    estimate: BundleResult | null;  // null while any of its parts waits or is unmatched
    leftovers: string[];   // display names, exact rule above
    loose: boolean;        // true when splitKits is not empty
  }
  BundleRow.options: SaleOption[]  // at least 1; options[0] is the primary
  BundleRow.kitsNotRead: string[]  // kit-like parts whose own page is not stored, for Detail's sentence
  ```
  A part counts as kit-like for `kitsNotRead` only when the stored catalog marks it `isKit`. This is the existing rule, and nothing new is guessed.
  The row's `parts`, `estimate`, `uncovered` and `section` are the primary's.

- [ ] **Tests first, on replayed data:**
  - The recorded HD searches, the recorded pages, and Task 0's Amazon responses.
  - Answer PCL1600K2-P553's split with PCL1600K2 + P553.
- [ ] **Assertions:**
  - Two options with the exact labels.
  - The whole option's parts are PCL1600K2 and P553.
  - The split option's parts are the eight models plus P553.
  - The split option's leftovers start with any model that has no listing, then the unnamed items.
  - The split option has `loose: true`.
  - A part has a looked-up match in the replay only after the owner's Look up. Use the existing replay helpers, as DetailReal does.
- [ ] **Primary rule, with hand-made matches** (the only place they are allowed):
  - Among options with an estimate, prefer those with no leftovers and the highest profit.
  - Else take the highest profit.
  - If no option has an estimate, take `whole`.
  - A tie goes to `whole`.
- [ ] **Section of the primary:**
  - As today for `whole`.
  - A split primary with leftovers is `missing_listing`.
- [ ] **Edge cases:**
  - No stored kit page gives one option, and the Detail sentence above is available as data (`BundleRow.kitsNotRead: string[]`).
  - "None of these" gives no options.
  - Collision: a kit item equal to another part's model sums the quantities.
  - Three kits give two options.
- [ ] Implement with `evaluateBundle()` once per option. The components are the option's model items, plus one component per unnamed item that no listing covers.
- [ ] Run typecheck and `npm test`. Commit.

### Task 2b (Opus implementer, Opus review plus an independent re-check): spare parts must not match as tools
Added on Nov 11 (Ruling 65), after Task 2 found it on the recordings.
- P553 matched B08TGP8MGR, "OEM … Replacement Miter Saw Inlet Dust Chute P553", at $11.33.
- PCL430 matched B00DQD7EIE, "OEM 303590006 Sander Backing Pad … PCL430", at $7.97.

Both were graded `probable`. `AFTERMARKET` in `core/src/match.ts:20` catches "replacement for", but not these.

**Files:**
- Modify: `core/src/match.ts`
- Modify: its tests
- Modify: `core/test/report-options.test.ts`, where its assertions name these listings

- [ ] **Tests first, on every recorded Amazon response** (`fixtures/recorded/amazon-*.json`):
  - B08TGP8MGR is not `probable` for P553.
  - B00DQD7EIE is not `probable` for PCL430.
  - A before-and-after table of every row graded `probable` or better, in the report. No genuine tool, battery or kit listing may lose its grade.
  - Acceptance criterion 5 still holds: PBLRC2501SB maps to B0B3JWF5ZV and B0B6Z2ZGVK.
- [ ] **The rule rests on recorded titles only.**
  - A title that is clearly a spare part is `reject` with the reason `spare part`. For example: "Replacement" followed by a part name, or an OEM part number that is not the model.
  - A title that is only possibly one (for example "OEM" alone) is `review`, never `probable`.
  - Never guess.
- [ ] Update Task 2's assertions that named the two listings. Then run typecheck and `npm test`, and commit.

### Task 3 (Opus implementer, Opus review plus an independent re-check of Important findings): lookups for kit items
**Files:**
- Modify: `core/src/scan/runner.ts` (`bundleParts`, `wantedParts`, free listing matches)
- Modify: `core/src/scan/paid.ts`, only if quoting items needs it
- Tests: `core/test/scan-kit-items.test.ts`

**Interfaces:**
- Consumes: Task 1's `kitContents`, and Task 2's `SaleOption.parts`.
- The panel's Look up stays `{ kind: 'lookUp', parts }`. No new paid action.

- [ ] **Tests first, on the replay.** At a run cap of 1, then 3, then the default:
  - **Before the kit has been looked up:**
    - no kit-item lookup is planned
    - the kit itself is planned as today
  - **After the kit is looked up:**
    - **No active listing:** its items are planned after every other lookup and refresh.
    - **An active listing:** its items are never planned in a scan.
  - **Free matches:** kit items that match a saved Amazon listing are matched with 0 searches, whatever the kit's state. The existing recording `amazon-brand-ryobi-p1` holds PBP005.
  - **Panel quote:** `quotePaid` on the split option's parts equals the number not answered by saved listings.
- [ ] Implement in `bundleParts` and `wantedParts`. Item lookups take a new lowest rank. Nothing else in the order moves.
- [ ] Update `docs/search-budget.md` with one sentence on kit items.
- [ ] Run typecheck and `npm test`. Commit.

### Task 3b (Opus implementer, Opus review plus an independent re-check): read a kit's own page
Added on Nov 11 (Ruling 67), after Task 4 found the gap. In a real scan, a plain kit such as PCL1600K2 (item 317987591) is never stored as a bundle:
- `looksLikeBundle` takes a RYOBI model only when it has a hyphen or is a special buy.
- No default search is bundles-only.

So the kit is a catalog entry (`isKit`), its page is never read, and its bundle would say "contents not known yet" forever. The recorded page exists only because step 4 recorded it by hand.

**Files:**
- Modify: `core/src/scan/runner.ts` (applyListing, readBundlePages)
- Modify: `core/src/scan/types.ts` (`CatalogRecord.itemId`, `CatalogRecord.page`)
- Modify: `core/src/kitContents.ts` (kit records may be catalog records)
- Modify: `core/src/scan/report.ts`, only the `kitsNotRead` and `kitContents` callers
- Modify: the extension store, only if its schema needs a version bump
- Tests: a replayed scan of the default searches with the recorded pages

- [ ] **Tests first, on a replayed scan with the default searches** (not bundles-only) and the recorded pages:
  - PCL1600K2 is stored as a catalog kit, with item id 317987591.
  - The page phase reads 317987591 because PCL1600K2-P553's resolved split holds PCL1600K2. Once the owner has answered, the split holds it.
  - After that, the report gives PCL1600K2-P553 two options, and `kitsNotRead` is empty.
- [ ] **Order and cap.**
  - Bundle pages first, as today. Then kit pages, newest bundle first.
  - Kit pages share `pageReadsPerScan`.
  - A kit page is read once, like a bundle page.
  - It costs no searches.
- [ ] **Never guess.**
  - Only a catalog entry marked `isKit` that some resolved split holds is read.
  - Only through its own item id, as recorded from a Home Depot listing row.
- [ ] **Labels (Ruling 68).** Change the option labels in report.ts from "items" to "parts". Update every assertion of them: core tests, extension tests and e2e.
- [ ] Migration: catalog entries stored before this step have no item id. They stay unread until a listing row shows them again. Test that case.
- [ ] Run typecheck, `npm test`, and e2e. Commit.

### Task 4 (Sonnet implementer, Sonnet review, then `ui-reviewer`): panel and CSV
Runs in parallel with Task 3, in its own worktree, once Task 2 is merged.

**Files:**
- Modify: `extension/entrypoints/sidepanel/Detail.tsx` and `Detail.css` (new `WaysToSell` section, which may be its own file)
- Modify: `extension/entrypoints/sidepanel/DealsTab.tsx` (the tag)
- Modify: `core/src/scan/csv.ts` (columns `sold_as`, `other_options`)
- Tests: `DetailReal.test.ts`, `DealsReal.test.ts`, csv tests
- e2e: a new `e2e/panel-options.spec.ts`

- [ ] **Tests first, on replayed data:**
  - **Detail for PCL1600K2-P553 after the owner's answer:**
    - shows `Ways to sell` with both labels
    - marks the primary as the one shown above
    - shows `Leaves nothing` or the leftover line
    - shows the loose note on the split option
    - shows `Look up N items` with its exact quote while they wait
  - **A bundle with a kit in `kitsNotRead`:** Detail shows the not-known sentence from the Global Constraints.
  - **Pressing Look up** (replayed) fills the split option's estimate.
  - **Deals row:** it shows `2 ways to sell`.
  - **CSV:** `sold_as` is the primary label. `other_options` is `label: est_profit` pairs joined by ` | `, or empty while there is no estimate.
- [ ] **Layout:**
  - One block per option, in Detail's part-block style.
  - The primary option first.
  - Profit and ROI right-aligned as in the head.
  - No card-in-card.
- [ ] Screenshots at 360px and 480px. Then `ui-reviewer`.
- [ ] Run typecheck, `npm test` and `SPLIT_FINDER_E2E_PORT=<given> npm run test:e2e`. Commit.

### Task 5 (Opus QA walkthrough, high effort)
- [ ] Walk the owner's flows on the replay. Every flow from step 5, plus:
  - PCL1600K2-P553 from the question to its options
  - Look up items
  - leftovers
  - a bundle whose kit page is not stored
  - CSV
- [ ] Report findings.
- [ ] The controller fixes findings through the normal loop.

### Task 6 (controller): docs and gate
- [ ] **`docs/decisions.md`:**
  - Supersede "Boxed items decide the result" with the owner's Nov 11 choice: options, with the kit whole and split.
  - Add: everything counts as a leftover.
  - Add: contents come only from the kit's own page.
  - Add: the primary rule.
  - Add: the lookup policy.
- [ ] **`docs/v1-plan.md` order:**
  - 6 Kit options
  - 7 Chip and This page tab
  - 8 Validation and packaged build
- [ ] **The plan's "Where this stands".**
- [ ] **The controller's own run** of typecheck, `npm test` and e2e. Then stop and report.

## Not in this step
- **One Amazon listing that holds several separate parts of a bundle** (the PO's two-batteries example). In the recordings, Amazon titles that name several model numbers are almost all third-party "replaces / compatible with" listings. Reading coverage from a title would be a guess, and confirming a listing's contents takes its detail page, 1 search each. A whole kit sold as one listing is covered by this step.
- **Lowe's.** SerpApi has no Lowe's search. It needs its own page reader in the owner's browser, like Home Depot's.

## Where this stands
Not started. The plan was written on Nov 11, 2026, after step 5 merged (main at bfcf676).
