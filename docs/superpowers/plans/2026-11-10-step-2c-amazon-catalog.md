# Step 2c: Amazon Catalog Phase — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A scan first saves RYOBI and DEWALT listings from Amazon (model numbers, picture, title, price), then matches Home Depot bundle parts against the saved listings, and only pays for a single-part search when the saved listings have no answer.

**Architecture:** The owner's description, in a form the free plan can afford. Each scan reads a small number of pages of a brand's own Amazon listings and remembers where it stopped, so the crawl continues across scans until it has passed over every listing, then starts again. Every other Amazon response the tool pays for is saved the same way. Saved listings feed two things: the splitter's list of known models, and part matching.

**Tech Stack:** TypeScript 7, Vitest 5. No new dependencies.

**Spec:** `docs/v1-plan.md` ("Direction update", "Lean version 1"), `core/src/scan/types.ts` (the contract, already extended by the controller), `docs/search-budget.md`, `CLAUDE.md`.

## Global Constraints

- Only the controller runs a paid command; this plan needs none. Implementers and reviewers never run `npm run scan` without `--fixtures`, `npm run fixtures:record`, `npm run test:live` or `npm run budget`, and never read or print `SERPAPI_API_KEY` or `.env`.
- `core/src/` has no `chrome.*` and no `node:*` imports. Default tests use no network: every search goes through `replayRecorded()` or a wrapper around it.
- No retries around a search.
- Never guess. A listing is saved only when Amazon's brand field is one of the scanned brands. A part is matched from saved listings by the same `pick()` and `grade()` that judge a search result, with nothing loosened. `core/src/match.ts` gains one optional field on `Candidate` (`image`) and no rule change. `core/src/decompose.ts` is not edited.
- `core/src/scan/types.ts` is the contract; tasks implement it and do not change it.
- A change is done when `npm run typecheck` and `npm test` pass. Small commits, one concern each, staged by file name.

## Recorded facts (fixtures/recorded, 2026-11-10)

- A brand page request is `{ engine: 'amazon', k: '<BRAND>', rh: '<brand filter>', amazon_domain }`, with `page` added only from page 2 on. Page 1 is recorded as `amazon-brand-dewalt-p1` and `amazon-brand-ryobi-p1`: 60 rows each, every row with a `thumbnail`, `serpapi_pagination.next` present.
- DEWALT page: 60 rows with brand `DEWALT`, 40 of them with a model number in the title. RYOBI page: 51 rows with brand `RYOBI` (9 with no brand), 17 with a model number.
- The DEWALT page holds both parts of the recorded bundle `DCK540D1WCS334B` (Home Depot item 343992133, $499): `B0GQ6QKPWF` "...Combo Kit..." with `DCK540D1` in its title at $449, and `B07JPFHQKG` "...Jig Saw... (DCS334B)" at $123.
- The two ratchet lookups return 50 rows with brand `RYOBI` between them, 44 distinct ASINs.

## Review Focus

1. A saved title that names two models (`... for DeWalt DCF891N, DCF891B`): both are found, and the row is saved only if its brand field is a scanned brand. Task 1.
2. A title with no model number, or a European one (`R18PI-0`): saved with `models: []`, never matched to a part. Task 1.
3. A brand page that fails or is not available: the scan carries on to the Home Depot pages; the cursor does not move. Task 2.
4. A saved listing that is a kit, a multipack or renewed, with the part's model in its title: `pick()` rejects it exactly as it would from a search; the part gets a paid lookup. Task 2.
5. The same ASIN seen again with no price: the saved listing keeps its last price and `seenAt`, and `checkedAt` moves. Task 1.

---

### Task 1: Save Amazon listings

**Model:** `opus` implementer, `opus` reviewer (it sits next to the matching rules).

**Files:**
- Create: `core/src/scan/listings.ts`, `core/test/scan-listings.test.ts`
- Modify: `core/src/serpapi/parsers.ts`, `core/src/match.ts` (add `image?: string | null` to `Candidate`, nothing else), `core/src/scan/memoryStore.ts`, `core/test/scan-store.test.ts`, `core/src/scan/runner.ts`, `core/test/scan-runner.test.ts`, `core/src/scan/report.ts`, `core/test/scan-report.test.ts`, `core/src/index.ts`

**Produces:**

