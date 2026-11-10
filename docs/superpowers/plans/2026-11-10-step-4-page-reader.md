# Step 4: Home Depot Page Reader — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During a scan, the extension reads each new bundle's own Home Depot page in the owner's browser, at no search cost, and the splitter uses what the page names, reconciled with the model-number split.

**Architecture:** The service worker cannot fetch Home Depot pages itself (refused, see below). It opens one background Home Depot tab as a doorway, runs a small self-contained function in it with `chrome.scripting.executeScript` that fetches each bundle page same-origin, a few at a time, and returns the embedded-data text. `core/` parses that text (`parseBundlePage`) and turns the bullets into a second split signal (`splitWithPage`). The runner reads unread bundles after the listing pages and before the split, through an injected `readPages` port, so tests and the command line run without Chrome.

**Tech Stack:** TypeScript, WXT 0.21, Chrome `scripting`, `tabs` and `windows` APIs, Vitest, Playwright.

**Spec:** `docs/v1-plan.md` ("Direction update", "Lean version 1"), `docs/decisions.md`, `CLAUDE.md`, the facts below.

## Facts proven on 2026-11-10 (no searches spent)

| Fact | How |
| --- | --- |
| A `fetch` from the extension's service worker to `https://www.homedepot.com/p/<id>` gets HTTP 403 and Akamai's 2.3 KB "Error Page", with or without `credentials: 'include'`, in the owner's real Chrome | Probe pasted into the worker console by the owner |
| The same `fetch('/p/<id>')` made from inside a Home Depot tab gets the full page (200, about 800 KB) | Claude in Chrome, owner's Chrome |
| From one tab, 29 of 29 pages came back full at 20 s apart, 5 s apart, back to back, 3 at once and 6 at once; 0.3 to 1.8 s each | Same |
| Playwright's Chromium is refused even for a plain tab visit to a product page; the home page loads | Probe in `e2e`'s browser |
| The page embeds `window.__APOLLO_STATE__={...}` in an inline script; more script text follows the object, so the whole script is not JSON | Same |
| The product is at key `base-catalog-<itemId>`: `identifiers` (`brandName`, `itemId`, `modelNumber`, `productLabel`), `details.description` (string) and `details.descriptiveAttributes[]` (`__typename: "DescriptiveAttribute"`, `name`, `value`, `bulleted`, `sequence`) | Same, items 320683876 and 324904496 |
| Chrome docs: `scripting.executeScript` needs the `scripting` permission plus host permission; `tabs.create` and `windows.create` need none; `DOMParser` is not available in a service worker | docs-checker, developer.chrome.com |
| A `windows.create({ state: 'minimized' })` opened a normal, visible window in Playwright on macOS. Not yet checked in the owner's Chrome | Probe |

## Global Constraints

- No SerpApi search in this step. Reading a page is never a search and never goes through `SerpApiClient`.
- Home Depot pages are read only from inside a Home Depot tab the extension opened. No request disguises itself; no headless browser; Amazon is never opened.
- Permissions become exactly `storage`, `alarms`, `sidePanel`, `notifications`, `scripting`. Host permissions unchanged. The end-to-end build may add `http://localhost/*`.
- The API key never reaches the tab, the injected function or a page.
- `core/src/` has no `chrome.*` and no `node:*` imports. Default tests use no network.
- Never guess: a page that does not fit the model number sends the bundle to review. Every rule is tested on real page text from `fixtures/homedepot-pages/`.
- A change is done when `npm run typecheck` and `npm test` pass. Small commits, one concern each, staged by file name.

## Review Focus

1. Home Depot changes its page so the data is missing or reshaped: every page comes back `unreadable`, nothing is stored, bundles keep their model-number split, and the scan record says so in one sentence. Task 2 (parser returns null), Task 4 (message).
2. The worker is stopped while the doorway tab is open: the tab is not left behind; the next reading closes it first. Task 5, test "closes a doorway left by a stopped worker".
3. Home Depot refuses part way: no further page is requested in that scan, unread bundles are tried next scan, and their splits fall back to the model number. Tasks 4 and 5.
4. A page names parts that do not fit the model number: the bundle goes to review with both readings in the reason; neither signal wins alone. Task 3.
5. A continued scan after an interruption between reading and splitting reads only the bundles still unread and spends nothing. Task 4.

