# Version 1 plan

Version 1 is a Chrome extension that runs entirely in the founder's browser. There is no
server. He installs it, pastes his own SerpApi key, and scans.

## What the founder asked for (Nov 9, 2026)

| He said | What v1 does |
| --- | --- |
| He adds the SerpApi key himself | A key field in Settings. Stored in `chrome.storage.local`, sent only to serpapi.com. |
| For now, run through what's available today | A **Scan now** button, and a one-off command-line run during development. No history, no database server. |
| He wants to change the frequency | Settings: only on click, every 6 or 12 hours, once a day at a chosen time, or every N hours. |
| Start on a free SerpApi key | Every paid search goes through a budget guard. See `search-budget.md`. |
| A proper Chrome extension as the front end | Side panel, a chip on Home Depot product pages, and a settings page. See `design.md`. |

## Scope

| In v1 | Not in v1 |
| --- | --- |
| Home Depot, via SerpApi and via the page he has open | Lowe's, Walmart, other retailers (SerpApi has no Lowe's engine) |
| DEWALT and RYOBI; brand list is a setting | Checking his seller account's listing restrictions (needs Amazon SP-API) |
| First-level splits: a bundle into its retail items | Breaking a manufacturer kit into loose tools |
| Amazon listing and price per part, via SerpApi | His real Amazon fees (uses fee settings instead) |
| Estimated profit, ranked list, CSV export | eBay or Facebook pricing |
| Review queue for anything uncertain | Buying, listing or repricing anything |
| Desktop alert for deals above his thresholds | Accounts, sync between computers, a mobile app |

## Architecture

    ┌───────────────────────────── Chrome ─────────────────────────────┐
    │  content script (homedepot.com)      side panel + settings page   │
    │   reads the open page (free)          React UI, reads the store   │
    │   shows the chip                              ▲                   │
    │            │ messages                          │ messages          │
    │            ▼                                   │                   │
    │  service worker ───────────────────────────────┘                  │
    │   scheduler (chrome.alarms) · scan runner · SerpApiClient + budget │
    │            │                                                      │
    │   IndexedDB (bundles, parts, matches, prices, cache, ledger)      │
    │   chrome.storage.local (settings, key)                            │
    └────────────│──────────────────────────────────────────────────────┘
                 ▼
            serpapi.com  (the only host the extension calls)

- `core/` holds all logic and has no Chrome or Node dependency, so it is tested in Node.
- The service worker is the only place that talks to SerpApi. UI surfaces ask it to act.
- A scan is a persisted job: a queue of steps saved in IndexedDB. If Chrome suspends the
  service worker mid-scan, the next alarm tick resumes from the saved step. No step is paid
  for twice, because every response is cached before the step is marked done.

Manifest V3. Permissions: `storage`, `alarms`, `sidePanel`, `notifications`. Host permissions:
`https://serpapi.com/*` and `https://www.homedepot.com/*`. Nothing else.

## How a scan works

1. Call the Account API (free). Build the budget from the account and the settings.
2. `planScan()` decides how the allowance is split between listing pages, new part lookups
   and stale price refreshes.
3. **Listing pages** (`engine=home_depot`, one search per page of 24): for each brand, search
   for combo kits and bundles, biggest discount first. Save every product seen: bundles go
   to the bundle store, single tools go to the catalog of known models.
4. **Split** each bundle with `decompose()` (free). Unresolved bundles create a review item.
5. **Look up** each part with no Amazon listing yet (`engine=amazon`, query = brand + model,
   one search each). `pick()` grades the results and chooses one listing, or creates a review item.
   A found listing is kept; later scans only refresh its price.
6. **Refresh** Amazon prices older than the freshness setting (default 3 days), most
   valuable bundles first, with whatever allowance is left.
7. `evaluateBundle()` computes each bundle's best listing combination and profit estimate.
8. Save the scan summary. Notify if any bundle clears the alert thresholds.

Work that did not fit the allowance is stored as waiting and goes first next time.

## The free path: reading the open page

