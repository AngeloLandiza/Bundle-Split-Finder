# Search budget

Every SerpApi search is a scarce resource. This file is the rulebook for spending them,
in development and in the shipped extension.

## The facts (checked on serpapi.com, 2026-11-09)

| Fact | Value | Source |
| --- | --- | --- |
| Free plan allowance | 250 searches a month | serpapi.com/pricing |
| Free plan throughput | 50 searches an hour | serpapi.com/pricing |
| What counts | Only successful searches. One search = one count, whether it returns 100 results or none. | serpapi.com/pricing |
| What is free | Cached, errored and failed searches | serpapi.com/pricing |
| SerpApi's own cache | 1 hour, only for an identical query and parameters | serpapi.com/amazon-search-api |
| Account API | Free. Reports plan, searches left, this hour's use, hourly limit | serpapi.com/account-api |
| HTTP 429 | Hourly limit hit, or out of searches | serpapi.com/api-status-and-error-codes |
| Paid plans | $25 = 1,000 · $75 = 5,000 · $150 = 15,000 a month | serpapi.com/pricing |

What one search buys:

| Engine | Returns | Use |
| --- | --- | --- |
| `home_depot` | 24 products with model number, price, was-price | Today's bundles |
| `home_depot_product` | One product with UPC | Only when a barcode is needed |
| `amazon` | A page of results: ASIN, title, brand, price, review count | Find a part's listing and price |
| `amazon_product` | One listing with UPC and brand | Upgrade a "title match" to "verified" |

Reading a Home Depot page the user has open costs nothing: the extension parses the page.

## The guard

`SearchBudget` (core/src/serpapi/budget.ts) allows a paid search only when all three hold:

1. **Reserve.** Searches left on the account, minus the reserve, is at least 1.
2. **Run cap.** This scan or session has not reached its own limit.
3. **Hourly limit.** The plan's throughput for this hour is not used up.

`SerpApiClient.search()` checks the cache first (free), then the guard, then the network.
A blocked search throws `BudgetExceededError` with the reason; it never reaches the network.
Only a successful response is charged, matching how SerpApi counts.

## Development plan for the free 250