## Routing

| Task | Model | Why |
| --- | --- | --- |
| 1 Record real pages | controller | A recording in the owner's browser |
| 2 Contracts and page parser | sonnet | Parsing on real text; contracts are written out below |
| 3 Page split and reconcile | opus | A splitting rule |
| 4 Runner reads pages before the split | opus | Scan state and resume |
| 5 Tab page reader | sonnet | Ordinary implementation against injected Chrome APIs |
| 6 Wiring, permission, end-to-end | sonnet | Ordinary; one end-to-end suite |
| 7 Proof in the owner's Chrome | controller and owner | Unit tests cannot see Home Depot |
| 8 Step gate | controller | Gates 4 to 6 of `docs/orchestration.md` |

Reviews: Tasks 3 and 4 by `opus`; Tasks 2, 5 and 6 by `sonnet`. Order: 1, 2, then 3 and 5 in parallel worktrees, then 4, then 6, 7, 8.

---

### Task 1: Record real pages (controller)

- [ ] In a Home Depot tab in the owner's Chrome, fetch these pages one at a time, 1.5 s apart: the 12 in `bullets-2026-11-10.json` plus 324903619, 320243741, 343659702, 334547651, 317987591, 206510146.
- [ ] For each, keep the text from `window.__APOLLO_STATE__=` up to `</script>`, with the state object cut down to `base-catalog-<id>` holding only `__typename`, `itemId`, `identifiers` and `details`, and the text after the object kept with letters and digits replaced by `x`.
- [ ] Save as `fixtures/homedepot-pages/pages-2026-11-10.json`: `{ "about": string, "pages": [{ "itemId": string, "status": number, "text": string }] }`. Add the 403 body from the worker probe as `fixtures/homedepot-pages/refused-2026-11-10.html` after checking it holds no address or cookie.
- [ ] Fill in the DEWALT rows of Task 3's table from the recorded bullets. Commit.

### Task 2: Contracts and page parser

**Files:** Modify `core/src/hdPage.ts`, `core/src/scan/types.ts`. Create `core/test/hd-page-reader.test.ts`.

**Interfaces (write exactly):**

```ts
// core/src/hdPage.ts
/** What a bundle's own Home Depot page says, read from its embedded data. */
export interface PageContent {
  /** details.descriptiveAttributes[].value, in page order, exactly as the page gives them. */
  bullets: string[];
  /** details.description; null when absent. Stored for review; not used to split. */
  description: string | null;
}
/** Null when the text has no `window.__APOLLO_STATE__=` object, it does not parse, or it has no `base-catalog-<itemId>`. */
export function parseBundlePage(text: string, itemId: string): PageContent | null;

// core/src/scan/types.ts
export interface PageReading extends PageContent {
  /** Clock time of the reading. */
  readAt: number;
}
// BundleRecord gains:
  /** What the bundle's own page said. Undefined or null: not read yet. */
  page?: PageReading | null;
/**
 * read        the page was read
 * unreadable  the page came back but its data could not be read
 * refused     Home Depot answered with something other than the page; reading stopped here
 * skipped     not tried, because reading stopped earlier
 */
export type PageOutcome =
  | { itemId: string; kind: 'read'; content: PageContent }
  | { itemId: string; kind: 'unreadable' | 'refused' | 'skipped' };
/** Reads bundle pages in the owner's browser. Never a search. */
export type ReadPages = (itemIds: string[]) => Promise<PageOutcome[]>;
// ScanSettings gains, default 60 in DEFAULT_SCAN_SETTINGS:
  /** Bundle pages read at most per scan. */
  pageReadsPerScan: number;
```