```ts
// parsers.ts
// parseAmazonSearch also sets `image` from the row's `thumbnail` (null when absent).
export function amazonHasNextPage(json: unknown): boolean;   // serpapi_pagination.next is a non-empty string

// listings.ts
/** Model numbers in a title, as whole tokens, upper case, in order, without repeats. */
export function modelsInTitle(brand: string, title: string): string[];
/** The record to save for a search row, or null when its brand is not one of `brands`. `old` is the stored record, if any. */
export function listingFrom(c: Candidate, brands: string[], now: number, old?: ListingRecord): ListingRecord | null;
/** Saved listings of this brand whose title carries this model as a whole token, as candidates for pick(). */
export function candidatesFor(brand: string, model: string, listings: ListingRecord[]): Candidate[];
```

Rules:
- `modelsInTitle`: RYOBI models are a `P`, up to five letters, two to four digits, then letters or digits (`PBLRC25B`, `PCL430B`, `PSK006`, `P1819`). DEWALT models are `DC`, one to three letters, three or four digits, then letters or digits, with an optional `-` and one digit (`DCK240C2`, `DCS334B`, `DCB205-2`, `DCC020IB`). A match must not touch another letter or digit on either side. Any other brand gives `[]`.
- `listingFrom`: brand compared upper-cased and trimmed; a missing brand gives null. `price`, `reviews` and `image` come from the row; when the row has no price the old `price` and `seenAt` are kept; `seenAt` is `now` only when the row has a price; `checkedAt` is always `now`; a null `image` keeps the old one.
- `candidatesFor`: uses `hasModelToken(title, model)` from `match.ts`, not the `models` array, so the test for "same model" is the matcher's own. Each candidate carries `asin`, `title`, `brand`, `price`, `reviews`, `image`.
- `MemoryScanStore` implements the five new `ScanStore` methods with the same copy and ordering rules as the others.
- The runner saves every row of every lookup and refresh response through `listingFrom` (rule 6 and 7 of the step 2 plan gain this line), and counts them in `counts.listingsSaved`. `catalogPages` and `partsFromCatalog` start at 0 and stay 0 in this task.
- The report sets `PartRow.image` from the saved listing of the part's ASIN, null when there is none.

- [ ] **Step 1: Tests.**

```ts
it.each([
  ['DEWALT', '20V MAX Cordless Drill and Impact Driver (DCK240C2)', ['DCK240C2']],
  ['DEWALT', '20V MAX 5 Ah Lithium Ion Battery 2-Pack (DCB205-2)', ['DCB205-2']],
  ['DEWALT', 'NA020584 Impact Wrench Gearcase for DeWalt DCF891N, DCF891B', ['DCF891N', 'DCF891B']],
  ['DEWALT', '20V MAX Battery XR POWERPACK 4Ah Lithium Ion', []],
  ['RYOBI', 'ONEAND HP 18V BRUSHLESS Cordless 3/8 in. Extended Reach Ratchet Tool ONLY PBLRC25B', ['PBLRC25B']],
  ['RYOBI', 'ONE+ 18V Lithium-Ion 4.0 Ah Battery (2-Pack) and Charger Kit, 1 (PSK006)', ['PSK006']],
  ['RYOBI', 'P1819 18V One+ Lithium Ion Combo Kit (6 Tools: Drill/Driver, Impact Driver)', ['P1819']],
  ['RYOBI', '18V Drill Set with Lithium-Ion Battery, Charger, Bits & Bag', []],
  ['RYOBI', 'R18PI-0 18V ONE+ Cordless High Pressure Inflator (Body Only)', []],
  ['RYOBI', 'pcl430b and PCL430B twice', ['PCL430B']],
  ['Milwaukee', 'M12 FUEL 3050-20 PBLRC25B', []],
] as const)('modelsInTitle(%s, %s)', (brand, title, models) => expect(modelsInTitle(brand, title)).toEqual(models));

it('finds a model on 40 of the 60 recorded DEWALT rows and 17 of the 51 recorded RYOBI rows', () => { /* parseAmazonSearch(recorded(...)), filter by brand, count rows with modelsInTitle(...).length > 0 */ });
it('never calls a plain word a model on the recorded pages', () => { /* every model found on both brand pages matches /\d{2,}/ and is at least 4 characters long (P505 and P590 are real RYOBI models) */ });
it('saves a row of a scanned brand, with its picture', () => { /* the row of amazon-brand-dewalt-p1 whose asin is 'B00IJ0ALYS': brand 'DEWALT', models ['DCK240C2'], price 149, reviews 61300, image a non-empty string, seenAt and checkedAt equal now */ });
it('does not save a row with no brand, another brand, or Amazon Renewed', () => { /* listingFrom returns null for each */ });
it('keeps the last price when the listing is seen again without one', () => { /* old price 149 seenAt 1; row with price null at now 5 -> price 149, seenAt 1, checkedAt 5 */ });
it('offers saved listings for a part by whole model token only', () => { /* from the DEWALT page's saved rows: candidatesFor('DEWALT', 'DCS334B', ...) has asins ['B07JPFHQKG']; candidatesFor('DEWALT', 'DCS334', ...) is [] */ });
```

  In `scan-store.test.ts`: listings and cursors round-trip, replace, return copies, and `listListings` sorts by asin. In `scan-runner.test.ts`: every pinned `counts` object gains `catalogPages: 0, listingsSaved: <n>, partsFromCatalog: 0`; in test A `listingsSaved` is 50 and `(await w.store.listListings()).length` is 44, and the saved listing `B0B3JWF5ZV` has `models: ['PBLRC25B']` and a picture. Where a pinned count is not given here, compute it the same way and state it in your report. In `scan-report.test.ts`: both parts of the founder's bundle have a non-empty `image`.

