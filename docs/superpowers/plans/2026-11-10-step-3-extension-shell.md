# Step 3: Extension Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A loadable Chrome extension with a service worker that runs and resumes scans on a schedule within the search budget, IndexedDB behind the existing `ScanStore`, and a settings page with key check, frequency, searches per scan, reserve and a live forecast.

**Architecture:** WXT builds the extension from `extension/`; all logic stays in `core/`, which the extension imports through an alias. The service worker is the only context that holds the key and talks to SerpApi; pages send it typed messages. A one-minute alarm is the heartbeat: each tick continues an interrupted scan or starts a due one, so nothing depends on the worker staying alive.

**Tech Stack:** TypeScript 7, WXT 0.21 (Vite), React, `idb`, Vitest with WXT's fake browser and `fake-indexeddb`, Playwright for end-to-end tests. Plain CSS with the tokens in `docs/design.md`.

**Spec:** `docs/v1-plan.md` (Architecture, acceptance criteria 1, 2, 3, 7, 8, 10; "Lean version 1"), `docs/design.md` and `docs/design/mockups/Settings.dc.html`, `docs/search-budget.md` ("In the extension"), `docs/orchestration.md`, `CLAUDE.md`.

## Where this stands (step 3 complete, 2026-11-10)

Branch `step-3-extension-shell`. Every task below is merged and reviewed. Gate run by the
controller: typecheck clean, 334 core and 123 extension tests, 8 end-to-end tests in a real
browser, `ui-reviewer` PASS on the settings page. 14 searches used this month, 236 left;
step 3 spent none. Step 2c (the Amazon catalog phase) was finished on this branch too.

Still owed, none blocking:

- Screenshots of three settings states the visual review could not see: the "Remove key"
  confirmation, the "Checking" label, and the "Lower the reserve, or scan less often." text.
- A real icon for the extension and its notifications (a 1x1 placeholder is used).
- The deferred minor review notes, which were kept in a scratch ledger during the build; the
  ones that matter are in `docs/decisions.md` as known gaps.
- Finished agent worktrees under `.claude/worktrees/` can be removed.

Next: step 4, the Home Depot page reader. Real page text for it is in
`fixtures/homedepot-pages/bullets-2026-11-10.json`. Two facts it depends on are not yet
proven from inside the extension: that a background request to homedepot.com carries the
browser's cookies, and how fast pages can be loaded without tripping Home Depot's bot check.

## Global Constraints

- Only the controller runs a paid command. No task in this step needs one. Implementers and reviewers never run `npm run scan` without `--fixtures`, `npm run fixtures:record`, `npm run test:live` or `npm run budget`, and never read or print `SERPAPI_API_KEY` or `.env`.
- The key lives in `chrome.storage.local` only, is readable by the service worker and extension pages only (`setAccessLevel` to trusted contexts), is sent only to `https://serpapi.com`, and is never logged, never put in a message to a content script, never written to IndexedDB.
- Manifest V3. Permissions exactly: `storage`, `alarms`, `sidePanel`, `notifications`. Host permissions exactly: `https://serpapi.com/*`, `https://www.homedepot.com/*`. The end-to-end test build may add `http://localhost/*`; the production build may not.
- Nothing calls serpapi.com except through `SerpApiClient`. No retries around a search.
- A scheduled scan never touches the reserve and never spends more than "searches per scan" across the whole job, including after it is continued. Scan now may spend from the reserve, down to zero.
- One scan at a time.
- `core/src/` has no `chrome.*` and no `node:*` imports. Anything that can be a pure function goes in `core/` with a test.
- Default tests use no network. `npm test` passes with the network off.
- UI follows `docs/design.md` and the mockup: values read from the mockup file, real elements, visible focus, 4.5:1 contrast. No UI kit, no Tailwind, no gradients, no emoji, no decorative icons, no card inside a card. Fonts are bundled locally.
- Vocabulary in the UI: bundle, part, listing, search, scan, estimate.
- Every profit figure is labelled an estimate.
- A change is done when `npm run typecheck` and `npm test` pass. Small commits, one concern each, staged by file name.

## Verified facts (read 2026-11-09 and 2026-11-10; re-check before relying on anything not listed)

