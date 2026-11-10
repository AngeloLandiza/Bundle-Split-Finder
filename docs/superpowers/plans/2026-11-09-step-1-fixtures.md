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

- [ ] **Step 1:** `npm run budget`. Expected: `fixtures 0 of 15`, `May be spent now` at least 9.
- [ ] **Step 2:** `npm run fixtures:record -- --dry-run`. Expected: `0 of 9 fixtures already recorded. 9 to record (1 search each).`
- [ ] **Step 3:** Tell the user: 9 searches, `fixtures` bucket. Wait for the yes.
- [ ] **Step 4:** `npm run fixtures:record`, once. Expected: `Allowed to spend 9 now.` then nine `recorded <name> (network)` lines. If it stops early, do not run it again until the error has been read and understood: an errored search is free, and a re-run only requests the files that are still missing.
- [ ] **Step 5:** `npm run budget`. Expected: `fixtures 9 of 15`, `Used this month 9`. Report both numbers.
- [ ] **Step 6:** Leak check. `grep -rlF -- "$SERPAPI_API_KEY" fixtures/` prints nothing, and `grep -rl "api_key" fixtures/recorded/` is reviewed by hand (file names only; the key itself is never echoed).
- [ ] **Step 7:** `npm run fixtures:record -- --dry-run`. Expected: `9 of 9 fixtures already recorded. 0 to record`.
- [ ] **Step 8:** Commit: `test: record 9 SerpApi responses (fixtures bucket)`.
- [ ] **Step 9: Pin the recorded facts.** Read each file's structure with `jq` (key paths and the handful of values below, never whole files) and replace every ⟨pin⟩ in Task 2 with the value from the file. These values cannot be known before the searches are spent; nothing in Task 2 is dispatched while a ⟨pin⟩ remains.

### Task 2: Parsers confirmed against the recordings

**Model:** `sonnet` implementer, `sonnet` reviewer (`opus` reviewer if the diff touches anything outside the files below).

**Files:**
- Create: `core/test/recorded.ts`
- Create: `core/test/parsers.recorded.test.ts`
- Modify: `core/src/serpapi/parsers.ts`

**Interfaces:**
- Consumes: `grade(want: Wanted, cand: Candidate): Graded` and `pick(want: Wanted, candidates: Candidate[]): Picked` from `core/src/match.ts`, unchanged.
- Produces:
  - `core/test/recorded.ts`: `export const RECORDED_NAMES = [...] as const` (the 9 names), `export type RecordedName = (typeof RECORDED_NAMES)[number]`, `export function recorded(name: RecordedName): unknown` which reads `fixtures/recorded/<name>.json` with `node:fs` relative to the file's own URL and returns `JSON.parse` of it.
  - `core/src/serpapi/parsers.ts`: existing signatures unchanged, plus

    ```ts
    export interface HdProduct {
      itemId: string;
      title: string;
      brand: string | null;
      model: string | null;
      upc: string | null;
      price: number | null;
      regularPrice: number | null;
    }
    export function parseHomeDepotProduct(json: unknown): HdProduct | null;
    ```

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
  ['hd-search-ryobi-combo-p1', ⟨pin: product count⟩, ⟨pin: rows with a model number⟩, ⟨pin: rows with a was-price⟩, ⟨pin: has next page⟩],
  ['hd-search-dewalt-combo-p1', ⟨pin⟩, ⟨pin⟩, ⟨pin⟩, ⟨pin⟩],
  ['hd-search-ryobi-ratchet', ⟨pin⟩, ⟨pin⟩, ⟨pin⟩, ⟨pin⟩],
] as const)('parseHomeDepotSearch(%s)', (name, count, withModel, withWas, next) => {
  const { listings, hasNextPage } = parseHomeDepotSearch(recorded(name));
  it('keeps every product row', () => expect(listings).toHaveLength(count));
  it('reads an all-digit item id and a title on every row', () => {
    for (const l of listings) { expect(l.itemId).toMatch(/^\d+$/); expect(l.title.length).toBeGreaterThan(0); }
  });
  it('reads model numbers', () => expect(listings.filter((l) => l.model).length).toBe(withModel));
  it('reads was-prices as numbers above the price', () => {
    const marked = listings.filter((l) => l.regularPrice !== null);
    expect(marked).toHaveLength(withWas);
    for (const l of marked) expect(l.regularPrice!).toBeGreaterThan(l.price!);
  });
  it('reads pagination', () => expect(hasNextPage).toBe(next));
});