- [ ] **Tests first**, on `pages-2026-11-10.json` and `refused-2026-11-10.html`:
  - `320683876`: some bullet starts with `Includes: (1) PBLRC25 18V`.
  - `337440459`: at least 3 bullets start with `DCF921B:`; bullets keep page order.
  - `324904496`: `description` contains `PCL206`.
  - Every recorded 200 page parses; `bullets` are strings only.
  - Null for: the refused page; a recorded text asked for another item id; a recorded text cut in half.
- [ ] Implement: find the object right after `window.__APOLLO_STATE__=`, find its end by matching braces outside JSON strings (escapes included), `JSON.parse` it, read the product. No regex over the whole page for the bullets.
- [ ] `npm run typecheck`, `npm test`. Commit `feat(core): read a bundle page's bullets from its embedded data`.

### Task 3: Page split and reconcile

**Files:** Create `core/src/pageSplit.ts`, `core/test/page-split.test.ts`. Do not change `core/src/decompose.ts`.

**Interfaces:**

```ts
/** The models a page names at the level of boxed items, as a catalog the splitter can read. */
export function pageCatalog(brand: string, bullets: string[]): Catalog;
/** The split once the page is taken into account. `modelSplit` is the runner's split from the model number; `known` is the catalog it used (stored rows and saved listings). */
export function splitWithPage(
  bundle: { brand: string; model: string; title: string },
  modelSplit: Decomposition, page: PageContent | null, known: Catalog,
): Decomposition;
```

**Rules:**

