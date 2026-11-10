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

## Direction update (Nov 10, 2026)

The founder described the tool in his own words after seeing step 2. Where this section and
a later section disagree, this section wins until the later one is rewritten.

| He said | What it changes |
| --- | --- |
| The scraper first identifies RYOBI and DEWALT products on Amazon and saves model number, picture, title and barcode | A new first phase saves Amazon listings into a catalog. Bundle parts are matched against the saved catalog before any single-part lookup is paid for. |
| Bundles say what they contain in the title and in an "Includes" section, with model numbers | The split reads the retailer's own Includes list. The model-number rules stay as a second signal. |
| Find combinations of listings that leave no leftover tools | Results have two sections: **Confirmed matches** (every part has an active listing) and **Review**, split into **missing listing** and **inactive listing**. |
| Some Amazon listings hold several products or a multipack | A listing may cover more than one part. The combination finder already allows it. |
| Only listings with the brand RYOBI or DEWALT | Unchanged: any other brand, including "Amazon Renewed", never counts. |
| Lowe's often has the same bundle cheaper | Lowe's comes after Home Depot, as its own step. When both carry a bundle, the cheaper one is shown. |
| A Home Depot BOGO deal: go through each item in it | Each "kit + free tool" option is evaluated as its own bundle and the options are shown together. |
| Free SerpApi plan for now | 250 searches a month stays the design budget. |

### What was checked on homedepot.com (2026-11-10, in a browser, no searches spent)

- **The Includes list is on the product page, with model numbers.** Item 328814689 says, under
  Product Details: `Includes: (1) PBLRC01 18V ONE+ HP Brushless 1/4" Extended Reach Ratchet
  (1) PBLRC25 18V ONE+ HP Brushless Cordless 3/8 in. Extended Reach Ratchet and Operator's Manual`.
  The models are written without the tool-only suffix (PBLRC01, not PBLRC01B).
- **SerpApi's `home_depot_product` response does not carry that list.** Its highlights say only
  `Includes: 1/4" and 3/8" Extended Reach Ratchets`. The list has to be read from the page.
- **The page can be read for free from the user's own browser.** The list is in the page's
  embedded data before anything is clicked. A request without the browser's cookies gets a
  2.5 KB placeholder instead of the page, so a plain script outside the browser cannot read it.
- **An Includes list can go deeper than the retail items.** `PCL1201K2-PCL430B` lists the loose
  tools inside the kit (`(1) PCL206 ... Drill/Driver, (1) PCL500 ... Circular Saw, (2) 18V compact
  batteries, Charger, Bag`). Some pages list items with no model number at all
  (`PCL500525SB`: "an 18V 5-1/2 in. Circular Saw, 18V Jig Saw").
- **DEWALT pages name the parts the short code hides.** The page for `DCK200D1P1W921B` names
  DCK200D1P1, DCD799, DCF850, DCF921B, DCB205 and DCB203.
- **A BOGO deal is a kit with a menu of free tools, and every option is its own listing.** The kit
  `PCL1201K2` at $179 is marked "Free Gift With Purchase"; `PCL1201K2-PCL430B`,
  `PCL1201K2-PCL515B`, `PCL1201K2-PCL265B` and eight more are listed at the same price. Home
  Depot has a "Featured BOGO" filter (token `1z24hvk`), 104 results for "ryobi 18v combo kit".

### Open decisions

1. **How Home Depot pages are read.** Recommended: the extension reads them in the user's own
   browser (free, and the only place the Includes list exists), and Amazon stays on SerpApi so
   his Amazon account is never used for automated browsing.
2. **How deep a split goes.** His example splits a bundle down to each drill, battery and
   charger. A tool taken out of a kit has no retail box, which matters for selling it as New on
   Amazon (see the packaging rule in `core/src/money.ts`).
3. **A model written without its suffix** (PBLRC01 for PBLRC01B): which listing is the right one
   when the catalog also holds PBLRC01K1.