- [ ] **Step 2:** See them fail. **Step 3:** Implement. **Step 4:** `npm run typecheck`, `npm test`, `npm run scan -- --fixtures`.
- [ ] **Step 5:** Commit (including the controller's `core/src/scan/types.ts`): `feat: save Amazon listings with model numbers and pictures`.

### Task 2: The catalog phase and matching from saved listings

**Model:** `opus` implementer, `opus` reviewer (scan state, budget, matching).

**Files:** Modify `core/src/scan/runner.ts`, `core/test/scan-runner.test.ts`, `scripts/scan-cli.ts`, `core/test/scan-cli.test.ts`.

Rules, added to the runner's rules in the step 2 plan:

1. **Catalog steps come first.** A new job wants `settings.catalogPagesPerScan` brand pages, shared across `settings.brands` that have a filter in `settings.brandFilters`, one page per brand in turn, starting with the brand whose cursor was updated longest ago (a brand with no cursor first, then by brand name). Each brand's pages start at its cursor's `nextPage` (1 when there is no cursor). The catalog may take at most a fifth of the allowance: `catalogPages = min(wanted, floor(budget.spendable * 0.2))`. The rest of the allowance is planned as before. Catalog pages that do not fit are not deferred and do not make the job `stopped`.
2. **Catalog step.** `client.search({ engine: 'amazon', k: <BRAND>, rh: <filter>, amazon_domain, page: page === 1 ? undefined : page }, { label: '<prefix>:catalog:<BRAND>:p<page>', maxAgeMs: settings.freshnessMs })`. Save every row through `listingFrom`. Then save the cursor: `nextPage: page + 1` when `amazonHasNextPage`, otherwise `nextPage: 1` and `passes + 1`. Count `catalogPages` and `listingsSaved`.
3. **A catalog page that fails with `error` does not stop the scan:** the step is dropped, the cursor is unchanged, `stopMessage` records the sentence, and the scan goes on. A budget refusal or a 429 stops the scan as for any step.
4. **The splitter also knows the models in saved listings.** The catalog passed to `decompose` and `wantedFor` is the stored catalog plus, for each saved listing and each model in its `models`, an entry `{ model, brand, kinds: kindsFromTitle(title), isKit }` with `isKit` from `catalogEntry(brand, model, title)`. A stored catalog entry wins over one derived from a listing.
5. **A part is matched from saved listings before a lookup is planned.** For a part with no match record or with status `waiting` (never a user decision): `pick(wantedFor(...), candidatesFor(brand, model, listings))`. A chosen listing saves the match exactly as a lookup would (`matched`, grade, alternatives, `decidedBy: 'auto'`) and a price record copied from the saved listing (`price`, `reviews`, `seenAt`, `checkedAt`), counts `partsFromCatalog` and `partsMatched`, and no lookup is planned. Anything else leaves the part to the normal lookup. A review item is not opened from saved listings; only a paid lookup opens one.
6. The command line prints one more line after the counts: `Amazon listings saved <n> · parts matched without a search <m>`, and in fixture mode uses `catalogPagesPerScan: 2` so both recorded brand pages are replayed.

- [ ] **Step 1: Tests.**
  - **N1, a bundle resolved and matched from the catalog alone.** Settings: `brands: ['DEWALT']`, `queries: [{ q: 'dewalt 20v combo kit' }]`, `catalogPagesPerScan: 1`; policy `{ reserve: 0, maxPerRun: 10 }`. Expect `w.replay.calls` to equal `['amazon_domain=amazon.com&engine=amazon&k=DEWALT&rh=p_123:195991', 'engine=home_depot&page=1&q=dewalt 20v combo kit']`, `searchesUsed: 2`, `status: 'done'`, counts `catalogPages: 1`, `listingsSaved: 60`, `bundlesSeen: 4`, `bundlesResolved: 1`, `lookupsDone: 0`, `partsFromCatalog: 2`, `partsMatched: 2`. Bundle `homedepot:343992133` has split `{ status: 'resolved', components: ['DCK540D1', 'DCS334B'] }`. Match `DEWALT:DCK540D1` is `matched` to `B0GQ6QKPWF` and `DEWALT:DCS334B` to `B07JPFHQKG`, both `probable`. Price `B07JPFHQKG` is `{ price: 123, seenAt: T0, checkedAt: T0 }`. The cursor for DEWALT is `{ nextPage: 2, passes: 0 }`. Three split review items remain (items 337440459, 337440461, 343992132). `buildReport` gives that bundle `section: 'confirmed'` with `estimate` `{ cost: 499, netRevenue: 486.2, profit: -12.8, roi: -0.0257 }`.
  - **N2, the allowance.** The same with `maxPerRun: 4`: `floor(4 * 0.2)` is 0, so no catalog page is read, the Home Depot page is, `catalogPages: 0`, and the job is `done`.
  - **N3, the crawl continues.** Seed a cursor `{ brand: 'DEWALT', nextPage: 2, passes: 0 }` and a `fetchFn` that answers page 2 with the page 1 recording minus its `serpapi_pagination`: the request carries `page=2`, and the cursor becomes `{ nextPage: 1, passes: 1 }`.
  - **N4, a brand page that fails.** HTTP 500 for any request with `rh`: the scan still reads the Home Depot page, ends `done` with `stopMessage` matching `/HTTP 500/`, the cursor is unchanged, and exactly one brand request was sent.
  - **N5, brands in turn.** `brands: ['DEWALT', 'RYOBI']`, `catalogPagesPerScan: 2`, `maxPerRun: 10`, no cursors: the first two requests are the DEWALT page then the RYOBI page.
  - **N6, saved listings do not loosen matching.** Seed one saved listing `{ asin: 'B0KIT000000', brand: 'RYOBI', title: 'RYOBI PBLRC25B 3/8 in. Ratchet Kit with Battery and Charger', models: ['PBLRC25B'], price: 229, ... }` and run the ratchet scan with `catalogPagesPerScan: 0`: PBLRC25B is not matched from the catalog, a lookup is sent for it, and it ends matched to `B0B3JWF5ZV`.
  - **N7, a user decision is untouched** by catalog matching (as test J).
  - Existing tests: with `catalogPagesPerScan` now 1 by default, set `catalogPagesPerScan: 0` in the shared `RATCHET` settings so tests A to L keep their pinned request lists; add one sentence in the test file saying why.
  - `scan-cli.test.ts`: the fixture run logs `Searches used: 0 (replayed 7 recorded responses)` and `Amazon listings saved` with the number your run prints; the run file's first row is still the founder's bundle; state the new line counts and section counts in your report (the DEWALT bundle becomes confirmed, at a small estimated loss).

- [ ] **Step 2:** See them fail. **Step 3:** Implement. **Step 4:** `npm run typecheck`, `npm test`, `npm run scan -- --fixtures`.
- [ ] **Step 5:** Commit: `feat: Amazon catalog phase; parts matched from saved listings before any lookup`.

### Task 3: Gate (controller)

- [ ] `npm run typecheck`, `npm test`, `npm run scan -- --fixtures`, run and read by the controller. Review the diff. `npm run budget` (expected: unchanged, 13 used).