| Fact | Source |
| --- | --- |
| WXT 0.21.5 needs Node 22 or later, `vite` and `typescript` 5.4+ as dev dependencies | wxt.dev/guide/resources/upgrading |
| Entrypoints: `entrypoints/background.ts` (`defineBackground`, main not async), `entrypoints/options/index.html`, `entrypoints/sidepanel/index.html`, `entrypoints/<name>.content.ts` (`defineContentScript({ matches })`) | wxt.dev/guide/essentials/entrypoints |
| Manifest fields go in `wxt.config.ts` `manifest`; the `sidePanel` permission is added automatically when a side panel entrypoint exists; version comes from package.json | wxt.dev/guide/essentials/config/manifest |
| Path aliases go in `wxt.config.ts` `alias`, not in tsconfig; `wxt prepare` writes `.wxt/tsconfig.json` | wxt.dev/guide/essentials/config/typescript |
| React: `modules: ['@wxt-dev/module-react']` | wxt.dev/guide/essentials/frontend-frameworks |
| Production build output: `.output/chrome-mv3` (already git-ignored, with `.wxt/`) | wxt.dev/guide/essentials/e2e-testing |
| Unit tests: `WxtVitest()` from `wxt/testing/vitest-plugin`; `fakeBrowser` from `wxt/testing/fake-browser` | wxt.dev/guide/essentials/unit-testing |
| `onMessage` listeners cannot return promises (no polyfill since WXT 0.20) | wxt.dev/guide/resources/upgrading |
| The service worker stops after 30 s idle; a fetch that takes over 30 s to respond can end it; globals are lost | developer.chrome.com, service worker lifecycle |
| IndexedDB is available in the service worker; `localStorage` is not | developer.chrome.com, storage and cookies |
| `chrome.storage.local` is exposed to content scripts by default; `setAccessLevel()` restricts it | developer.chrome.com, storage API |
| `sidePanel.open()` needs a user action | developer.chrome.com, sidePanel API |

Not documented, so not relied on in this step: whether an alarm survives a browser restart on this Chrome version (the heartbeat alarm is re-created on every worker start), whether WXT can run with its root in a subfolder (Task 2 decides by trying), and how Playwright intercepts a service worker's requests (the end-to-end build talks to a local replay server instead).

## Review Focus

1. The worker is killed between a search's response and the job save: the next tick continues the job and pays nothing for that step. Task 5, test "continues after the worker restarts".
2. Two triggers at once (a tick fires while Scan now is running): one scan runs. Task 5, test "one scan at a time".
3. The key is wrong, or SerpApi is unreachable, when a scheduled scan is due: no search is attempted, the state says why in one sentence, and the next tick tries again without spending. Task 5.
4. Settings typed as nonsense (searches per scan empty, negative, 9999; reserve above the plan; "every 0 hours"): the field shows what is wrong, nothing invalid is saved, and the schedule keeps its last valid value. Tasks 4 and 6.
5. Frequency changed while a scan is running: the running scan finishes on its own allowance; the new schedule applies from the next tick (acceptance criterion 7). Task 5.

## File structure

| File | Task | Responsibility |
| --- | --- | --- |
| `core/src/settings.ts` | 1 (types, controller), 4 (functions) | Settings shape, defaults, validation, budget policy per trigger, which deals to notify |
| `core/src/scan/types.ts`, `core/src/scan/runner.ts` | 1 (types), 3 | Stop on request; skip a failed lookup, stop after two failures in a row |
| `wxt.config.ts`, `extension/**`, `vitest.ext.config.ts` | 2 | Scaffold: builds, typechecks, one passing test |
| `extension/lib/db.ts`, `extension/lib/idbStore.ts`, `extension/lib/idbCache.ts`, `extension/lib/prefs.ts` | 5a | IndexedDB behind `ScanStore` and `Cache`; ledger; settings and key in `chrome.storage.local` |
| `extension/lib/messages.ts` | 1 (controller) | Request, response and state types |
| `extension/lib/worker.ts`, `extension/entrypoints/background.ts` | 5 | The service worker's logic, written to be tested without Chrome |
| `extension/styles/tokens.css`, `public/fonts/*`, `extension/entrypoints/options/*` | 6 | Tokens, fonts, the settings page |
| `e2e/**`, `playwright.config.ts` | 7 | End-to-end tests on the built extension |