| Bucket | Cap | What it pays for |
| --- | --- | --- |
| `fixtures` | 23 | Record each request in `scripts/record-fixtures.ts` once (15, plus 8 moved from validation by the owner on Nov 11 for step 6's kit recordings) |
| `validation` | 42 | Amazon lookups for the ~30-bundle validation set, cached on disk (50, less the 8 moved to fixtures) |
| `live` | 15 | `npm run test:live`, at most 2 a run |
| `demo` | 50 | One real run over today's Home Depot listings for the founder |
| reserve | 100 | Never spent in development |
| unassigned | 20 | Slack |

The caps live in `scripts/dev-budget.ts`. A unit test fails if they stop fitting the free plan
or if any bucket is too big to spend within one hour's limit.

Every paid call is appended to `.serpapi-ledger.jsonl` with a label that starts with its
bucket (`fixtures:...`, `validation:...`). `openDevClient(bucket, max)` refuses to spend past a
bucket's cap for the month, and `npm run budget` shows the account and each bucket side by side.

### Workflow

1. `npm run budget` to see where things stand (free).
2. `npm run fixtures:record -- --dry-run`, then without `--dry-run`. Spends up to 9, once.
3. Fix `core/src/serpapi/parsers.ts` against the recorded files, and replace the doc-shaped
   samples in `core/test/fixtures.ts` with imports of the recordings.
4. All further parser and pipeline work replays the files. Zero searches.
5. Before the demo run, `npm run budget` again and confirm at least 50 above the reserve.

If the budget is closed: wait for the next hour (hourly limit) or the plan renewal (monthly).
Do not work around it with a second key. (Development has one key, the development key, and this rule stands. The
desktop app's own store of the owner's keys may hold several of his own, below; that is never the development key.)

### With subagents and git worktrees

Several agents working at once is the easiest way to overspend, so two things are enforced
in `scripts/node-store.ts`:

- **One ledger.** The key (`.env`), the cache and the ledger always resolve to the main
  checkout, even when a script runs inside a linked git worktree. Without this, every
  worktree would start with an empty ledger and an empty cache, and would pay again for
  responses that were already recorded.
- **One spender.** `openDevClient()` takes a lock file (`.serpapi.lock`). A second process
  that tries to spend while the first is alive gets a `SpendLockError`. A lock left behind
  by a crashed process is taken over.

The rule on top of the code: only the main session runs a paid command, and subagents work
from recorded files. See `orchestration.md`.

## In the extension

The same guard runs in the service worker, fed by a fresh Account API call at the start of
every scan.

- **Scheduled scans** use the user's settings: `reserve` and `searches per scan`. They can
  never touch the reserve.
- **Actions the user clicks** (Verify, Look up on one bundle) may spend from the reserve, down
  to zero. Every such control shows its cost before the click ("Verify · 1 search").
- **The desktop app's Scan now, Read again and Look up now keep the reserve** (Nov 23): at or
  below it they spend no search, and the one way to spend it is the owner's explicit "Use searches
  for these (up to N of your M left)", still under the per-scan limit. Every control that starts a
  scan says what it may spend first. See docs/decisions.md, "Honest spend".
- `planScan()` (core/src/scanPlan.ts) splits a scan's allowance: listing pages first, then
  new part lookups, then stale price refreshes. Work that does not fit is deferred to the
  next scan and shown as waiting, never dropped. A planned step the cache answers frees its
  slot for the next deferred step of its phase, and deferred listing pages go first next scan.
  A step that failed (a lookup set aside, or a page an error stopped on) is planned after the
  other work of its phase, so one that keeps failing never holds the only slot; failing lookups
  wait behind every other part until they are answered, the least recent failure first.
  The items of a kit inside a bundle are looked up by a scan only once the kit itself was looked up
  and has no active listing and no open match question, and then last of all, from what every other lookup and refresh leaves;
  a saved listing still matches them for nothing, and the panel's Look up may ask for them at any time.
- `forecastUsage()` (core/src/schedule.ts) shows, next to the frequency setting, the worst
  case a schedule can use in a month against the plan, before the setting is saved.

On the free plan a daily scan can afford about 5 searches (150 usable ÷ 30). Scanning only
on click is the default; the $75 plan (5,000) fits a daily scan of 40 with room to spare.

## Several keys of the owner's own (desktop app, Nov 25)

The desktop agent's store may hold more than one SerpApi key and more than one Keepa key, each the key of its own account
(the owner's partner's, a paid plan). Only the agent's store of the owner's keys; the development key, the extension's own
key and `DEV_ALLOCATION` are untouched. The guard is the same `SearchBudget`, built from several accounts:

1. **Each key is checked on its own**, with the free account check, at the start of every scan, Look up, Verify and
   listing check. A key SerpApi refuses is left out and said beside it; one whose check did not answer is left out of
   that run (its balance is not known, so nothing is spent on it). Every key refused refuses the run, as one key did.
2. **Searches left = the sum** over the accepted keys; the month's allowance = the sum of their plans.
3. **The reserve and the per-scan cap are single numbers on the total**, exactly as before: a scheduled scan never touches
   the reserve, only the owner's explicit "Use searches for these" spends from it, still under the per-scan cap.
4. **The hourly limit is each account's own.** A search needs one key with both a search left and room in its hour.
5. **A search is charged to one key, chosen before the call:** the accepted key with the most searches left that is not at
   its hourly limit (the earlier key on a tie). `serpapi-ledger.jsonl` rows carry that key's id (`keyId`), never the key;
   rows written before have none and are read as the first key's.
6. **One fall-over, never a retry.** If SerpApi answers the chosen key with 401 (key not accepted) or 429 (that account at
   its hourly limit or out of searches), both uncharged per the table above, that key is marked for the run and the same
   search may go once with the next key, when the keys left can still pay within the reserve, the run and the hour.
   Never more than two sends for one search, never twice to one key. Any other failure is handled exactly as before.
   No recorded fixture holds a 401 or 429 body: the rule reads the HTTP status only, as the client always has.

Keepa: tokens are per key. Tokens available and the refill a minute are the sums; the Keepa reserve is on the total; a
request uses one key that holds its tokens; the drip waits until one key holds a lookup's tokens
(`minutesUntilTokens`). `keepa-ledger.jsonl` rows carry `keyId`. A Keepa request is never sent again with another key.

## Keepa tokens (v2 prototype)

Development Keepa spend uses `KEEPA_API_KEY` and `KEEPA_RESERVE` in `.env` (see `.env.example`).
Every paid call goes through `core/src/keepa/client.ts`; in Node, through `scripts/open-keepa-dev.ts`
(the same spend lock as SerpApi).

| Command | Cost |
| --- | --- |
| `npm run keepa:budget` | Free when the file cache already has a product response (reads `tokensLeft` from meta) |
| `npm run keepa:measure` | Free (fixtures only) |
| `npm run keepa:record` | Pays only for fixtures not on disk; `--dry-run` is free |

Reserve and account balance apply **after** the first Keepa response in a session (meta fields).
Before that, only the per-run cap blocks spends.
