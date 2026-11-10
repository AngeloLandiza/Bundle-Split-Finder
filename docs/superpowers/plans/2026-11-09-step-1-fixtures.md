# Step 1: Recorded Fixtures and Confirmed Parsers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the 9 SerpApi responses once, then make `core/src/serpapi/parsers.ts` provably correct against them and remove every doc-shaped SerpApi search sample from the tests.

**Architecture:** The controller records raw responses into `fixtures/recorded/` through the guarded dev client (the only paid action in this step). Tests read those files through one small loader in `core/test/` and assert real values. Parsers stay tolerant: a missing field is `null`, never a crash and never a guess.

**Tech Stack:** TypeScript 7, Vitest 5, tsx. No new dependencies.

**Spec:** `docs/v1-plan.md` (build order, step 1), `docs/search-budget.md` (workflow, steps 1 to 4), `docs/orchestration.md` (routing), `CLAUDE.md` (rules).

## Global Constraints

- Only the controller runs a paid command. Implementers and reviewers never run `npm run fixtures:record` (without `--dry-run`), `npm run test:live`, or any script that calls `openDevClient()`. The key is present in the shell environment of every subagent, so this is a rule of the brief, not something the sandbox prevents.
- This step spends at most 9 searches, all from the `fixtures` bucket (cap 15). No retries around paid calls. A failed request is read, not re-run.
- `core/src/` has no `chrome.*` and no `node:*` imports. Test files in `core/test/` may import `node:*`.
- Default tests use no network. `npm test` must pass with the network off.
- The key is never printed, logged, committed or written to a fixture.
- Never guess: a parser returns `null` for a field the response does not carry. It does not derive a part number, brand or barcode from a title.
- Implementers in this step do not edit `core/src/match.ts`, `core/src/decompose.ts`, `core/src/serpapi/budget.ts`, `core/src/serpapi/client.ts`, `scripts/dev-budget.ts` or `scripts/dev-client.ts`. If a recording contradicts one of them, the task comes back BLOCKED with the real example and goes to `opus`.
- A change is done when `npm run typecheck` and `npm test` pass.
- Small commits, one concern each.

## Review Focus

Inputs the spec implies and a real page of results will contain, most likely first. Each is pinned by a test in Task 2.