### Lean version 1 (decided Nov 10, 2026)

The owner plans to move to private label later; these tools exist to raise capital. So
version 1 does only what finds him a deal he can act on, and nothing is built for reuse.

| Kept | Cut from version 1 |
| --- | --- |
| The scan pipeline, budget guard and matching already built | A modular platform, or plug points for other retailers and categories |
| Results in sections: Confirmed, Review (inactive listing, missing listing), contents not known | Lowe's |
| Reading Home Depot pages in his browser for the Includes list | Special handling for BOGO deals: each kit-plus-free-tool option is already its own listing and is evaluated as a bundle |
| The extension: settings, side panel, chip on Home Depot pages | The item-by-item split comparison; boxed items decide the result |
| Validation set and a build he can load | The paid command-line demo run |

**Amazon catalog (owner's choice, Nov 10): Amazon first, as he described, in a form the free
plan can afford.** A scan first reads a small number of pages of each brand's own Amazon
listings and saves model numbers, picture, title and price. It remembers where it stopped, so
the crawl continues across scans until it has passed over every listing, then starts again.
Every other Amazon response the tool pays for is saved the same way. Bundle parts are matched
against the saved listings first; a single-part search is paid for only when they have no
answer. Recorded facts: about 7,800 RYOBI and DEWALT listings in total, 60 rows a page; 40 of 60
DEWALT rows and 17 of 51 RYOBI rows carry a model number in the title; barcodes are not in
search rows and still need a listing's detail page (1 search). See
`docs/superpowers/plans/2026-11-10-step-2c-amazon-catalog.md`.

**Home Depot's bundle filter does not work through SerpApi.** `hd_filter_tokens=bwo64,<brand>`
was accepted and returned 22 of the same 24 products as the unfiltered page (recorded
2026-11-10). On Home Depot's own site the "Featured BOGO" page lists almost only bundles;
the extension can load that page in his browser.

**Proposed order for the remaining steps** (replaces rows 3 to 6 of "Build order" once agreed):

| Step | Delivers |
| --- | --- |
| 2c | Amazon catalog phase: save listings first, match parts from them before any lookup |
| 3 | Extension shell: service worker, storage, settings page with key check, frequency and forecast |
| 4 | Home Depot page reader: loads bundle pages in his browser, reads the Includes list, feeds the splitter |
| 5 | Side panel: Confirmed, Review, detail, first-run and limit states |
| 6 | Chip on Home Depot product pages, This page tab |
| 7 | Validation set, accessibility pass, packaged build he can load |

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

An Amazon search result carries ASIN, title, price, review count and, on most rows, a brand
field. It carries no barcode or part number, and its title usually does not start with the
brand (recorded responses, 2026-11-09). So:

| Grade | Evidence | Treatment |
| --- | --- | --- |
| exact | Barcode from the listing's detail page equals the part's barcode | Used. Shown as "Barcode verified". |
| strong | Part number from the detail page equals the model number | Used. Shown as "Verified". |
| probable | Brand confirmed, by the result's brand field or by a title that starts with the brand, and the title contains the model number as a whole word; not renewed, aftermarket, a kit, or a multipack | Used. Shown as "Title match" with a "Verify · 1 search" button. |
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
| 2b | Direction update: Amazon catalog phase, Includes-list reader, Confirmed and Review sections | 2 to record filtered pages; the real run after |
| 3 | Extension shell: service worker, storage, settings page with key check, frequency and forecast | 0 |
| 4 | Side panel: deals, detail, review, first-run and limit states | 0 |
| 5 | Home Depot content script, chip, This page tab | 0 |
| 6 | Validation set, accessibility pass, packaged build he can load | up to 50 |

Step 2's CSV is the "run through what's available today" the founder asked for, and it can
be sent to him before the extension exists.

## Later

Amazon SP-API for listing restrictions and exact fees; Lowe's through another data provider;
kit breakdowns with packaging-aware pricing; eBay prices for loose parts; price history.