- `pageCatalog`, DEWALT: the model before the first `:` of each bullet, matching `^([A-Z]{2,}\d[A-Z0-9]*):` (`DCK200D1P1: DCD799: …` gives `DCK200D1P1`, never `DCD799`). Brand `DEWALT`, no kinds, `isKit` when it starts with `DCK`.
- `pageCatalog`, RYOBI: every whole-word token of the shape `[A-Z]{1,6}\d{2,5}[A-Z0-9]*` (decompose's RYOBI model shape; `18V` and `18T` do not match) in bullets that start with `Includes` (case-insensitive), each also added with a `B` appended (the tool-only suffix the page leaves off). Brand `RYOBI`, no kinds, not kits. Any other brand: empty.
- `pageSplit = decompose(brand, model, title, pageCatalog(...))`.
- R1: `page` null → `modelSplit` unchanged. Page catalog empty → `modelSplit` with note `page names no models`.
- R2: both resolved, same parts → resolved, notes `['model number and page agree']`. Different → `needs_review`, note is `reconcile()`'s reason.
- R3: model split resolved, page split not. DEWALT → `needs_review`, note `page names <models>, which do not fit the model number`. RYOBI → model split stands, note `page does not name <parts>` (a RYOBI Includes list goes deeper than the boxed items, so it can confirm but not contradict).
- R4: model split not resolved, page split resolved → resolved from the page, notes `['split read from the page']`.
- R5: neither resolved. RYOBI only: `decompose` with `known` and the page catalog merged; resolved → notes `['parts known from the catalog and the page']`. Otherwise `modelSplit`.

- [ ] **Tests first**, one per row, bullets from `bullets-2026-11-10.json` (RYOBI) and `pages-2026-11-10.json` (DEWALT), `known` empty unless given:

| Item | Model | `known` | Result |
| --- | --- | --- | --- |
| 328814689 | PBLRC2501SB | — | resolved PBLRC01B, PBLRC25B; split read from the page |
| 328814689 | PBLRC2501SB | PBLRC01B, PBLRC25B | resolved; model number and page agree |
| 320683876 | PBLRC25B-PBP004 | — | resolved PBLRC25B, PBP004; split read from the page |
| 327939252 | PCL280B-PSK005 | — | needs_review |
| 327939252 | PCL280B-PSK005 | PSK005 | resolved PCL280B, PSK005; parts known from the catalog and the page |
| 341645081 | PCL1600K2-PBP004 | PCL1600K2, PBP004 | resolved; page does not name PCL1600K2, PBP004 |
| 341645081 | PCL1600K2-PBP004 | — | needs_review |
| 328690510 | PCL500525SB | — | needs_review; page names no models |
| 335849279 | PBLRC2501SB-A13401 | — | needs_review |
| 337440459 | DCK200D1P1W921B | — | resolved DCK200D1P1, DCF921B; split read from the page |
| 337440459 | DCK200D1P1W921B | DCF921B | resolved; model number and page agree |
| 337440459's bullets | DCK200D1P1WB606 | DCB606 | needs_review; page names DCK200D1P1, DCF921B, which do not fit the model number |
| 337440461, 343992133, 343992132 | their models | — | resolved from the page (filled in by Task 1) |
| any page | any | — | page null: unchanged, no note |

- [ ] Implement. Commit `feat(core): split a bundle from its page and reconcile with the model number`.

### Task 4: Runner reads pages before the split

**Files:** Modify `core/src/scan/runner.ts`, `core/src/scan/types.ts` (`ScanCounts.pagesRead`), `core/test/scan-runner.test.ts`.

**Interfaces:** Consumes `ReadPages`, `PageOutcome`, `PageReading` (Task 2), `splitWithPage` (Task 3). Produces `ScanDeps.readPages?: ReadPages` and `ScanCounts.pagesRead: number`.

**Rules:**

- P1: Once the listing queue is empty and before the split, bundles whose `page` is undefined or null, newest `seenAt` first then key, at most `pageReadsPerScan`, are passed to `readPages` in one call. Skipped when `readPages` is absent or `shouldStop()` is true.
- P2: Each `read` outcome is saved on its bundle as `{ ...content, readAt: now() }` and counts in `pagesRead`. Other outcomes leave the bundle as it is.
- P3: Any `refused` sets `stopMessage` to `Home Depot refused a page; the rest are read next scan.`. Otherwise any `unreadable` sets `A Home Depot page could not be read.`. A thrown error sets `Reading Home Depot pages failed: <message>`. None of these stops the scan or changes `status`.
- P4: Bundles are saved before the job. A job continued in the listing phase reads only bundles still unread.
- P5: The split is `splitWithPage(bundle, splitBundle(bundle, stored, catalog), bundle.page ?? null, catalog)`.

- [ ] **Tests first**, with the replayed recordings and a fake `readPages` built from `pages-2026-11-10.json` through `parseBundlePage`:
  - bundle 337440459 resolves to DCK200D1P1, DCF921B; `pagesRead` counts it; the client saw no extra request.
  - a second scan does not ask for a page already read.
  - a refused page: later ids get no reading, the message is set, the scan finishes with its parts planned.
  - `readPages` throws: the scan finishes, the message is set.
  - interrupted after reading, before the split: the continued job asks only for unread ids and spends nothing.
  - `pageReadsPerScan: 1` passes one id, the newest.
  - every existing runner test passes unchanged.
- [ ] Implement. Commit `feat(scan): read bundle pages before the split`.

### Task 5: Tab page reader

**Files:** Create `extension/lib/hdReader.ts`, `extension/lib/hdReader.test.ts`.

**Interfaces:**

```ts
export interface ReaderEnv {
  /** 'https://www.homedepot.com', or the replay server in the end-to-end build. */
  origin: string;
  /** Opens a background tab; never focuses it. */
  openTab(url: string): Promise<number>;
  closeTab(tabId: number): Promise<void>;
  /** Resolves when the tab has finished loading; rejects after timeoutMs. */
  waitForLoad(tabId: number, timeoutMs: number): Promise<void>;
  /** chrome.scripting.executeScript in the ISOLATED world; resolves with the function's result. */
  runInTab<A extends unknown[], R>(tabId: number, func: (...args: A) => Promise<R>, args: A): Promise<R>;
  /** chrome.storage.session, so a doorway left by a stopped worker can be closed. */
  remember(tabId: number | null): Promise<void>;
  remembered(): Promise<number | null>;
  sleep(ms: number): Promise<void>;
}
export interface InTabResult { itemId: string; status: number; text: string | null }
/** Runs inside the tab. Self-contained: no imports, no outside variables. Fetches `/p/<id>` same-origin, `concurrency` at a time, and returns the text from `window.__APOLLO_STATE__=` to the next `</script>`, or null. */
export function fetchPagesInTab(itemIds: string[], concurrency: number): Promise<InTabResult[]>;
export function createPageReader(env: ReaderEnv, opts?: { concurrency?: number; batch?: number; pauseMs?: number }): ReadPages;
```

Defaults: concurrency 3, batch 6 ids per `runInTab` call (keeps each extension call short for the worker's lifetime), 1000 ms between batches, 30 s load timeout.

- [ ] **Tests first**, with fakes:
  - no ids: no tab opened, `[]`.
  - one doorway at `<origin>/p/<first id>`; batches of at most 6; the tab is closed and forgotten afterwards, also when `runInTab` throws.
  - status 200 with parsable text → `read`; 200 with unparsable text → `unreadable`; anything else or null text → `refused`, every later id `skipped`, no further `runInTab` call.
  - the doorway does not load in time: throws `The Home Depot tab did not load.`, tab closed.
  - closes a doorway left by a stopped worker (a remembered tab id) before opening a new one.
  - `fetchPagesInTab` rebuilt from its own source with `new Function` still runs against a stubbed `fetch`, and respects `concurrency`.
- [ ] Implement, using `parseBundlePage`. Commit `feat(extension): read bundle pages from one background Home Depot tab`.

### Task 6: Wiring, permission, end-to-end

**Files:** Modify `extension/entrypoints/background.ts`, `extension/lib/worker.ts` (+ test), `wxt.config.ts`, `e2e/replay-server.ts`, `e2e/scan.spec.ts`, `e2e/settings.spec.ts`.

- [ ] `wxt.config.ts`: add `scripting` to permissions; define `__SPLIT_FINDER_HD_ORIGIN__` (`https://www.homedepot.com`, or the replay server in the end-to-end build) and `__SPLIT_FINDER_DEBUG__` (true only with `SPLIT_FINDER_DEBUG=1`).
- [ ] `background.ts`: build `ReaderEnv` from Chrome: `openTab` tries `windows.create({ url, focused: false, state: 'minimized' })` and falls back to `tabs.create({ url, active: false })`; `waitForLoad` with `tabs.onUpdated` and `tabs.get`; `runInTab` with `scripting.executeScript`; `remember` in `storage.session`. Pass `createPageReader(env)` to the worker; the worker passes it to `runScan` as `readPages`. With `__SPLIT_FINDER_DEBUG__`, set `globalThis.splitFinderReadPages = reader`.
- [ ] Replay server: `GET /p/<id>` answers a recorded page as HTML with the recorded text in a `<script>`; one chosen id answers 403 with the recorded refused page.
- [ ] End-to-end, tests first: a scan reads bundle 337440459's page through a background tab and stores the split DCK200D1P1, DCF921B; no tab is left open afterwards; a refused page does not stop the scan. Manifest test: permissions as in Global Constraints; the production build has no `splitFinderReadPages`.
- [ ] `npm run typecheck`, `npm test`, `npm run test:e2e`. Commit per concern.

### Task 7: Proof in the owner's Chrome (controller and owner)

- [ ] Build with `SPLIT_FINDER_DEBUG=1`. The owner reloads the unpacked extension, opens its service worker console and runs `await splitFinderReadPages([<the 12 bundle ids>])`.
- [ ] Pass: 12 `read` outcomes whose bullets match the recording, the doorway closed afterwards, nothing refused. Record whether the doorway opened minimized or as a background tab, and how long the call took.
- [ ] If the "minimized" window shows as a visible window, `openTab` uses the background tab only (a Haiku edit), and the decision is recorded.

### Task 8: Step gate (controller)

- [ ] Typecheck, `npm test`, `npm run test:e2e`, read the outputs. Review the whole step's diff. `npm run budget`.
- [ ] `docs/decisions.md`: the worker cannot fetch Home Depot; reading from a doorway tab; the pace; the RYOBI confirm-only and DEWALT leading-model rules; the description kept but not used; the `scripting` permission; Playwright cannot reach Home Depot, so the end-to-end suite replays pages.
- [ ] "Where this stands" in this plan. Stop and report.