---

### Task 1: Contracts (controller)

Written before any dispatch, committed on their own:

- `core/src/settings.ts` (types and defaults only):

  ```ts
  export interface AlertSettings { enabled: boolean; minProfit: number; minRoiPercent: number }
  export interface ExtensionSettings {
    schedule: Schedule;
    searchesPerScan: number;      // 1 to 250
    reserve: number;              // 0 to 250
    brands: string[];             // upper case; a subset of KNOWN_BRANDS, at least one
    pagesPerBrand: number;        // 1 to 5
    fees: FeeSettings;
    alerts: AlertSettings;
  }
  export const KNOWN_BRANDS = ['DEWALT', 'RYOBI'] as const;
  export const DEFAULT_SETTINGS: ExtensionSettings;   // manual schedule, 5 per scan, reserve 100, both brands, 1 page, DEFAULT_FEES, alerts off at $20 and 20%
  export type ScanTrigger = 'scheduled' | 'manual';
  ```

- `core/src/scan/types.ts`: `StopReason` gains `'user'`; `ScanDeps` (in `runner.ts`) gains `shouldStop?: () => boolean`.
- `extension/lib/messages.ts`:

  ```ts
  export type Request =
    | { type: 'getState' }
    | { type: 'checkKey'; apiKey: string }          // checks with the Account API; saves the key only when it works
    | { type: 'forgetKey' }
    | { type: 'saveSettings'; settings: ExtensionSettings }
    | { type: 'scanNow' }
    | { type: 'stopScan' }
    | { type: 'exportDeals' }                        // data: the run CSV text
    | { type: 'exportMatches' }                      // data: JSON text of matches and answered review items
    | { type: 'clearSavedSearches' };                // empties the response cache only
  export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
  export interface AppState {
    hasKey: boolean;
    account: AccountInfo | null;
    accountCheckedAt: number | null;
    /** One plain sentence when the last account check or scan start failed. */
    problem: string | null;
    settings: ExtensionSettings;
    scanRunning: boolean;
    lastJob: ScanJob | null;
    nextRunAt: number | null;
  }
  /** Sent to every extension page when AppState changes. */
  export interface StateChanged { type: 'stateChanged'; state: AppState }
  ```

- IndexedDB schema, in `extension/lib/db.ts` comments and code (Task 5a): database `split-finder`, version 1. Stores and key paths: `bundles` (`key`), `catalog` (`key`), `matches` (`key`), `prices` (`asin`), `listings` (`asin`), `cursors` (`brand`), `review` (`id`), `scans` (`id`), `cache` (`key`; value `{ key, at, data }`), `ledger` (auto-increment; value `LedgerEntry`).
- `chrome.storage.local` keys: `apiKey` (string), `settings` (`ExtensionSettings`), `activeScan` (`{ jobId: string; trigger: ScanTrigger } | null`), `lastScheduledRunAt` (number | null), `notified` (string[] of bundle keys), `account` (`{ info: AccountInfo; at: number } | null`).

### Task 2: Scaffold

**Model:** `sonnet` implementer, `sonnet` reviewer. (Not `haiku`: whether WXT runs from a subfolder is undocumented, so the brief cannot be complete.)

**Files:** Create `wxt.config.ts`, `extension/entrypoints/background.ts`, `extension/entrypoints/options/index.html` and `main.tsx`, `extension/entrypoints/sidepanel/index.html` and `main.tsx` (a one-line placeholder for step 5), `extension/tsconfig.json`, `vitest.ext.config.ts`, `extension/lib/smoke.test.ts`. Modify `package.json`, `.gitignore` if needed, `CLAUDE.md` (layout line for `extension/` only).

**Decisions:**
- One npm package. WXT at the repo root with `srcDir: 'extension'`, `alias: { '@core': resolve('core/src') }`, `modules: ['@wxt-dev/module-react']`, and the manifest from Global Constraints: name `Split Finder`, the four permissions, the two host permissions. If WXT cannot work this way, stop and report NEEDS_CONTEXT with what failed; do not switch to a second package on your own.
- Scripts: `ext:dev` (`wxt`), `ext:build` (`wxt build`), `postinstall` (`wxt prepare`), `typecheck` runs the existing check and then `tsc --noEmit -p extension`, `test` runs the existing suite and then `vitest run --config vitest.ext.config.ts`.
- `extension/tsconfig.json` extends `../.wxt/tsconfig.json` and keeps `strict` and `noUncheckedIndexedAccess`.
- Dependencies, latest stable of each: `wxt`, `@wxt-dev/module-react`, `vite`, `react`, `react-dom`, `@types/react`, `@types/react-dom`, `idb`, `fake-indexeddb`, `@types/chrome` only if WXT's own types do not cover `chrome.*`.

