# Design decisions

Version 1 is a working first build. After it come fixes and features the owner asks for, and
then a production-grade rewrite (version 2). This file records what was decided in version 1,
why, and what a rewrite should look at again. Add an entry whenever a choice is made that the
code alone does not explain. Newest entries go at the end of their section.

Each entry: **the decision**, why, and *for v2* where there is something to reconsider.

## Product

- **Bundles first, kept lean.** Version 1 finds Home Depot bundles of RYOBI and DEWALT tools, splits them, matches each part to an Amazon listing and ranks by estimated profit. The owner plans to move to private label; this tool exists to raise capital, so nothing is built for reuse. *For v2:* decide first whether the tool still earns its keep.
- **No modular platform, no plug points for other retailers or categories** (considered and dropped, Nov 10). One example cannot show what varies. *For v2:* if a second retailer or category is real by then, that is the moment to draw the seams: a retailer source, a category rule set, a marketplace catalog.
- **Lowe's is out of version 1.** SerpApi has no Lowe's search. *For v2:* a page reader per retailer would cover it the way Home Depot is covered.
- **Results in sections.** Confirmed (every part has an active listing and the bundle has a price), Review: inactive listing, Review: missing listing, Contents not known. The owner asked for confirmed matches and a review split by missing versus inactive.
- **Boxed items decide the result.** A kit inside a bundle stays one sellable item; the tool does not break a kit into loose tools. A loose tool has no retail box, which matters for selling as New. *For v2:* the item-by-item breakdown from Home Depot's Includes list is saved-able and could be offered as a second view.
- **No model call and no agent at run time.** The pipeline is fixed and the budget must be predictable. *For v2:* an optional "suggest an answer" call in the review queue, never auto-confirming, if review is where the owner's time goes.

## Data sources

- **Amazon and Home Depot search through SerpApi with the owner's own key.** No server.
- **Amazon first, spread across scans.** Each scan reads a few pages of each brand's own Amazon listings (brand filter `rh=p_123:<id>`), saves model numbers, picture, title and price, and remembers its place. Every other Amazon response is saved the same way. Parts are matched from saved listings before a single-part search is paid for. This is the owner's description, made affordable. *For v2:* with a paid plan the crawl can be a real up-front index; barcodes still cost one search per listing.
- **Home Depot's "Includes" text is read from the page in the owner's browser** (planned, step 4), because SerpApi's product response does not carry it and Home Depot serves the page only to a real browser session. Amazon is never browsed with his account. *For v2:* this is scraping with his session; keep it slow, and confirm the terms.
- **Home Depot's bundle filter does not work through SerpApi** (`hd_filter_tokens` was accepted and ignored). On the site, the "Featured BOGO" page lists almost only bundles; the page reader can load it.
- **Model numbers are read from Amazon titles by brand pattern** (RYOBI `P…`, DEWALT `DC…`). Known misses: DEWALT `DW`/`DX`, RYOBI `RY`/`RYI`/`OLM`/`RHS`. A miss costs a paid lookup, never a wrong match. *For v2:* widen from real examples.

## Search budget

- **Every paid search goes through one client and one budget guard**: reserve, per-scan cap, hourly limit. The tightest wins. Only successful searches are charged, as SerpApi counts.
- **A scheduled scan never touches the reserve; a scan the owner starts may.** The per-scan cap holds across the whole job, including after it is continued.
- **If a number cannot be read, the scan spends nothing.** Unreadable usage, allowance or reserve gives a budget of zero, not a fresh allowance.
- **Known gap: a continued scan can spend one search over its allowance** when the worker dies between a paid Home Depot page and its save, because the job counts only saved steps. *For v2:* count from the ledger, which records every charged search.
- **No retries around a search.** A failed lookup or refresh is set aside and the scan moves on; two failures in a row stop it. A failed Home Depot page, a budget refusal or a 429 stops at once. *For v2:* a failed search that SerpApi still counted (a malformed 200) is invisible to the local budget.
- **The Amazon catalog phase may take at most a fifth of a scan's allowance.**
- **Listing pages are reused for one hour; a brand page for the freshness period (3 days), and always within one job.** Nothing is paid for twice in a job.
- **Saving settings never starts a scan.** A changed schedule starts its clock from the change.
- **Development spends from named buckets** (fixtures, validation, live, demo) with caps in code and a shared ledger. 14 of 250 used by Nov 10, all on recordings.

## Pipeline

- **A scan is a saved job.** Results are written to the store first, then the job is saved, after every paid step. An interrupted job is continued and repeats its last step from the cache.
- **Every response carries the time it was received** (`SearchResult.at`), and every time written from a response uses it, not the clock. A response replayed from the cache days later keeps its real age, and an older response never overwrites a newer record. Match records, review items, cursors and the job use the clock: they record when the tool decided something.
- **A job stopped by a limit is finished, not paused.** Its leftover lookups are marked waiting and go first next scan. Only a job interrupted mid-run is continued.
- **The pipeline depends on three injected things** (search client, budget view, store), so the same code runs in tests, on the command line and in the service worker. *For v2:* keep this; it is why 300+ tests run with no network.
- **Tests replay recorded SerpApi responses** through the real client and budget. Expected values come from the recordings. *For v2:* keep the recordings; they are the regression suite.
- **`runner.ts` has grown to about 600 lines.** *For v2:* split the catalog phase, the planning and the stopping rules into their own modules.