On a `homedepot.com/p/...` page the content script reads the page's product data block
(model, UPC, price, was-price) and the component item ids in its review data. This costs no
searches. It feeds the same pipeline: the bundle is split, known parts are priced from the
store, and unknown parts show a "Look up · N searches" button. Every product page he visits
also adds that model to the catalog, which makes later splits more certain.

Home Depot is a single-page app, so the script re-reads on URL change.

## Matching policy with search-only data

An Amazon search result carries ASIN, title, price and review count, but no barcode, part
number or brand field. So:

| Grade | Evidence | Treatment |
| --- | --- | --- |
| exact | Barcode from the listing's detail page equals the part's barcode | Used. Shown as "Barcode verified". |
| strong | Part number from the detail page equals the model number | Used. Shown as "Verified". |
| probable | Title starts with the brand and contains the model number as a whole word; not renewed, aftermarket, a kit, or a multipack | Used. Shown as "Title match" with a "Verify · 1 search" button. |
| review | Model number in the title, brand not confirmed | Review queue |
| reject | Everything else | Hidden |

"Verify" loads the listing's detail page (`engine=amazon_product`) and upgrades the grade or
rejects the listing. If several listings are probable, the one with the most reviews is
chosen and the others are offered as alternatives.

## Stored data (IndexedDB)

| Store | Key | Holds |
| --- | --- | --- |
| `bundles` | retailer + item id | title, brand, model, UPC, price, was-price, seen at, split result |
| `catalog` | brand + model | title, tool-type words, kit flag, UPC if known |
| `matches` | brand + model | chosen ASIN, grade, alternatives, decided by (auto or user) |
| `prices` | ASIN | price, review count, seen at |
| `packaging` | bundle model | boxed, loose, or not confirmed (his answer) |
| `review` | id | open questions and his answers |
| `scans` | started at | plan, searches used, what was deferred, result counts |
| `cache` | search key | raw SerpApi response and when it was stored |
| `ledger` | time | every charged search, with a label |

Settings and the key live in `chrome.storage.local`.

## Acceptance criteria

1. With no key, the side panel shows the first-run steps and nothing can spend a search.
2. A wrong key is reported in plain words; a working key shows plan and searches left.
3. A scan never spends more than "searches per scan", never touches the reserve on a
   schedule, and stops cleanly at the hourly limit, saying which limit stopped it.
4. On the founder's example page (item 328814689) the chip appears with no search used, and
   the panel shows parts PBLRC25B and PBLRC01B.
5. With recorded fixtures, the pipeline maps PBLRC2501SB to B0B3JWF5ZV and B0B6Z2ZGVK.
6. On the validation set: no wrong listing among exact and strong matches; at least 95% of
   probable matches correct; every bundle the splitter could not resolve is in the review queue.
7. Changing the frequency takes effect without reloading the extension, and the forecast
   next to it matches `forecastUsage()`.
8. Closing Chrome mid-scan and reopening it resumes the scan without paying twice.
9. Every profit number is labelled an estimate.
10. `npm test` passes with the network disabled.

## Build order

| Step | Delivers | Searches |
| --- | --- | --- |
| 0 | Repo runs: typecheck and tests green | 0 |
| 1 | Record fixtures; parsers confirmed against real responses | up to 9 |
| 2 | Scan pipeline in `core/` with injected client and store; command-line run that writes a CSV | 0 with fixtures; up to 50 for the real run |
| 3 | Extension shell: service worker, storage, settings page with key check, frequency and forecast | 0 |
| 4 | Side panel: deals, detail, review, first-run and limit states | 0 |
| 5 | Home Depot content script, chip, This page tab | 0 |
| 6 | Validation set, accessibility pass, packaged build he can load | up to 50 |

Step 2's CSV is the "run through what's available today" the founder asked for, and it can
be sent to him before the extension exists.

## Later

Amazon SP-API for listing restrictions and exact fees; Lowe's through another data provider;
kit breakdowns with packaging-aware pricing; eBay prices for loose parts; price history.