- [ ] **Step 1:** `extension/lib/smoke.test.ts`: imports `partKey` from `@core/scan/types` and `fakeBrowser` from `wxt/testing/fake-browser`; asserts `partKey('ryobi', 'pblrc25b')` is `'RYOBI:PBLRC25B'` and that `fakeBrowser.storage.local.set({ a: 1 })` then `get('a')` returns `{ a: 1 }`. See it fail (nothing is installed).
- [ ] **Step 2:** Install, write the config and entrypoints. The background entrypoint logs nothing and registers nothing yet.
- [ ] **Step 3:** `npm run typecheck`, `npm test` (the 215 core tests and the smoke test), `npm run ext:build`.
- [ ] **Step 4:** Verify the built manifest: `jq '{manifest_version, permissions, host_permissions, name}' .output/chrome-mv3/manifest.json` shows version 3, exactly the four permissions (any order) and exactly the two host permissions. `git status --short` lists nothing under `.output/` or `.wxt/`.
- [ ] **Step 5:** Commit: `chore: WXT scaffold for the extension (builds, typechecks, one test)`.

### Task 3: Runner: stop on request, and one failed lookup does not end a scan

**Model:** `opus` implementer, `opus` reviewer.

**Files:** Modify `core/src/scan/runner.ts`, `core/test/scan-runner.test.ts`.

Rules, replacing the "planned last" exception of step 2 and extending rule 8:

1. Before each paid step, if `deps.shouldStop?.()` is true: `stopReason: 'user'`, the rest of the queue is deferred, lookups among them are marked `waiting`, no search is sent, and the job finishes as `stopped`.
2. A lookup or refresh that fails with `error` (any error thrown by the search other than a budget refusal or a 429) is deferred, its part is marked `waiting`, and the scan goes on to the next step. Two such failures in a row stop the scan with `stopReason: 'error'` and the second failure's message. A successful step resets the count. The job's `stopMessage` records the first failure's message when the scan otherwise completes, and its status is `stopped` because `deferred` is not empty.
3. A listing page that fails still stops the scan at once (there is nothing to look up without it). A budget refusal and a 429 still stop at once.
4. The "planned last" reordering is removed: with rule 2 a failing part no longer blocks the others. Its tests (M, M2) are rewritten to the new behaviour, not deleted.

- [ ] **Step 1: Tests.** (a) `shouldStop` returning true after the listing page: `searchesUsed: 1`, `stopReason: 'user'`, both parts `waiting`, no Amazon request sent. (b) The HTTP 500 for `RYOBI PBLRC01B` only: one scan ends with PBLRC25B `matched`, PBLRC01B `waiting`, `status: 'stopped'`, `stopReason: null`, `stopMessage` matching `/HTTP 500/`, exactly one request for each part. (c) HTTP 500 for every Amazon request: two requests are sent, then `stopReason: 'error'`. (d) Test E2 (a body that is not JSON) now expects two Amazon requests and `stopReason: 'error'`. (e) Test H's 429 case is unchanged: one request, `rate_limited`.
- [ ] **Step 2:** See them fail. **Step 3:** Implement. **Step 4:** `npm run typecheck`, `npm test`.
- [ ] **Step 5:** Commit: `feat: a scan can be stopped, and one failed lookup no longer ends it`.

### Task 4: Settings logic in core

**Model:** `opus` implementer, `opus` reviewer (budget behaviour).

**Files:** Modify `core/src/settings.ts`, `core/src/index.ts`. Test: `core/test/settings.test.ts`.

**Produces:**