it('reads one known row exactly', () => {
  const { listings } = parseHomeDepotSearch(recorded('⟨pin: file⟩'));
  expect(listings.find((l) => l.itemId === '⟨pin⟩')).toEqual(⟨pin: the full HdListing for one row, typed from the file⟩);
});
```

- [ ] **Step 3: Write the Amazon search tests.**

```ts
it.each([
  ['amazon-search-PBLRC25B', 'RYOBI', 'PBLRC25B', 'B0B3JWF5ZV'],
  ['amazon-search-PBLRC01B', 'RYOBI', 'PBLRC01B', 'B0B6Z2ZGVK'],
] as const)('%s: pick() chooses the founder\'s listing', (name, brand, model, asin) => {
  const results = parseAmazonSearch(recorded(name));
  const hit = results.find((r) => r.asin === asin)!;
  expect(typeof hit.price).toBe('number');
  expect(typeof hit.reviews).toBe('number');
  expect(pick({ brand, model }, results).chosen).toMatchObject({ asin, grade: 'probable' });
});

it('amazon-search-DCF891B: a listing is chosen and it is a title match', () => {
  const picked = pick({ brand: 'DEWALT', model: 'DCF891B' }, parseAmazonSearch(recorded('amazon-search-DCF891B')));
  expect(picked.chosen?.grade).toBe('probable');
});