1. A Home Depot row with no was-price, or no price at all: the row is kept, `regularPrice` (or `price`) is `null`.
2. An Amazon result with no price (unavailable) or a price range such as `"$10.00 - $20.00"`: `price` is `null`, the row is kept.
3. A sponsored Amazon result, marked the way the recording really marks it: `sponsored` is `true`, so `pick()` ranks it after organic results.
4. An Amazon detail page with no UPC, or with several: `upcs` is `[]` or every code, and `partNumber` is `null` when no part-number field exists.
5. A response whose `search_metadata.status` is `Success` but which carries an `error` string and no result list (SerpApi's "no results" shape): every parser returns its empty value and does not throw.

## File structure

| File | Change | Responsibility |
| --- | --- | --- |
| `fixtures/recorded/*.json` (9 files) | Created by the recorder | Raw SerpApi responses, key redacted |
| `core/test/recorded.ts` | Create | The one place tests load a recording: `recorded(name): unknown` |
| `core/test/parsers.recorded.test.ts` | Create | Every parser against the recordings, plus the tolerance cases |
| `core/src/serpapi/parsers.ts` | Modify | Field names corrected to the recordings; `parseHomeDepotProduct` added |
| `core/test/fixtures.ts` | Modify | Remove the three doc-shaped search samples |
| `core/test/budget.test.ts` | Modify | Remove the `parsers (doc-shaped samples)` block |
| `README.md` | Modify | The "what is verified" paragraph and the test count |

---

### Task 0: Preconditions (controller and user, no subagent)

- [ ] **Step 1: Restore the three missing paths.** `.gitignore`, `.env.example` and `.claude/agents/` (`ui-reviewer`, `docs-checker`) were present when the session started and are not on disk now. The user restores them, or approves this `.gitignore`:

```
node_modules/
.env
cache/
.serpapi-ledger.jsonl
.serpapi.lock
output/
```

- [ ] **Step 2: Baseline commit.** Run `git status --short` and confirm `node_modules/` is not listed. Commit the starting point as `chore: starting point (core, scripts, docs)` so every later task has a diff to review.
- [x] **Step 3: Request check (done 2026-11-09, read-only `sonnet` agent, SerpApi's documentation pages).** Every parameter name in the 9 requests is documented and no required parameter is missing: `q` and `page` for `home_depot`, `product_id` for `home_depot_product`, `k` and `amazon_domain` for `amazon`, `asin` for `amazon_product`. `scripts/record-fixtures.ts` is recorded as it stands. Not confirmed by the documentation, so read from the recordings in Task 1 Step 9: where `amazon_product` puts the part number, whether `home_depot_product` carries a was-price, and whether a response echoes the key (Task 1 Step 6 checks this before anything is committed).

### Task 1: Record the fixtures (controller, paid, at most 9 searches)

**Files:** Create `fixtures/recorded/<name>.json` for each of the 9 names in `scripts/record-fixtures.ts`.

- [x] **Step 1:** `npm run budget`. Expected: `fixtures 0 of 15`, `May be spent now` at least 9.
- [ ] **Step 2:** `npm run fixtures:record -- --dry-run`. Expected: `0 of 9 fixtures already recorded. 9 to record (1 search each).`
- [ ] **Step 3:** Tell the user: 9 searches, `fixtures` bucket. Wait for the yes.
- [ ] **Step 4:** `npm run fixtures:record`, once. Expected: `Allowed to spend 9 now.` then nine `recorded <name> (network)` lines. If it stops early, do not run it again until the error has been read and understood: an errored search is free, and a re-run only requests the files that are still missing.
- [ ] **Step 5:** `npm run budget`. Expected: `fixtures 9 of 15`, `Used this month 9`. Report both numbers.
- [ ] **Step 6:** Leak check. `grep -rlF -- "$SERPAPI_API_KEY" fixtures/` prints nothing, and `grep -rl "api_key" fixtures/recorded/` is reviewed by hand (file names only; the key itself is never echoed).
- [ ] **Step 7:** `npm run fixtures:record -- --dry-run`. Expected: `9 of 9 fixtures already recorded. 0 to record`.
- [ ] **Step 8:** Commit: `test: record 9 SerpApi responses (fixtures bucket)`.
- [x] **Step 9: Pin the recorded facts (done 2026-11-09).** Read each file's structure with `jq` (key paths and the handful of values below, never whole files) and replace every placeholder in Task 2 with the value from the file. Done: see the Recorded facts table in Task 2.

### Task 2: Parsers confirmed against the recordings

**Model:** `sonnet` implementer, `sonnet` reviewer (`opus` reviewer if the diff touches anything outside the files below).

**Files:**
- Create: `core/test/recorded.ts`
- Create: `core/test/parsers.recorded.test.ts`
- Modify: `core/src/serpapi/parsers.ts`

**Recorded facts (read from `fixtures/recorded/` on 2026-11-09 by the controller).** Every value in the tests below comes from these files.

| Engine | Confirmed as documented | Differs from what the parser assumes |
| --- | --- | --- |
| `home_depot` | `products[]` with `product_id` (string), `title`, `brand` (string), `model_number`, `price` (number), `price_was`, `percentage_off`, `price_badge`, `link`; `serpapi_pagination.next` and `pagination.next` | Nothing. `price_was`, `percentage_off` and `price_badge` are simply absent on rows that are not on sale |
| `amazon` | `organic_results[]` with `asin`, `title`, `price` (string), `extracted_price` (number), `reviews` (number); `sponsored: true` only on sponsored rows, absent otherwise | **Rows carry a `brand` field** (`"RYOBI"`, `"DEWALT"`, `"Amazon Renewed"`, or absent), and **the title does not start with the brand** (`"ONEAND HP 18V BRUSHLESS Cordless 3/8 in. ... PBLRC25B"`). The parser drops `brand` today, so `pick()` grades the founder's own listings `review` and chooses nothing |
| `amazon_product` | `product_results.asin/title/extracted_price/reviews`; `product_results.brand` is `"Brand: RYOBI"`; `product_details.manufacturer_part_number`, `product_details.upc` | Nothing. `product_details.model_number` also exists (`"#PBLRC25B"`); `item_model_number` does not appear |
| `home_depot_product` | `product_results.product_id/title/model_number/upc/price` | No parser exists. `brand` is an object `{ name, link }`. The was-price is `promotion.original`. Nothing in the response lists the bundle's parts |

**Interfaces:**
- Consumes: `grade(want: Wanted, cand: Candidate): Graded` and `pick(want: Wanted, candidates: Candidate[]): Picked` from `core/src/match.ts`, unchanged. `Candidate.brand` is already an optional field, and `grade()` already treats a candidate brand equal to the wanted brand as brand confirmation.
- Produces:
  - `core/test/recorded.ts`: `export const RECORDED_NAMES = [...] as const` (the 9 names), `export type RecordedName = (typeof RECORDED_NAMES)[number]`, `export function recorded(name: RecordedName): unknown` which reads `fixtures/recorded/<name>.json` with `node:fs` relative to the file's own URL and returns `JSON.parse` of it.
  - `core/src/serpapi/parsers.ts`: existing signatures unchanged; `parseAmazonSearch` now sets `brand` on each candidate (through `cleanBrand`, `null` when the row has none); plus

    ```ts
    import type { HdProduct } from '../hdPage';
    export function parseHomeDepotProduct(json: unknown): HdProduct | null;
    ```

    `HdProduct` is the existing type in `core/src/hdPage.ts` (the product read from an open page). The paid lookup returns the same type so both sources feed one pipeline. Do not declare a second product interface: `core/src/index.ts` re-exports both modules with `export *`, and a second `HdProduct` breaks the typecheck.

A test that passes on its first run is a confirmed field name; list those in the report. A test that fails is a difference between the documentation and the real response; fix the parser, not the test.

- [ ] **Step 1: Write `core/test/recorded.ts` and a first test that every recording loads.**

```ts
it.each(RECORDED_NAMES)('%s is a successful recorded response', (name) => {
  const j = recorded(name) as { search_metadata?: { status?: string } };
  expect(j.search_metadata?.status).toBe('Success');
});
```

Run `npx vitest run core/test/parsers.recorded.test.ts`. Expected: 9 pass.

- [ ] **Step 2: Write the Home Depot search tests.**

```ts
describe.each([
  // name, rows, rows with a model number, rows with a was-price
  ['hd-search-ryobi-combo-p1', 24, 24, 12],
  ['hd-search-dewalt-combo-p1', 24, 24, 11],
  ['hd-search-ryobi-ratchet', 24, 24, 6],
] as const)('parseHomeDepotSearch(%s)', (name, count, withModel, withWas) => {
  const { listings, hasNextPage } = parseHomeDepotSearch(recorded(name));
  it('keeps every product row', () => expect(listings).toHaveLength(count));
  it('reads an all-digit item id, a title, a brand and a numeric price on every row', () => {
    for (const l of listings) {
      expect(l.itemId).toMatch(/^\d+$/);
      expect(l.title.length).toBeGreaterThan(0);
      expect(l.brand).toEqual(expect.any(String));
      expect(l.price).toEqual(expect.any(Number));
    }
  });
  it('reads model numbers', () => expect(listings.filter((l) => l.model).length).toBe(withModel));
  it('reads was-prices as numbers above the price, with a percentage', () => {
    const marked = listings.filter((l) => l.regularPrice !== null);
    expect(marked).toHaveLength(withWas);
    for (const l of marked) {
      expect(l.regularPrice!).toBeGreaterThan(l.price!);
      expect(l.percentOff).toEqual(expect.any(Number));
    }
  });
  it('sees a next page', () => expect(hasNextPage).toBe(true));
});

it('reads the founder\'s bundle exactly as Home Depot lists it', () => {
  const { listings } = parseHomeDepotSearch(recorded('hd-search-ryobi-ratchet'));
  expect(listings.find((l) => l.itemId === '328814689')).toEqual({
    itemId: '328814689',
    title: 'ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only)',
    brand: 'RYOBI',
    model: 'PBLRC2501SB',
    price: 189,
    regularPrice: 338,
    percentOff: 44,
    badge: 'Special-Buy',
    link: 'https://www.homedepot.com/p/RYOBI-ONE-HP-18V-Brushless-Cordless-1-4-in-and-3-8-in-Extended-Reach-Ratchets-Tools-Only-PBLRC2501SB/328814689',
  });
});

it('reads a row that is not on sale', () => {
  const { listings } = parseHomeDepotSearch(recorded('hd-search-dewalt-combo-p1'));
  expect(listings.find((l) => l.itemId === '206510146')).toMatchObject({ model: 'DCK940D2', price: 799, regularPrice: null, percentOff: null, badge: null });
});
```

- [ ] **Step 3: Write the Amazon search tests.**

```ts
it.each([
  // name, rows, rows with no price
  ['amazon-search-PBLRC25B', 10, 0],
  ['amazon-search-PBLRC01B', 48, 3],
  ['amazon-search-DCF891B', 60, 6],
] as const)('%s: every row is kept, priced or not', (name, rows, unpriced) => {
  const results = parseAmazonSearch(recorded(name));
  expect(results).toHaveLength(rows);
  expect(results.filter((r) => r.price === null)).toHaveLength(unpriced);
});

it.each([
  ['amazon-search-PBLRC25B', 'RYOBI', 'PBLRC25B', 'B0B3JWF5ZV', 169, 221],
  ['amazon-search-PBLRC01B', 'RYOBI', 'PBLRC01B', 'B0B6Z2ZGVK', 146.94, 212],
] as const)('%s: pick() chooses the founder\'s listing', (name, brand, model, asin, price, reviews) => {
  const results = parseAmazonSearch(recorded(name));
  expect(results.find((r) => r.asin === asin)).toMatchObject({ brand: 'RYOBI', price, reviews, sponsored: false });
  expect(pick({ brand, model }, results).chosen).toMatchObject({ asin, grade: 'probable' });
});

it('reads the brand Amazon shows on a search row', () => {
  const brands = new Set(parseAmazonSearch(recorded('amazon-search-PBLRC25B')).map((r) => r.brand));
  expect(brands).toEqual(new Set(['RYOBI', 'Amazon Renewed']));
});

it('amazon-search-DCF891B: one DEWALT listing is chosen as a title match, with no alternatives', () => {
  const picked = pick({ brand: 'DEWALT', model: 'DCF891B' }, parseAmazonSearch(recorded('amazon-search-DCF891B')));
  expect(picked.chosen?.grade).toBe('probable');
  expect(picked.alternatives).toEqual([]);
});

it('marks sponsored results', () => {
  const results = parseAmazonSearch(recorded('amazon-search-DCF891B'));
  expect(results.filter((r) => r.sponsored).map((r) => r.asin)).toEqual([
    'B0FP14XK2J', 'B0H4VCY8M1', 'B0FXM7V5ND', 'B0FJRQ1CG6', 'B0FTTW9HT1', 'B0HCTK4BLL',
    'B0HQGDLWH9', 'B0HQG2WS5V', 'B0H93QPDC2', 'B0FDVXVJCN', 'B0HQNL1PKM', 'B0HN1TBD9C',
  ]);
});
```

The DEWALT test does not pin the chosen ASIN: which listing is correct for DCF891B is confirmed with the user in step 6, not assumed here. Do not assert anything about `picked.review` for that file: it holds aftermarket parts with no brand, and whether they belong there is a matching-rule question for a later `opus` task.

- [ ] **Step 4: Write the Amazon product tests.**

```ts
it('amazon-product-B0B6Z2ZGVK carries brand, part number and barcode', () => {
  const c = parseAmazonProduct(recorded('amazon-product-B0B6Z2ZGVK'), 'B0B6Z2ZGVK');
  expect(c).toEqual({
    asin: 'B0B6Z2ZGVK',
    title: 'RYOBI ONEAND HP 18V BRUSHLESS Cordless 1/4 in. Extended Reach Ratchet Tool ONLY PBLRC01B',
    brand: 'RYOBI',
    partNumber: 'PBLRC01B',
    upcs: ['033287193714'],
    price: 160,
    reviews: 212,
  });
  expect(grade({ brand: 'RYOBI', model: 'PBLRC01B' }, c!).grade).toBe('strong');
  expect(grade({ brand: 'RYOBI', model: 'PBLRC01B', upc: '033287193714' }, c!).grade).toBe('exact');
});

it('amazon-product-B0B3JWF5ZV carries brand, part number and barcode', () => {
  const c = parseAmazonProduct(recorded('amazon-product-B0B3JWF5ZV'), 'B0B3JWF5ZV');
  expect(c).toMatchObject({ asin: 'B0B3JWF5ZV', brand: 'RYOBI', partNumber: 'PBLRC25B', upcs: ['033287193721'], price: 169, reviews: 221 });
  expect(grade({ brand: 'RYOBI', model: 'PBLRC25B' }, c!).grade).toBe('strong');
});
```

- [ ] **Step 5: Write the Home Depot product test.**

```ts
it('hd-product-328814689 is the founder\'s bundle', () => {
  expect(parseHomeDepotProduct(recorded('hd-product-328814689'))).toEqual({
    retailer: 'homedepot',
    itemId: '328814689',
    storeSku: '1010927962',
    model: 'PBLRC2501SB',
    brand: 'RYOBI',
    upc: '033287232581',
    price: 189,
    regularPrice: 338,
    title: 'ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only)',
  });
  expect(parseHomeDepotProduct({})).toBeNull();
});
```

`brand` is read from `product_results.brand.name`; a plain string is accepted too. `storeSku` is `product_results.store_sku_number`. `upc` goes through `toUpc12` from `core/src/identifiers.ts`, as `hdPage.ts` does, so an invalid barcode is `null`. `regularPrice` is `product_results.promotion.original`, and `null` when there is no promotion. The function returns `null` when `product_id` or `title` is missing.

- [ ] **Step 6: Write the tolerance tests (Review Focus 1 to 5).** One `it` per line, on inline object literals that use the real field names:

```ts
it('keeps a Home Depot row with no price at all', () => {
  const { listings } = parseHomeDepotSearch({ products: [{ product_id: '1', title: 'T', model_number: 'M' }] });
  expect(listings[0]).toMatchObject({ itemId: '1', price: null, regularPrice: null, percentOff: null, badge: null, brand: null });
});
it('keeps an Amazon row with no price, and reads a price range as no price', () => {
  const rows = parseAmazonSearch({ organic_results: [{ asin: 'A1', title: 'T' }, { asin: 'A2', title: 'T', price: '$10.00 - $20.00' }] });
  expect(rows.map((r) => r.price)).toEqual([null, null]);
  expect(rows[0]).toMatchObject({ brand: null, reviews: null, sponsored: false });
});
it('reads sponsored only from sponsored: true', () => {
  const rows = parseAmazonSearch({ organic_results: [{ asin: 'A1', title: 'T', sponsored: true }, { asin: 'A2', title: 'T', sponsored: 'yes' }, { asin: 'A3', title: 'T' }] });
  expect(rows.map((r) => r.sponsored)).toEqual([true, false, false]);
});
it('reads no barcode and no part number from a detail page that has neither', () => {
  expect(parseAmazonProduct({ product_results: { title: 'RYOBI Ratchet PBLRC25B' } }, 'A1')).toMatchObject({ asin: 'A1', partNumber: null, upcs: [], brand: null });
});
it('reads every barcode when a detail page lists several', () => {
  expect(parseAmazonProduct({ product_results: { title: 'T' }, product_details: { upc: '033287193714 033287193721' } }, 'A1')!.upcs).toEqual(['033287193714', '033287193721']);
});
it('returns empty values for a successful response with no results', () => {
  const none = { search_metadata: { status: 'Success' }, error: "Amazon hasn't returned any results for this query." };
  expect(parseHomeDepotSearch(none)).toEqual({ listings: [], hasNextPage: false });
  expect(parseAmazonSearch(none)).toEqual([]);
  expect(parseAmazonProduct(none, 'X')).toBeNull();
  expect(parseHomeDepotProduct(none)).toBeNull();
});
it('skips rows without an id', () => {
  expect(parseHomeDepotSearch({ products: [{ title: 'no id' }] }).listings).toEqual([]);
  expect(parseAmazonSearch({ organic_results: [{ title: 'no asin' }] })).toEqual([]);
});
it('cleans brand strings', () => {
  expect(cleanBrand('Brand: DEWALT')).toBe('DEWALT');
  expect(cleanBrand('Visit the RYOBI Store')).toBe('RYOBI');
});
```

- [ ] **Step 7: Run the file and record which tests fail.** `npx vitest run core/test/parsers.recorded.test.ts`. Expected failures: everything that calls `parseHomeDepotProduct` (not defined), the two `pick() chooses the founder's listing` tests, the brand test and the DCF891B test (the parser drops `brand`), and any tolerance line that expects `brand: null` on an Amazon search row. Any other failure is a difference the controller did not see: report it before changing code.

- [ ] **Step 8: Correct `core/src/serpapi/parsers.ts`.** Add `brand: cleanBrand(str(r.brand))` to `parseAmazonSearch`. Add `parseHomeDepotProduct` under a `Home Depot product (engine=home_depot_product)` section, returning the existing `HdProduct` type imported from `../hdPage`. Replace the header comment (lines 3 to 6) with: `// Field names are confirmed against the responses recorded in fixtures/recorded/ on 2026-11-09.` followed by the existing sentence about tolerance. Change nothing else.

- [ ] **Step 9: Verify.** `npx vitest run core/test/parsers.recorded.test.ts` all pass; `npm run typecheck` prints nothing; `npm test` passes with the old 80 tests still green.

- [ ] **Step 10: Commit.** `fix: parsers confirmed against recorded SerpApi responses`.

**Report back (short):** the tests that passed first time, the tests that failed first and why, anything in a recording that contradicts `match.ts` or this plan, and the final test count.

### Task 3: Remove the doc-shaped samples

**Model:** `haiku` implementer, `sonnet` reviewer. Runs after Task 2 is reviewed and merged.

**Files:**
- Modify: `core/test/fixtures.ts`
- Modify: `core/test/budget.test.ts`
- Modify: `README.md`

- [ ] **Step 1:** In `core/test/fixtures.ts`, delete the exports `SERPAPI_HD_SEARCH`, `SERPAPI_AMAZON_SEARCH` and `SERPAPI_AMAZON_PRODUCT`. Keep `SERPAPI_ACCOUNT_FREE` and replace the section comment above it with: `// Account API sample. Not recorded: the real response contains the account's email and key.` In the file header (lines 3 to 4) replace the sentence about SerpApi-shaped samples with: `Recorded SerpApi responses live in fixtures/recorded/ and are loaded by core/test/recorded.ts.`
- [ ] **Step 2:** In `core/test/budget.test.ts`, delete the whole `describe('parsers (doc-shaped samples)', ...)` block and narrow the import on line 7 to `import { parseAmazonSearch } from '../src/serpapi/parsers';`.
- [ ] **Step 3:** In `README.md`, replace the last paragraph with: `What is verified: the core logic is tested on data read from live pages on 2026-11-09, and the SerpApi parsers are tested against responses recorded on 2026-11-09 in fixtures/recorded/.` and change `# 80 tests, no network` to the count `npm test` prints.
- [ ] **Step 4:** Verify. `grep -rn "SERPAPI_HD_SEARCH\|SERPAPI_AMAZON_SEARCH\|SERPAPI_AMAZON_PRODUCT\|doc-shaped" core scripts README.md` prints nothing. `npm run typecheck` prints nothing. `npm test` passes.
- [ ] **Step 5:** Commit: `test: replace doc-shaped SerpApi samples with recordings`.

### Task 4: Step gate (controller)

- [ ] `npm run typecheck` and `npm test`, run and read by the controller.
- [ ] Review the whole step's diff (`git diff <baseline>..HEAD`) on `fable`.
- [ ] `npm run budget`.
- [ ] Report to the user: what was built, the test count, which model did which task and what was escalated, searches spent, what is uncertain. Stop until the user says go.