```ts
/** A message per invalid field, keyed by field name; empty when everything is valid. */
export function validateSettings(s: ExtensionSettings): Partial<Record<'schedule' | 'searchesPerScan' | 'reserve' | 'brands' | 'pagesPerBrand' | 'fees' | 'alerts', string>>;
export function toScanSettings(s: ExtensionSettings): ScanSettings;
/** The budget policy for a scan. `usedSoFar` is the job's searchesUsed when it is being continued. */
export function budgetPolicyFor(s: ExtensionSettings, trigger: ScanTrigger, usedSoFar: number): BudgetPolicy;
/** Confirmed bundles that clear both alert numbers and were not notified before. */
export function dealsToNotify(report: ScanReport, alerts: AlertSettings, alreadyNotified: string[]): BundleRow[];
```

Rules:
- `toScanSettings`: brands as given; one query per brand from `{ DEWALT: 'dewalt 20v combo kit', RYOBI: 'ryobi 18v combo kit' }` in `KNOWN_BRANDS` order; `pagesPerQuery` from `pagesPerBrand`; fees from the settings; everything else from `DEFAULT_SCAN_SETTINGS`.
- `budgetPolicyFor`: scheduled is `{ reserve: s.reserve, maxPerRun: max(0, s.searchesPerScan - usedSoFar) }`; manual is `{ reserve: 0, maxPerRun: max(0, s.searchesPerScan - usedSoFar) }`.
- `validateSettings` messages are plain sentences, for example `Use a whole number from 1 to 250.` It reuses `validateSchedule`. Fees: referral rate 0 to 1, the three amounts 0 or more. A reserve above the plan is valid here (the forecast block reports it).
- `dealsToNotify`: only rows with `section: 'confirmed'`, `estimate.profit >= minProfit`, `estimate.roi * 100 >= minRoiPercent`, key not in `alreadyNotified`; empty when alerts are off.

- [ ] **Step 1: Tests**, including: scheduled with `searchesPerScan: 5`, `reserve: 100`, `usedSoFar: 3` gives `{ reserve: 100, maxPerRun: 2 }`; manual gives `{ reserve: 0, maxPerRun: 2 }`; `usedSoFar: 9` gives `maxPerRun: 0`. With the free account sample and 101 searches left, a `SearchBudget` built from the scheduled policy has `spendable` 1 and from the manual policy 5. Every line of Review Focus 4 as a `validateSettings` case. `dealsToNotify` on the founder report from step 2 with `minProfit: 50, minRoiPercent: 30` returns PBLRC2501SB only, and nothing when its key is already notified.
- [ ] **Step 2:** See them fail. **Step 3:** Implement. **Step 4:** `npm run typecheck`, `npm test`.
- [ ] **Step 5:** Commit: `feat: settings validation, scan settings and budget policy per trigger`.

### Task 5a: Storage

**Model:** `sonnet` implementer, `sonnet` reviewer.

**Files:** Create `extension/lib/db.ts`, `extension/lib/idbStore.ts`, `extension/lib/idbCache.ts`, `extension/lib/prefs.ts`, and their tests beside them. Move the store conformance cases out of `core/test/scan-store.test.ts` into `core/test/storeConformance.ts` as `export function storeConformance(name: string, make: () => Promise<ScanStore>): void`, called from both test files.

**Produces:** `openDb(): Promise<IDBPDatabase>`; `class IdbScanStore implements ScanStore`; `class IdbCache implements Cache`; `appendLedger(entry)`, `readLedger()`; in `prefs.ts`: `getKey`, `setKey`, `forgetKey`, `getSettings` (defaults merged over what is stored, invalid stored values replaced by defaults), `saveSettings`, `get`/`set` for the other keys in Task 1, and `restrictKeyAccess()` which calls `storage.local.setAccessLevel` so content scripts cannot read `chrome.storage.local`.

- [ ] **Step 1: Tests.** `storeConformance('IdbScanStore', ...)` over `fake-indexeddb` passes every case the memory store passes. `IdbCache` round-trips an entry and returns `undefined` for a missing key. `prefs` over `fakeBrowser`: a key round-trips; `getSettings()` with nothing stored equals `DEFAULT_SETTINGS`; a stored `searchesPerScan: -3` comes back as the default; `forgetKey` removes only the key.
- [ ] **Step 2:** See them fail. **Step 3:** Implement. **Step 4:** `npm run typecheck`, `npm test`.
- [ ] **Step 5:** Commit: `feat: IndexedDB scan store and cache, settings and key storage`.