it('marks sponsored results', () => {
  const results = parseAmazonSearch(recorded('⟨pin: file with a sponsored row⟩'));
  expect(results.filter((r) => r.sponsored).map((r) => r.asin)).toEqual(⟨pin: ASINs⟩);
});
```

The DEWALT test does not pin an ASIN: which listing is correct for DCF891B is confirmed with the user in step 6, not assumed here. Print nothing; the controller reads the chosen ASIN from the recording for the report.

- [ ] **Step 4: Write the Amazon product tests.**

```ts
it('amazon-product-B0B6Z2ZGVK carries brand, part number and barcode', () => {
  const c = parseAmazonProduct(recorded('amazon-product-B0B6Z2ZGVK'), 'B0B6Z2ZGVK')!;
  expect(c).toMatchObject({ asin: 'B0B6Z2ZGVK', brand: 'RYOBI', partNumber: 'PBLRC01B' });
  expect(c.upcs).toEqual(⟨pin: the UPC list in the file; '033287193714' is what Amazon's own page showed⟩);
  expect(grade({ brand: 'RYOBI', model: 'PBLRC01B' }, c).grade).toBe('strong');
});

it('amazon-product-B0B3JWF5ZV carries brand and part number', () => {
  const c = parseAmazonProduct(recorded('amazon-product-B0B3JWF5ZV'), 'B0B3JWF5ZV')!;
  expect(c).toMatchObject({ asin: 'B0B3JWF5ZV', brand: 'RYOBI', partNumber: 'PBLRC25B' });
  expect(grade({ brand: 'RYOBI', model: 'PBLRC25B' }, c).grade).toBe('strong');
});
```

If a recording carries no UPC or no part-number field, the pinned expectation is `[]` or `null` and the `grade` line is pinned to what the evidence supports. The parser is not changed to find one somewhere else.

- [ ] **Step 5: Write the Home Depot product test.**

```ts
it('hd-product-328814689 is the founder\'s bundle', () => {
  expect(parseHomeDepotProduct(recorded('hd-product-328814689'))).toEqual({
    itemId: '328814689',
    title: ⟨pin⟩,
    brand: 'RYOBI',
    model: 'PBLRC2501SB',
    upc: ⟨pin: '033287232581' is what the page showed⟩,
    price: ⟨pin⟩,
    regularPrice: ⟨pin⟩,
  });
  expect(parseHomeDepotProduct({})).toBeNull();
});
```

- [ ] **Step 6: Write the tolerance tests (Review Focus 1 to 5).** Inline object literals shaped with the field names the recordings use (⟨pin: field names⟩), one `it` per line of Review Focus, plus: a row with no product id is skipped, a row with no ASIN is skipped, `parseHomeDepotSearch({})` returns `{ listings: [], hasNextPage: false }`, `parseAmazonSearch({})` returns `[]`, `parseAmazonProduct({}, 'X')` returns `null`, `cleanBrand('Brand: DEWALT')` is `'DEWALT'` and `cleanBrand('Visit the RYOBI Store')` is `'RYOBI'`.

- [ ] **Step 7: Run the file and record which tests fail.** `npx vitest run core/test/parsers.recorded.test.ts`. Expected: `parseHomeDepotProduct` fails (not defined); any other failure is a documentation mismatch.

- [ ] **Step 8: Correct `core/src/serpapi/parsers.ts`.** Change only field paths and add `parseHomeDepotProduct`. Replace the header comment (lines 3 to 6) with one line saying field names are confirmed against `fixtures/recorded/` and which date they were recorded. Remove fallbacks that no recording exercises only where the recording shows the documented name does not exist.

- [ ] **Step 9: Verify.** `npx vitest run core/test/parsers.recorded.test.ts` all pass; `npm run typecheck` prints nothing; `npm test` passes with the old 80 tests still green.

- [ ] **Step 10: Commit.** `fix: parsers confirmed against recorded SerpApi responses`.

**Report back (short):** the tests that passed first time, the fields that had to change (old name, real name), anything in a recording that contradicts `match.ts` or the plan, and the final test count.

### Task 3: Remove the doc-shaped samples

**Model:** `haiku` implementer, `sonnet` reviewer. Runs after Task 2 is reviewed and merged.

**Files:**
- Modify: `core/test/fixtures.ts`
- Modify: `core/test/budget.test.ts`
- Modify: `README.md`

- [ ] **Step 1:** In `core/test/fixtures.ts`, delete the exports `SERPAPI_HD_SEARCH`, `SERPAPI_AMAZON_SEARCH` and `SERPAPI_AMAZON_PRODUCT`. Keep `SERPAPI_ACCOUNT_FREE` and replace the section comment above it with: `// Account API sample. Not recorded: the real response contains the account's email and key.` In the file header (lines 3 to 4) replace the sentence about SerpApi-shaped samples with: `Recorded SerpApi responses live in fixtures/recorded/ and are loaded by core/test/recorded.ts.`
- [ ] **Step 2:** In `core/test/budget.test.ts`, delete the whole `describe('parsers (doc-shaped samples)', ...)` block and narrow the import on line 7 to `import { parseAmazonSearch } from '../src/serpapi/parsers';`.
- [ ] **Step 3:** In `README.md`, replace the last paragraph with: `What is verified: the core logic is tested on data read from live pages on 2026-11-09, and the SerpApi parsers are tested against responses recorded on ⟨pin: date⟩ in fixtures/recorded/.` and change `# 80 tests, no network` to the count `npm test` prints.
- [ ] **Step 4:** Verify. `grep -rn "SERPAPI_HD_SEARCH\|SERPAPI_AMAZON_SEARCH\|SERPAPI_AMAZON_PRODUCT\|doc-shaped" core scripts README.md` prints nothing. `npm run typecheck` prints nothing. `npm test` passes.
- [ ] **Step 5:** Commit: `test: replace doc-shaped SerpApi samples with recordings`.

### Task 4: Step gate (controller)

- [ ] `npm run typecheck` and `npm test`, run and read by the controller.
- [ ] Review the whole step's diff (`git diff <baseline>..HEAD`) on `fable`.
- [ ] `npm run budget`.
- [ ] Report to the user: what was built, the test count, which model did which task and what was escalated, searches spent, what is uncertain. Stop until the user says go.