## Matching and splitting

- **Never guess.** An uncertain split or match becomes a review item or a lower grade. Tests are built on real examples.
- **An Amazon search row counts as "probable"** when its brand field (or title prefix) is the brand and the model number is a whole token in the title, and it is not renewed, aftermarket, a kit or a multipack. Search rows carry a brand field but no barcode or part number; a detail page (1 search) upgrades the grade.
- **A part matched from saved listings skips its lookup** even though the saved pool is not the same as a live search. Same evidence, same grade; the risk is a valid but less popular listing, never a different product.
- **Amazon title models may resolve a DEWALT bundle only to a kit plus one item, and only when the stored catalog found nothing for the short code** (three or more characters). A stored ambiguity is never settled by a title, and glued short codes are never resolved from titles; both go to review. A `DCK` model read from a title is always a kit. *For v2:* Home Depot's own page names the parts; once the page reader exists, this path matters less.
- **A bundle is recognised by the shape of its model number** (RYOBI hyphen or `SB`, DEWALT `…W…`); plain kits and single tools go to the catalog only and get no lookup.
- **`DCK…` is asked for as a kit; `DCB205-2` as a pack of 2.**
- **Known gaps, left as they are:** several RYOBI kits are not recognised as kits by the catalog rule; aftermarket "for DeWalt" titles land in review rather than being rejected; `PCL500525SB` (six-digit special buy) has no split rule.

## Extension

- **Manifest V3, built with WXT 0.21, React, plain CSS.** One npm package, WXT at the repo root with `srcDir: 'extension'`. Permissions: storage, alarms, sidePanel, notifications, scripting; hosts: serpapi.com and homedepot.com.
- **The service worker is the only context with the key.** Pages send typed messages. The key is in `chrome.storage.local`, restricted to trusted contexts, never in IndexedDB, logs or the page markup (the key field is uncontrolled so React does not mirror it into an attribute).
- **The worker answers only the extension's own pages.** A message from a content script or another extension is refused. *For v2 and step 6:* the chip on Home Depot pages will need its own short allow-list of message types.
- **A scan that cannot be saved is continued at most twice without progress**, then stopped with a plain sentence, so a full disk cannot become a spending loop.
- **The key is stripped from any error text before a scan record is stored.**
- **Bundle pages are read from a background Home Depot tab.** Home Depot refuses page requests from the service worker, so the reader (`extension/lib/hdReader.ts`) opens one minimized window (falling back to an inactive tab; neither needs a permission), runs `fetch('/p/<id>')` inside it with `scripting.executeScript` in the isolated world, and closes it. The tab id is kept in `storage.session` so a tab left by a stopped worker is closed on the next read. `scripting` is the one permission this adds. The function run in the tab is serialised from the built bundle; the end-to-end build proves the bundler leaves it self-contained. `globalThis.splitFinderReadPages` exists only when built with `SPLIT_FINDER_DEBUG=1`; a test asserts the production build has neither it nor any localhost text.
- **End-to-end tests use a separate build** (`SPLIT_FINDER_E2E=1`) that may talk to a local replay server on localhost; the production build has no localhost permission and a fixed SerpApi address, and a test asserts both.
- **A one-minute alarm is the heartbeat.** Each tick continues an interrupted scan or starts a due one; nothing relies on the worker staying alive or on an alarm surviving a restart.
- **IndexedDB sits behind the same store interface as the in-memory store**, proven by one shared conformance suite.
- **Stored settings are untrusted:** validated on read, with a default per failing field. The shape check lives in `extension/lib/worker.ts`; *for v2* it belongs in `core/` next to `validateSettings`.
- **Known gap: a network error's text is stored with the scan record** in IndexedDB. Replies to pages strip the key from such text; the stored copy does not. *For v2:* strip it where the runner records the message.
- **The settings page saves a field on blur or Enter**, radios and checkboxes at once; the forecast follows every keystroke.

## Design

- **Open question for the owner: the forecast meter's order.** It draws scheduled searches, then the reserve, then what is unused, so the unused part after the reserve can read as if the reserve were spent. The mockup never shows an unused part.
- **Build to the mockups and `docs/design.md`; token colors only.** Open question for the owner: the Settings mockup uses `#B9B6AD` (reserve meter) and `#1E3A8A` (link hover), which the token list does not have. The nearest tokens are used meanwhile.

## How it was built

- **One controller session plans, dispatches and reviews; subagents implement**, routed by model: mechanical work to the cheapest, state, budget and matching to the strongest. Each task is reviewed by an agent that did not write it. *For v2:* the plans in `docs/superpowers/plans/` and their "Where this stands" sections are the trail.
- **Parallel implementers each work in their own git worktree** and are merged by cherry-pick after the controller verifies them.