### Task 5: The service worker

**Model:** `opus` implementer, `opus` reviewer (state, timing, budget).

**Files:** Create `extension/lib/worker.ts`, `extension/lib/worker.test.ts`. Modify `extension/entrypoints/background.ts` (wiring only).

**Shape:** `createWorker(env)` returns `{ onMessage(request): Promise<Reply>, onTick(): Promise<void>, onStart(): Promise<void> }`. `env` carries everything Chrome-specific so tests need no browser: `{ store, cache, prefs, fetchFn, now, notify(rows), broadcast(state), baseUrl }`. `background.ts` builds the real `env`, registers the listeners synchronously at the top level of `main`, creates the alarm `tick` with `periodInMinutes: 1` if it does not exist, and answers messages with `sendResponse` and `return true` (listeners cannot return promises).

**Behaviour:**

1. `onStart` and every `onTick`: call `restrictKeyAccess()`; if `activeScan` names a job whose status is `running` and no scan is active in this worker, continue it with the trigger saved in `activeScan`; otherwise, if `nextRun(settings.schedule, now, lastScheduledRunAt)` is not null and not in the future, start a scheduled scan.
2. Starting or continuing a scan: no key means no scan and `problem: 'Add your SerpApi key in Settings.'`. Call the Account API (free); on failure set `problem` to the error's sentence and stop without spending. Build `SearchBudget(account, budgetPolicyFor(settings, trigger, job?.searchesUsed ?? 0))` and a `SerpApiClient` with the IndexedDB cache and `onSpend: appendLedger`. Save `activeScan` before the first search. Run `runScan` with `shouldStop` reading a flag set by `stopScan`. Afterwards: clear `activeScan`, set `lastScheduledRunAt` for a scheduled scan, refresh the saved account, build the report, call `notify(dealsToNotify(...))` and remember the notified keys, broadcast the state.
3. One scan at a time: `scanNow` while a scan is active replies `{ ok: false, error: 'A scan is already running.' }`; a tick while a scan is active does nothing.
4. `checkKey`: Account API with the given key; on success save the key and the account and reply with the account; on failure reply with the error's sentence and leave any saved key untouched.
5. `saveSettings`: reject with the first validation message when `validateSettings` finds anything; otherwise save and broadcast. A running scan is not affected. Saving never starts a scan: when the saved schedule differs from the stored one, `lastScheduledRunAt` is set to now, so the first scheduled scan comes one interval later (or at the next daily time), not on the next tick. Settings read back from storage are validated too; any field that fails falls back to its default before use.
6. `clearSavedSearches` empties the `cache` store only. `exportDeals` replies with `runCsv(report)`; `exportMatches` with JSON of all match records and answered review items.
7. `nextRunAt` in `AppState` comes from `nextRun`.

- [ ] **Step 1: Tests**, with `MemoryScanStore`, `MemoryCache`, an in-memory prefs fake and `replayRecorded()` plus a fake Account API answering `fx.SERPAPI_ACCOUNT_FREE`:
  - no key: `scanNow` replies not ok, no request leaves, `problem` is set (acceptance criterion 1);
  - `checkKey` with a 401 replies `SerpApi did not accept this key.` and saves nothing; with a 200 saves the key and replies with the plan (criterion 2);
  - a scheduled scan with `searchesPerScan: 2` on the ratchet query stops with `run_cap` after 2 searches; with 101 searches left and reserve 100 it spends 1; `scanNow` in the same position spends up to 5 (criterion 3 and the reserve rule);
  - "continues after the worker restarts": make the store's `putScan` throw once after the first lookup, then build a second worker over the same store, cache and prefs and call `onStart`: the job finishes, no request is repeated, and the two runs together respect `searchesPerScan` (criterion 8);
  - "one scan at a time": `scanNow` and `onTick` started together run one job;
  - the Account API unreachable when a scan is due: no search, `problem` set, the next tick tries again;
  - changing the schedule from manual to every 6 hours starts no scan on the next tick, sets `nextRunAt` six hours after the change, and a tick six hours later starts one, with no reload in between (criterion 7); saving the same schedule again does not move `nextRunAt`; a change while a scan runs does not stop it; stored settings with `fees: null` are read as the default fees;
  - `stopScan` during a scan gives `stopReason: 'user'`;
  - alerts on at $50 and 30%: `notify` is called once with PBLRC2501SB, and not again after a second scan.
