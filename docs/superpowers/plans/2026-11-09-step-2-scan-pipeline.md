# Step 2: Scan Pipeline and Command-Line Run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A resumable scan in `core/` that turns Home Depot listing pages into split bundles, matched parts and a ranked profit estimate, plus `npm run scan` that writes the two CSV files.

**Architecture:** The pipeline depends on three injected things defined in `core/src/scan/types.ts`: a `SearchClient`, a `BudgetView` and a `ScanStore`. A scan is a `ScanJob` saved to the store after every paid step; an interrupted job continues, and a repeated step is served from the client's cache so it is never paid for twice. Tests drive the real `SerpApiClient` and `SearchBudget` over a fetch function that replays `fixtures/recorded/`.

**Tech Stack:** TypeScript 7, Vitest 5, tsx. No new dependencies.

**Spec:** `docs/v1-plan.md` ("How a scan works", "Matching policy", "Stored data", acceptance criteria 3, 5, 8, 9, 10), `docs/search-budget.md`, `docs/orchestration.md`, `CLAUDE.md`.

## Global Constraints

- Only the controller runs a paid command. Implementers and reviewers never run `npm run scan` without `--fixtures`, `npm run fixtures:record`, `npm run test:live`, `npm run budget`, or any script that calls `openDevClient()`. They never read or print `SERPAPI_API_KEY` or `.env`.
- `core/src/` has no `chrome.*` and no `node:*` imports. `core/test/` and `scripts/` may import `node:*`.
- Default tests use no network: every search in a test goes through the replay fetch or a fake.
- Nothing reaches serpapi.com except through `SerpApiClient`; in Node, only via `openDevClient()`.
- No retries around a search. A step is attempted once per run.
- Never guess: an unresolved split or an uncertain match becomes a review item, never a confident answer. No task in this plan changes a rule in `core/src/decompose.ts` or `core/src/match.ts`.
- Every profit figure is labelled an estimate (`est_` column names, and a line in the command's output).
- `core/src/scan/types.ts` is the contract. Tasks implement it; they do not change it. A task that needs a change stops and reports NEEDS_CONTEXT.
- Do not edit `core/src/serpapi/budget.ts`, `core/src/serpapi/client.ts`, `scripts/dev-budget.ts`, `scripts/dev-client.ts` or anything under `fixtures/`.
- A change is done when `npm run typecheck` and `npm test` pass. Small commits, one concern each, staged by file name.

## Review Focus

1. The same model listed under two Home Depot item ids (PCL280K1 is items 323337329 and 339375658 in the recording): two listing rows, one catalog entry, no crash. Pinned in Task 4, test A.
2. Rows of a brand outside the settings (Milwaukee and RIDGID rows on the RYOBI page): ignored. Pinned in Task 4, tests A and I.
3. A part shared by two bundles (PBLRC25B is in items 328814689 and 318045287): one lookup, not two. Pinned in Task 4, test A.
4. Third-party text in a CSV cell: commas, quotes, line breaks, and a leading `=`, `+`, `-` or `@` that a spreadsheet would run as a formula. Pinned in Task 5.
5. A matched ASIN that is missing from Amazon's results at refresh time: the old price is kept, the check is recorded, and the part is not paid for again on every scan. Pinned in Task 4, test K.

## File structure

| File | Task | Responsibility |
| --- | --- | --- |
| `core/src/scan/types.ts` | 1 (controller, done) | Ports, settings, records, the job, the store, the report |
| `core/src/scan/memoryStore.ts` | 2 | `MemoryScanStore`: `ScanStore` in memory |
| `scripts/fixture-requests.ts` | 2 | The recorded requests, shared by the recorder and the replay |
| `scripts/replay.ts` | 2 | A fetch function that answers from `fixtures/recorded/` |
| `core/src/scan/classify.ts` | 3 | Is a listing a bundle; what to ask Amazon for a part |
| `core/src/scan/runner.ts` | 4 | `runScan`: plan, steps, save, stop, resume |
| `core/src/scan/report.ts`, `core/src/scan/csv.ts` | 5 | Ranked rows from the store; CSV text |
| `scripts/scan-cli.ts`, `scripts/scan.ts` | 6 | `npm run scan` |

---

### Task 1: The contract (controller, done)

`core/src/scan/types.ts` is written and exported from `core/src/index.ts`. Read it before any other task; its comments are part of the requirements.

### Task 2: In-memory store and recorded replay

**Model:** `sonnet` implementer, `sonnet` reviewer.

**Files:**
- Create: `core/src/scan/memoryStore.ts`, `scripts/fixture-requests.ts`, `scripts/replay.ts`
- Modify: `scripts/record-fixtures.ts` (import `REQUESTS` instead of declaring it; nothing else changes), `core/src/index.ts` (add `export * from './scan/memoryStore';`)
- Test: `core/test/scan-store.test.ts`, `core/test/replay.test.ts`

**Interfaces:**
- Consumes: `ScanStore` and the record types from `core/src/scan/types.ts`; `cacheKey`, `Params` from `core/src/serpapi/client.ts`.
- Produces:

  ```ts
  // core/src/scan/memoryStore.ts
  export class MemoryScanStore implements ScanStore { /* one Map per store */ }

  // scripts/fixture-requests.ts
  export interface FixtureRequest { name: string; params: Params }
  export const REQUESTS: FixtureRequest[];   // the 9 entries, moved unchanged from record-fixtures.ts

  // scripts/replay.ts
  export interface Replay {
    fetchFn: typeof fetch;
    /** cacheKey of every /search.json request received, in order. */
    calls: string[];
  }
  export function replayRecorded(): Replay;
  ```

  `replayRecorded().fetchFn` answers `GET <base>/search.json?...`: it builds params from the query string without `api_key`, computes `cacheKey`, and returns HTTP 200 with the JSON of the `REQUESTS` entry whose `cacheKey(params)` is equal, read from `fixtures/recorded/<name>.json`. Any other request gets HTTP 404 with body `{ "error": "No recording for <cacheKey>" }`. It never opens a socket.

- [ ] **Step 1: Store tests.** In `core/test/scan-store.test.ts`, for each of bundles, catalog, matches, prices, review and scans: `put` then `get` returns an equal record; a second `put` with the same key replaces it; `get` of a missing key is `undefined`. Plus:

```ts
it('returns copies, so a caller cannot change the store by accident', async () => {
  const store = new MemoryScanStore();
  await store.putMatch(match);            // any valid MatchRecord
  const got = (await store.getMatch(match.key))!;
  got.alternatives.push('B0CHANGED00');
  got.status = 'none';
  expect(await store.getMatch(match.key)).toEqual(match);
  match.alternatives.push('B0CHANGED01');  // the object that was put is not held either
  expect((await store.getMatch(match.key))!.alternatives).toEqual([]);
});
it('lists by key ascending, and scans newest first', async () => { /* put keys b, a, c -> a, b, c; scans started at 1, 3, 2 -> 3, 2, 1 */ });
```

- [ ] **Step 2: Replay tests.** In `core/test/replay.test.ts`:

```ts
const account = () => parseAccount(fx.SERPAPI_ACCOUNT_FREE);
it('answers a recorded request through the real client and charges the budget once', async () => {
  const replay = replayRecorded();
  const budget = new SearchBudget(account(), { reserve: 0, maxPerRun: 5 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, fetchFn: replay.fetchFn });
  const first = await client.search({ engine: 'amazon', k: 'RYOBI PBLRC25B', amazon_domain: 'amazon.com' });
  expect(first.source).toBe('network');
  expect(parseAmazonSearch(first.data)).toHaveLength(10);
  const again = await client.search({ amazon_domain: 'amazon.com', k: 'RYOBI PBLRC25B', engine: 'amazon' });
  expect(again.source).toBe('cache');
  expect(budget.spentThisRun).toBe(1);
  expect(replay.calls).toEqual(['amazon_domain=amazon.com&engine=amazon&k=RYOBI PBLRC25B']);
});
it('refuses a request that was never recorded, and the budget is not charged', async () => {
  const replay = replayRecorded();
  const budget = new SearchBudget(account(), { reserve: 0, maxPerRun: 5 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, fetchFn: replay.fetchFn });
  await expect(client.search({ engine: 'amazon', k: 'RYOBI NOPE', amazon_domain: 'amazon.com' })).rejects.toThrow(/HTTP 404/);
  expect(budget.spentThisRun).toBe(0);
});
it('replays every recorded request', async () => { /* for each REQUESTS entry: client.search(params) resolves with search_metadata.status 'Success' */ });
```

- [ ] **Step 3:** Run both files, see them fail (modules missing).
- [ ] **Step 4:** Implement `MemoryScanStore` (copy on the way in and on the way out with `structuredClone`), move `REQUESTS`, implement `replayRecorded`.
- [ ] **Step 5:** `npm run typecheck`, `npm test`, and `npm run fixtures:record -- --dry-run` prints `9 of 9 fixtures already recorded. 0 to record (1 search each).` (the dry run is free and opens no client).
- [ ] **Step 6:** Commit: `feat: in-memory scan store and recorded replay`.

### Task 3: Classifying listings and parts

**Model:** `opus` implementer, `opus` reviewer (rules next to splitting and matching).

**Files:**
- Create: `core/src/scan/classify.ts`
- Modify: `core/src/decompose.ts` (add `export` to `const DEWALT_BUNDLE` only; no rule changes), `core/src/index.ts` (add `export * from './scan/classify';`)
- Test: `core/test/scan-classify.test.ts`

**Interfaces:**
- Consumes: `Catalog` and `DEWALT_BUNDLE` from `core/src/decompose.ts`; `Wanted` from `core/src/match.ts`.
- Produces:

  ```ts
  /** True when the model number has the shape of a retailer bundle. Shape only: it does not say the split will resolve. */
  export function looksLikeBundle(brand: string, model: string): boolean;
  /** What to ask of an Amazon listing for this part. */
  export function wantedFor(brand: string, model: string, catalog: Catalog): Wanted;
  /** ['A', 'B', 'A'] -> { A: 2, B: 1 } */
  export function componentCounts(components: string[]): Record<string, number>;
  ```

Rules, each from models in `fixtures/recorded/` or `core/test/fixtures.ts`:
- RYOBI is a bundle when the model contains `-`, or ends in `SB` after four or more digits.
- DEWALT is a bundle when the model, upper-cased with hyphens and spaces removed, matches `DEWALT_BUNDLE`.
- Any other brand is not a bundle.
- `wantedFor` returns `{ brand, model }` upper-cased and trimmed, with `isKit: true` when the catalog entry says so or the brand is DEWALT and the model starts with `DCK`, and `packQty: N` when the brand is DEWALT and the model matches `/^DCB\d+-(\d)$/`. It sets nothing else.

- [ ] **Step 1: Tests.**

```ts
it.each([
  ['RYOBI', 'PBLRC2501SB'], ['RYOBI', 'PCL500525SB'], ['RYOBI', 'PBLRC01B-PBLRC25B'], ['RYOBI', 'PCL1600K2-A983002'],
  ['RYOBI', 'PBLRC2501SB-A13401'], ['RYOBI', 'PCL280B-RHMTS12601'], ['ryobi', 'pcl1201k2-pcl430b'],
  ['DEWALT', 'DCK200D1P1W921B'], ['DEWALT', 'DCK540D1WCS334B'], ['DEWALT', 'DCK200D1P1WB606'], ['DEWALT', 'DCK940D2W240-2'], ['DEWALT', 'DCKTS681D1P1W34'],
])('%s %s has the shape of a bundle', (brand, model) => expect(looksLikeBundle(brand, model)).toBe(true));

it.each([
  ['RYOBI', 'PBLRC25B'], ['RYOBI', 'PCL1600K2'], ['RYOBI', 'PCL280K1'], ['RYOBI', 'PSBRC02K1'], ['RYOBI', 'PBLCK112K2'], ['RYOBI', 'PCLCK202K'],
  ['DEWALT', 'DCK240C2'], ['DEWALT', 'DCKTS681D1P1'], ['DEWALT', 'DCKO222M1'], ['DEWALT', 'DCK2101QQ2'], ['DEWALT', 'DCF891B'], ['DEWALT', 'DCB205-2'], ['DEWALT', 'DCF513EB'],
  ['Milwaukee', '3050-21-2446-20'],
])('%s %s is not a bundle', (brand, model) => expect(looksLikeBundle(brand, model)).toBe(false));

it('agrees with the splitter on every real DEWALT bundle in the fixtures', () => {
  for (const [model] of fx.HD_DEWALT_BUNDLES) expect(looksLikeBundle('DEWALT', model)).toBe(true);
  expect(looksLikeBundle('DEWALT', fx.HD_DEWALT_AMBIGUOUS[0])).toBe(true);
});

it('asks for a single tool, a kit, and a battery 2-pack', () => {
  expect(wantedFor('ryobi', ' pblrc25b ', fx.RYOBI_CATALOG)).toEqual({ brand: 'RYOBI', model: 'PBLRC25B' });
  expect(wantedFor('DEWALT', 'DCK940D2', fx.DEWALT_CATALOG)).toEqual({ brand: 'DEWALT', model: 'DCK940D2', isKit: true });
  expect(wantedFor('DEWALT', 'DCK200D1P1', new Map())).toEqual({ brand: 'DEWALT', model: 'DCK200D1P1', isKit: true });
  expect(wantedFor('DEWALT', 'DCB205-2', fx.DEWALT_CATALOG)).toEqual({ brand: 'DEWALT', model: 'DCB205-2', packQty: 2 });
  expect(wantedFor('DEWALT', 'DCB205', fx.DEWALT_CATALOG)).toEqual({ brand: 'DEWALT', model: 'DCB205' });
});

it('counts repeated components', () => {
  expect(componentCounts(['DCB205', 'DCK283D2', 'DCB205'])).toEqual({ DCB205: 2, DCK283D2: 1 });
  expect(componentCounts([])).toEqual({});
});
```

- [ ] **Step 2:** Run `npx vitest run core/test/scan-classify.test.ts`, see it fail.
- [ ] **Step 3:** Implement the three functions.
- [ ] **Step 4:** `npm run typecheck`, `npm test` (the existing splitting tests must be untouched and green).
- [ ] **Step 5:** Commit: `feat: classify listings as bundles and describe wanted parts`.

### Task 4: The scan runner

**Model:** `opus` implementer, `opus` reviewer (state, resume, budget).

**Files:**
- Create: `core/src/scan/runner.ts`
- Modify: `core/src/index.ts` (add `export * from './scan/runner';`)
- Test: `core/test/scan-runner.test.ts`

**Interfaces:**
- Consumes: everything in `core/src/scan/types.ts`; `MemoryScanStore`; `looksLikeBundle`, `wantedFor` (Task 3); `parseHomeDepotSearch`, `parseAmazonSearch`; `catalogEntry`, `decompose`; `pick`; `planScan`; `BudgetExceededError`, `RateLimitedError`, `SerpApiError`; `replayRecorded` (tests only).
- Produces:

  ```ts
  export interface ScanDeps {
    client: SearchClient;
    budget: BudgetView;
    store: ScanStore;
    settings: ScanSettings;
    /** Clock, in epoch ms. Default Date.now. */
    now?: () => number;
    /** First part of every ledger label. Default 'scan'. The command line passes 'demo'. */
    labelPrefix?: string;
  }
  /** Start a scan, or continue the newest one whose status is "running". Resolves with the finished job. */
  export function runScan(deps: ScanDeps): Promise<ScanJob>;
  ```

**Behaviour.** Numbered so tests and review can cite them.

1. **Start or continue.** If the newest job in the store has status `running`, continue it. Otherwise create one: `id = String(now)`, phase `listing`, counts zero. The pages wanted are page 1 of every query in settings order, then page 2 of every query, up to `pagesPerQuery`. Call `planScan(budget.spendable, { hdPagesWanted, pendingLookups, staleRefreshes })` with the pending and stale part keys from rule 5; the first `hdPages` wanted pages become the queue, the rest go to `deferred`. Save the job.
2. **Listing step.** `client.search({ engine: 'home_depot', q, page, hd_filter_tokens: filterTokens ?? undefined }, { label: '<prefix>:listing:<q>:p<page>', maxAgeMs: Math.max(settings.listingMaxAgeMs, now - job.startedAt) })`. For each parsed row whose brand is in `settings.brands` (compare upper-cased) and whose model is not null: it is a bundle when `step.bundlesOnly` or `looksLikeBundle(brand, model)`; save a `BundleRecord` (keep the stored `split` if the bundle is already known), otherwise save a `CatalogRecord` built from `catalogEntry(brand, model, title)`. A search row carries no barcode: a `upc` already stored for that bundle or catalog entry is kept, never replaced by `null`. When the page has no next page, remove the later queued pages of the same query; they are not deferred.
3. **After every paid step:** apply the result to the store first, then add 1 to `searchesUsed` when the result's `source` is `network`, remove the step from the queue, and save the job.
4. **Split (free), when the listing queue is empty.** Build a `Catalog` from the store. For every bundle in the store, run `decompose(brand, model, title, catalog)` and save it as `split`. `needs_review` opens a `ReviewItem` with id `split:<bundle key>` and `reason` equal to the notes joined with `'; '`, unless an item with that id already exists, which is left as it is. `resolved` closes an existing unanswered item for that bundle with `answer: 'resolved by a later scan'`.
5. **Plan the parts.** The parts are the components of every resolved bundle. A lookup is wanted for a part with no match record or with status `waiting`, never for a match the user decided. Order: `waiting` first, oldest `waitingSince` first; then by saving, largest first, where a part's saving is the largest `(regularPrice ?? price ?? 0) - (price ?? 0)` among the bundles that contain it; ties by part key ascending. One exception keeps a part that always fails from blocking the others: when the newest finished job in the store stopped with `error` or `rate_limited`, the step it failed on (the first entry of its `deferred`) is planned last among the steps of its kind in this scan. A refresh is wanted for a `matched` part whose ASIN has no price record or whose `checkedAt` is older than `settings.freshnessMs`, in the same saving order. Call `planScan(allowance, { hdPagesWanted: 0, pendingLookups, staleRefreshes })`, where `allowance` is `budget.spendable`, or 0 if the listing phase stopped (rule 8). The queue is the planned lookups then the planned refreshes; everything else goes to `deferred`. A deferred lookup's match record is saved with status `waiting` (keep an existing `waitingSince`). If anything was deferred and no stop reason is set yet, `stopReason = budget.blockReason(budget.spendable + 1)`: this names the limit that made work wait, and it does not stop the queue that was just planned. Phase becomes `parts`; save.
6. **Lookup step.** `client.search({ engine: 'amazon', k: '<BRAND> <MODEL>', amazon_domain: settings.amazonDomain }, { label: '<prefix>:lookup:<MODEL>' })` with no `maxAgeMs`: a part is paid for once. `pick(wantedFor(brand, model, catalog), parseAmazonSearch(data))`:
   - a chosen listing: match `matched` with its ASIN, grade and the alternatives' ASINs, `decidedBy: 'auto'`; save a price record for the chosen ASIN and each alternative.
   - no chosen listing but `review` is not empty: match `review`, and a `ReviewItem` with id `match:<part key>`, the review listings as candidates, and `reason` `'<n> listing(s) show the model number, but the brand is not confirmed'`.
   - otherwise: match `none`.
7. **Refresh step.** The same request with `{ label: '<prefix>:refresh:<MODEL>', maxAgeMs: settings.freshnessMs }`. If the matched ASIN is among the parsed results, save its price and reviews with `checkedAt: now`, and `seenAt: now` when it has a price. If it is not there, keep the old price and `seenAt` and set `checkedAt: now`.
8. **Stopping.** `BudgetExceededError` sets `stopReason` to its `reason`. `RateLimitedError` sets `rate_limited` and `stopMessage`. Any other `SerpApiError` sets `error` and `stopMessage`. In all three cases the failed step and the rest of the queue move to `deferred`, lookups among them are marked `waiting`, and no further search is attempted in this run. If this happens in the listing phase, rules 4 and 5 still run, with an allowance of 0. Any other error thrown by `client.search` (for example a response body that is not JSON) is handled like the `SerpApiError` case: `error`, with the error's message. SerpApi may already have counted that search, so the job must never be left `running` because of it: the next run would send the same request again. An error thrown by the store is not caught: the job stays `running` in the store and the next `runScan` continues it.
9. **Counts.** `pagesFetched`: listing steps completed, from the cache or the network. `productsSeen`: rows kept by rule 2. `bundlesSeen`: rows saved as bundles. `bundlesResolved`: bundles in the store whose split is `resolved` after rule 4. `reviewsOpened`: review items created by this scan. `lookupsDone`, `refreshesDone`: steps completed. `partsMatched`: lookups that ended `matched`.
10. **Finish.** Phase `finish`; status `stopped` when `stopReason` is set or `deferred` is not empty, otherwise `done`; `finishedAt = now`; save and return.

Test setup, shared by all tests:

```ts
const T0 = Date.UTC(2026, 10, 9, 12);                       // one fixed clock for the client and the runner
const account = (over = {}) => parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE, ...over });
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, queries: [{ q: 'ryobi extended reach ratchet' }] };
// world(): one MemoryScanStore, one MemoryCache, one replayRecorded(), a mutable clock.
// scan(world, { settings, policy, account, fetchFn? }) builds a fresh SearchBudget and SerpApiClient
// (apiKey 'TEST', the shared cache, now: () => world.clock) and calls runScan.
```

- [ ] **Step 1: Test A, the founder's bundle from recorded pages (acceptance criterion 5).**

```ts
const job = await scan(w, { settings: RATCHET, policy: { reserve: 0, maxPerRun: 10 } });
expect(job).toMatchObject({ status: 'done', stopReason: null, phase: 'finish', searchesUsed: 3, queue: [], deferred: [] });
expect(job.counts).toEqual({ pagesFetched: 1, productsSeen: 18, bundlesSeen: 8, bundlesResolved: 2, reviewsOpened: 6, lookupsDone: 2, refreshesDone: 0, partsMatched: 2 });
expect(w.replay.calls).toEqual([
  'engine=home_depot&page=1&q=ryobi extended reach ratchet',
  'amazon_domain=amazon.com&engine=amazon&k=RYOBI PBLRC01B',
  'amazon_domain=amazon.com&engine=amazon&k=RYOBI PBLRC25B',
]);
expect((await w.store.getBundle('homedepot:328814689'))!.split).toMatchObject({ status: 'resolved', components: ['PBLRC25B', 'PBLRC01B'] });
expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'matched', asin: 'B0B3JWF5ZV', grade: 'probable', decidedBy: 'auto' });
expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'matched', asin: 'B0B6Z2ZGVK', grade: 'probable' });
expect(await w.store.getPrice('B0B3JWF5ZV')).toEqual({ asin: 'B0B3JWF5ZV', price: 169, reviews: 221, seenAt: T0, checkedAt: T0 });
expect(await w.store.getPrice('B0B6Z2ZGVK')).toMatchObject({ price: 146.94, reviews: 212 });
expect((await w.store.listCatalog()).map((c) => c.key)).toEqual([
  'DEWALT:DCF512EB', 'DEWALT:DCF513EB', 'RYOBI:PBLRC01B', 'RYOBI:PBLRC01K1', 'RYOBI:PBLRC25B', 'RYOBI:PBLRC25K1', 'RYOBI:PCL280B', 'RYOBI:PCL280K1', 'RYOBI:PSBRC02K1',
]);
expect((await w.store.listReview()).map((r) => r.id)).toEqual([
  'split:homedepot:320683876', 'split:homedepot:320684261', 'split:homedepot:327939252', 'split:homedepot:327939313', 'split:homedepot:335849279', 'split:homedepot:345174262',
]);
```

- [ ] **Step 2: Test B, a page of kits and unresolved bundles.** Query `dewalt 20v combo kit`: `status: 'done'`, `searchesUsed: 1`, counts `{ pagesFetched: 1, productsSeen: 24, bundlesSeen: 4, bundlesResolved: 0, reviewsOpened: 4, lookupsDone: 0, refreshesDone: 0, partsMatched: 0 }`, 20 catalog entries, review ids `split:homedepot:337440459`, `…337440461`, `…343992132`, `…343992133`, and no match records.

- [ ] **Step 3: Tests C and D, the three limits (acceptance criterion 3).**
  - C, run cap: `RATCHET` with `maxPerRun: 2` gives `status: 'stopped'`, `stopReason: 'run_cap'`, `searchesUsed: 2`, `deferred` equal to `[{ kind: 'lookup', brand: 'RYOBI', model: 'PBLRC25B' }]`, and match `RYOBI:PBLRC25B` with `status: 'waiting'`, `waitingSince: T0`. A second `scan` on the same world with `maxPerRun: 10`, clock moved 10 minutes: `status: 'done'`, `searchesUsed: 1`, `w.replay.calls` has length 3 in total (the listing page came from the cache), both parts `matched`.
  - D, reserve: account `{ total_searches_left: 101 }`, policy `{ reserve: 100, maxPerRun: 10 }` gives `stopReason: 'reserve'`, `searchesUsed: 1`, two deferred lookups. Hourly: account `{ this_hour_searches: 49 }`, policy `{ reserve: 0, maxPerRun: 10 }` gives `stopReason: 'hourly_limit'`, `searchesUsed: 1`.

- [ ] **Step 4: Test E, an interruption is continued without paying twice (acceptance criterion 8).** Wrap the store so that `putScan` throws `new Error('interrupted')` the first time it is called with a job whose `counts.lookupsDone` is 1: the first lookup's response is cached and applied, and the save that would record the step never happens, as when the service worker dies. `runScan` rejects with `interrupted`; the newest job in the store has status `running` and both lookups still in its queue. Run again with the unwrapped store and a fresh budget: the returned job has the same `id`, `status: 'done'`, `counts.lookupsDone: 2`, and `w.replay.calls` has length 3 with no key repeated. `searchesUsed` is 2: the search in flight at the interruption was paid (the ledger has it) but its step was never saved; say so in a comment on `searchesUsed` handling in the runner.
  - E2, a search that fails in an unexpected way: a `fetchFn` that answers HTTP 200 with the body `not json` to any request whose URL contains `engine=amazon` and passes everything else to the replay. `status: 'stopped'`, `stopReason: 'error'`, `stopMessage` is not empty, the newest job in the store is not `running`, both parts are `waiting`, and exactly one Amazon request was made. A second `runScan` on the same world with the plain replay starts a new job (a different `id`).

- [ ] **Step 5: Tests F and G, time.**
  - F: after test A's scan, move the clock 1 day and scan again: `searchesUsed: 1` (the listing page is older than `listingMaxAgeMs`), `refreshesDone: 0`.
  - G: move the clock 4 days from T0 instead: `searchesUsed: 3`, `refreshesDone: 2`, `lookupsDone: 0`, and price `B0B3JWF5ZV` has `checkedAt` and `seenAt` equal to the new time.

- [ ] **Step 6: Tests H, I, J, K.**
  - H, errors: a `fetchFn` that answers HTTP 500 to any request whose URL contains `engine=amazon` and passes everything else to the replay. `status: 'stopped'`, `stopReason: 'error'`, `stopMessage` matches `/HTTP 500/`, both parts `waiting`, and exactly one Amazon request was made. The same with HTTP 429 gives `stopReason: 'rate_limited'`.
  - I, brands: `RATCHET` with `brands: ['RYOBI']` gives 7 catalog entries, none with brand `DEWALT`.
  - J, the user's decision: put a match for `RYOBI:PBLRC25B` with `decidedBy: 'user'`, `status: 'matched'`, `asin: 'B0USERPICK0'` before scanning. After the scan it is unchanged and no lookup was sent for PBLRC25B. Its ASIN has no price yet, so rule 5 sends one refresh for it.
  - M, a part that always fails does not block the others: a `fetchFn` that answers HTTP 500 when the request's `k` parameter is `RYOBI PBLRC01B` and passes everything else to the replay. First scan: `stopReason: 'error'`, `deferred` starts with the PBLRC01B lookup, both parts `waiting`. Second scan on the same world, clock moved 10 minutes, same `fetchFn`: PBLRC25B is looked up first and ends `matched` with `asin: 'B0B3JWF5ZV'`; PBLRC01B is tried after it, fails again, and the job is `stopped` with `error`; `searchesUsed` is 1; across both scans exactly two requests were sent for PBLRC01B and one for PBLRC25B.
  - N, a user's decision that is waiting: put a match for `RYOBI:PBLRC25B` with `decidedBy: 'user'`, `status: 'waiting'`, `asin: null`, `waitingSince: T0 - 1000` before scanning. No lookup and no refresh is sent for PBLRC25B (no ledger label `scan:lookup:PBLRC25B`), and the record is unchanged after the scan.
  - L, barcodes survive: put a bundle record for item 328814689 with `upc: '033287232581'` and a catalog entry `RYOBI:PBLRC25B` with `upc: '033287193721'` before scanning. After the scan both barcodes are still there, and the bundle's price is the page's 189.
  - K, a listing that disappeared: before scanning at T0 + 4 days, seed match `RYOBI:PBLRC25B` as `matched` to `asin: 'B0GONE00000'` with price record `{ price: 150, reviews: 5, seenAt: T0, checkedAt: T0 }`, and match `RYOBI:PBLRC01B` as `none`. The scan sends one refresh; afterwards the price record is `{ asin: 'B0GONE00000', price: 150, reviews: 5, seenAt: T0, checkedAt: T0 + 4 days }`.

- [ ] **Step 7:** Run the file after each group; see each test fail before the code that makes it pass exists.
- [ ] **Step 8:** Implement `runScan`. Keep each phase a named function in `runner.ts`; if the file passes about 350 lines, stop and report it as a concern rather than splitting it yourself.
- [ ] **Step 9:** `npm run typecheck`, `npm test`.
- [ ] **Step 10:** Commit: `feat: resumable scan runner over injected client, budget and store`.

### Task 5: Report and CSV

**Model:** `sonnet` implementer, `sonnet` reviewer.

**Files:**
- Create: `core/src/scan/report.ts`, `core/src/scan/csv.ts`
- Modify: `core/src/index.ts` (add the two exports)
- Test: `core/test/scan-report.test.ts`

**Interfaces:**
- Consumes: `ScanStore`, `ScanSettings`, `ScanReport`, `BundleRow`, `PartRow` from types; `evaluateBundle`, `PricedListing` from `core/src/scanPlan.ts`; `componentCounts`; `runScan`, `MemoryScanStore`, `replayRecorded` (tests).
- Produces:

  ```ts
  // report.ts
  export function buildReport(store: ScanStore, settings: ScanSettings): Promise<ScanReport>;
  // csv.ts
  export function csvLine(cells: (string | number | null)[]): string;
  export const RUN_COLUMNS: readonly string[];
  export const REVIEW_COLUMNS: readonly string[];
  export function runCsv(report: ScanReport): string;
  export function reviewCsv(report: ScanReport): string;
  ```

Rules:
- A bundle with a resolved split and a price gets an estimate from `evaluateBundle(price, componentCounts(split.components), priced, settings.fees, settings.liquidationRate)`, where `priced` has one `{ asin, covers: { [model]: 1 }, price }` for every part whose match is `matched` and whose price record has a price. Status is `complete` when `uncovered` is empty, else `partial`. Any other bundle is `needs_review` with `estimate: null` and no parts.
- Order: as the `ScanReport` comment says; bundle ties by bundle key ascending, review ties by id ascending.
- `RUN_COLUMNS`: `status, brand, bundle_model, bundle_title, hd_item_id, hd_price, hd_was_price, hd_percent_off, parts, asins, match_grades, amazon_prices, est_net_revenue, est_cost, est_profit, est_roi, uncovered_parts, hd_link`. Cells with several values join them with `' | '` in part order; a part with quantity 2 is written `MODEL x2`; a missing ASIN, grade or price is written `?`.
- `REVIEW_COLUMNS`: `kind, brand, model, title, reason, candidates, opened_at`. A candidate is `ASIN $price title` (`$?` without a price); `opened_at` is ISO 8601.
- `csvLine`: `null` is an empty cell; a number is written as is; a string that starts with `=`, `+`, `-` or `@` gets a leading `'`; a cell containing a comma, a double quote, CR or LF is wrapped in double quotes with quotes doubled. Files end each line with `\n`, header first.

- [ ] **Step 1: Tests.**

```ts
it('ranks the founder\'s bundle first with an estimate', async () => {
  // run test A's scan (RATCHET settings), then:
  const report = await buildReport(w.store, RATCHET);
  expect(report.bundles.map((b) => [b.model, b.status])).toEqual([
    ['PBLRC2501SB', 'complete'], ['PBLRC01B-PBLRC25B', 'complete'],
    ['PBLRC25B-PBP004', 'needs_review'], ['PBLRC01B-PBP004', 'needs_review'], ['PCL280B-PSK005', 'needs_review'],
    ['PCL280B-PSK014', 'needs_review'], ['PBLRC2501SB-A13401', 'needs_review'], ['PCL280B-RHMTS12601', 'needs_review'],
  ]);
  expect(report.bundles[0]).toMatchObject({
    itemId: '328814689', price: 189, regularPrice: 338, uncovered: [],
    estimate: { cost: 189, netRevenue: 268.55, profit: 79.55, roi: 0.4209 },
    parts: [
      { model: 'PBLRC25B', qty: 1, status: 'matched', asin: 'B0B3JWF5ZV', grade: 'probable', price: 169 },
      { model: 'PBLRC01B', qty: 1, status: 'matched', asin: 'B0B6Z2ZGVK', grade: 'probable', price: 146.94 },
    ],
  });
  expect(report.bundles[1]!.estimate).toMatchObject({ cost: 348, profit: -79.45 });
  expect(report.review).toHaveLength(6);
});
it('calls a bundle partial when a part has no priced listing', async () => { /* same scan with maxPerRun 2: PBLRC2501SB is 'partial', uncovered ['PBLRC25B'], estimate.netRevenue 124.9, part PBLRC25B status 'waiting' with asin null */ });
it('writes the run file', async () => {
  const lines = runCsv(report).split('\n');
  expect(lines[0]).toBe(RUN_COLUMNS.join(','));
  expect(lines[1]).toBe('complete,RYOBI,PBLRC2501SB,ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only),328814689,189,338,44,PBLRC25B | PBLRC01B,B0B3JWF5ZV | B0B6Z2ZGVK,probable | probable,169 | 146.94,268.55,189,79.55,0.4209,,https://www.homedepot.com/p/RYOBI-ONE-HP-18V-Brushless-Cordless-1-4-in-and-3-8-in-Extended-Reach-Ratchets-Tools-Only-PBLRC2501SB/328814689');
  expect(lines).toHaveLength(10);          // header, 8 bundles, and the empty string after the last \n
});
it('escapes third-party text', () => {
  expect(csvLine(['a,b', 'say "hi"', 'two\nlines', null, -79.45, '=SUM(A1)', '+1', '-x', '@y'])).toBe('"a,b","say ""hi""","two\nlines",,-79.45,\'=SUM(A1),\'+1,\'-x,\'@y');
});
it('writes the review file', async () => { /* header equals REVIEW_COLUMNS.join(','); 6 rows; first row starts with 'split,RYOBI,PBLRC25B-PBP004,' and its reason cell is 'hyphen split, but a part is not in the catalog' wrapped in quotes */ });
```

- [ ] **Step 2:** See them fail. **Step 3:** Implement. **Step 4:** `npm run typecheck`, `npm test`.
- [ ] **Step 5:** Commit: `feat: ranked scan report and CSV output`.

### Task 6: `npm run scan`

**Model:** `sonnet` implementer, `sonnet` reviewer.

**Files:**
- Create: `scripts/scan-cli.ts`, `scripts/scan.ts`
- Modify: `package.json` (add `"scan": "tsx scripts/scan.ts"`), `.gitignore` (add `output/`), `CLAUDE.md` and `README.md` (one line each under the commands: `npm run scan -- --fixtures` free, `npm run scan -- --limit N` spends up to N)
- Test: `core/test/scan-cli.test.ts`

**Interfaces:**
- Consumes: `runScan`, `buildReport`, `runCsv`, `reviewCsv`, `MemoryScanStore`, `DEFAULT_SCAN_SETTINGS`, `replayRecorded`, `REQUESTS`, `openDevClient`, `NoKeyError`, `SpendLockError`, `DEV_ALLOCATION`.
- Produces:

  ```ts
  // scripts/scan-cli.ts
  export interface CliDeps {
    log: (line: string) => void;
    outDir: string;                       // the real entry point passes <repo>/output
    now: () => number;
    openClient: typeof openDevClient;     // injected so tests never open the paid client
  }
  /** Returns the process exit code. */
  export function runScanCli(args: string[], deps: CliDeps): Promise<number>;
  ```

Behaviour:
- `--fixtures`: no key, no lock, no network. Client is a `SerpApiClient` over `replayRecorded().fetchFn` with a budget of 250; queries are the three recorded Home Depot searches in `REQUESTS` order. Never calls `deps.openClient`.
- `--limit N` (required without `--fixtures`): an integer from 1 to `DEV_ALLOCATION.demo`. Anything else prints the usage and returns 1 without opening a client. Calls `deps.openClient('demo', N)`, runs with `labelPrefix: 'demo'`, and always calls `release()`.
- `--dry-run` with `--limit N`: prints `Would spend up to N searches from the demo bucket.` and the queries, returns 0, opens nothing.
- `--query "<text>"` (repeatable) replaces the default queries; `--pages N` sets `pagesPerQuery`.
- Writes `run_<stamp>.csv` and `review_<stamp>.csv` into `outDir` (created if missing), stamp `YYYYMMDD-HHMMSS` in UTC from `deps.now()`.
- Prints, in this order: `Searches used: <n>` (in fixture mode `Searches used: 0 (replayed <n> recorded responses)`), `Scan <status>` with the stop reason in words when there is one, the counts, the two file paths, and `Profit figures are estimates from fee settings, not real Amazon fees.`
- `NoKeyError`, `SpendLockError` and `BudgetExceededError` print their message and return 1.

- [ ] **Step 1: Tests** in a temp directory, with `openClient` a function that throws if called:

```ts
it('runs the whole pipeline on recordings and writes both files', async () => {
  const code = await runScanCli(['--fixtures'], deps);
  expect(code).toBe(0);
  const run = readFileSync(join(dir, 'run_20261109-120000.csv'), 'utf8');
  expect(run.split('\n')[1]).toMatch(/^complete,RYOBI,PBLRC2501SB,.*,268\.55,189,79\.55,0\.4209,,https:/);
  expect(run.split('\n')).toHaveLength(25);        // header, 23 bundles, trailing empty string
  expect(readFileSync(join(dir, 'review_20261109-120000.csv'), 'utf8').split('\n')).toHaveLength(23);   // header, 21 items, trailing
  expect(logs).toContain('Searches used: 0 (replayed 5 recorded responses)');
  expect(logs).toContain('Profit figures are estimates from fee settings, not real Amazon fees.');
});
it.each([[[]], [['--limit', '0']], [['--limit', '51']], [['--limit', 'ten']]])('refuses %j without opening a client', async (args) => {
  expect(await runScanCli(args, deps)).toBe(1);
});
it('a dry run opens nothing', async () => {
  expect(await runScanCli(['--limit', '40', '--dry-run'], deps)).toBe(0);
  expect(logs).toContain('Would spend up to 40 searches from the demo bucket.');
});
it('a paid run goes through the injected client with the demo label and releases the lock', async () => {
  /* openClient returns { client: a SerpApiClient over the replay, budget, account, allowance: 5, release: spy };
     args ['--limit', '5', '--query', 'ryobi extended reach ratchet']; expect code 0, release called once,
     and every ledger label passed to onSpend to start with 'demo:' */
});
```

- [ ] **Step 2:** See them fail. **Step 3:** Implement. **Step 4:** `npm run typecheck`, `npm test`, then `npm run scan -- --fixtures` and confirm two files appear under `output/` and `git status` does not list them.
- [ ] **Step 5:** Commit: `feat: npm run scan, with a free fixture mode`.

### Task 7: Step gate and the real run (controller)

- [ ] `npm run typecheck`, `npm test`, `npm run scan -- --fixtures`, run and read by the controller.
- [ ] Review the whole step's diff on `fable`.
- [ ] `npm run budget`. Tell the user what the real run would spend (`demo` bucket, cap 50) and what the recordings say it will find. Wait for the yes.
- [ ] After the yes: `npm run scan -- --limit N`, once. `npm run budget`. Report both numbers and the two files.