- [ ] **Step 2:** See them fail. **Step 3:** Implement. **Step 4:** `npm run typecheck`, `npm test`, `npm run ext:build`.
- [ ] **Step 5:** Commit: `feat: service worker: scheduled and resumable scans within the budget`.

### Task 6: Settings page

**Model:** `sonnet` implementer, `sonnet` reviewer, then `ui-reviewer` (`opus`) on screenshots.

**Files:** Create `extension/styles/tokens.css`, `public/fonts/` (Barlow 400/500/600 and JetBrains Mono 400/500/600 woff2 with their license files), `extension/entrypoints/options/` (page, sections, a small `useAppState` hook over `messages.ts`), component tests beside them.

Build `docs/design/mockups/Settings.dc.html` exactly: read sizes, spacing and colors from the file. Sections: SerpApi key, Scanning, What to scan, Fees, Alerts, Your data. Requirements beyond the mockup:
- Changes save on change, through `saveSettings`; an invalid field shows its message under the field and is not saved.
- **Check key** shows, on success, `Key works. <plan> · <left> of <per month> searches left this month · <hourly> an hour`; on failure the worker's sentence.
- The forecast block is computed with `forecastUsage(schedule, searchesPerScan, account?.searchesPerMonth ?? 250, reserve)` on every change, before saving. When it does not fit it uses the attention colors and says: `This needs <n> searches a month and your plan has <usable> to spend. Use <maxPerRunThatFits> per scan, or scan less often.`
- "Clear saved searches" asks once before acting. The two export buttons download a file.
- States to build and screenshot: no key; key checking; key works; key refused; schedule fits; schedule does not fit; an invalid field; narrow window (stacked).

- [ ] **Step 1:** Component tests for each state with a fake worker. **Step 2:** See them fail. **Step 3:** Build. **Step 4:** `npm run typecheck`, `npm test`, `npm run ext:build`.
- [ ] **Step 5:** Commit: `feat: settings page with key check, schedule and live forecast`.
- [ ] **Step 6 (controller):** Load the built extension in a browser, capture every state at 1280px and at 600px wide, and give the screenshots, the mockup and the changed files to `ui-reviewer`. `CHANGES NEEDED` goes back to an implementer.

### Task 7: End-to-end tests

**Model:** `sonnet` implementer, `sonnet` reviewer. A read-only documentation check of how Playwright loads an unpacked MV3 extension comes first.

**Files:** Create `playwright.config.ts`, `e2e/replay-server.ts`, `e2e/settings.spec.ts`, `e2e/scan.spec.ts`. Modify `wxt.config.ts` (the end-to-end mode only), `package.json` (`test:e2e`).

- A build made with `SPLIT_FINDER_E2E=1` adds `http://localhost/*` to host permissions and takes the SerpApi base URL from a build-time value; the normal build has neither. A unit test asserts the production manifest has exactly the two host permissions.
- `e2e/replay-server.ts` serves `replayRecorded()` over HTTP on localhost, plus `/account.json` from the free-plan sample, and counts requests.
- Specs: first run with no key shows the first-run text on the settings page and sends no request; a refused key shows the sentence; a working key shows the plan line; choosing "Every 6 hours" with 5 per scan shows "This fits your plan" and survives a page reload; a scan started from the worker (through a message from the page) on the ratchet query ends with 3 search requests on the server and a second scan inside the hour sends none.
- `npm run test:e2e` builds in end-to-end mode and runs Playwright. It is not part of `npm test`. Installing Playwright's Chromium is a one-time download the controller announces first.

- [ ] Steps as in the other tasks; commit: `test: end-to-end tests on the built extension with replayed searches`.

### Task 8: Step gate (controller)

- [ ] `npm run typecheck`, `npm test`, `npm run ext:build`, `npm run test:e2e`, run and read by the controller.
- [ ] Review the whole step's diff on `fable`.
- [ ] `npm run budget`. Report: what was built, the test count, which model did which task and what was escalated, searches spent (expected: 0), what is uncertain. Stop until the user says go.
