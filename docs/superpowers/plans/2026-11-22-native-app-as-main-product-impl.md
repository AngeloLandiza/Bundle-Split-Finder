> Superseded by step 13: see [the step 13 plan](2026-11-22-step-13-agent-workplace.md). Kept for history.

# Lane D implementation — app-first UI + thin browser helper

**Decision (Alex, Nov 22):** Lane **D** from `2026-11-22-native-app-as-main-product.md`. The native app is the product; Chrome carries a **thin helper** (chip, HD read, bridge) until P4.

**North star:** Seller opens **Split Finder.app**; `docs/design.md` + mockups govern every surface; no debug JSON as default UI.

---

## Architecture invariants (every phase)

| Invariant | Enforcement |
| --- | --- |
| `core/` has no `chrome.*` / `node:*` | Existing CI + review |
| HD Includes only via browser helper | No SerpApi-only split for kits; tests on fixture pages |
| Search budget unchanged | `SerpApiClient` + `KeepaClient` only |
| Estimates labelled | Copy from `design.md` in app UI |
| App data becomes SoT by P4 | Extension reads/writes through localhost bridge |

---

## P0 — Install and agent bootstrap

**Status:** Done (Nov 22).

| Task | Evidence |
| --- | --- |
| Valid MV3 manifest (no invalid `permissions` string) | `wxt.config.ts`, `wxt-config.test.ts` |
| Embedded agent sidecar on app launch | `src-tauri/`, `desktop/bundle-agent.ts` |
| Extension zip in app resources | `tauri.conf.json` `resources` + `externalBin` |
| One-command unpack script | `desktop/unpack-extension.sh`, `agent/setup.ts` |

**Acceptance:** Fresh Mac user can open app → dashboard on :8790 without npm; manifest validates in Chrome when loaded from `~/Documents/split-finder`.

---

## P1 — App home = setup wizard + status (design.md)

**Status:** In progress → **done in code** (Nov 22).

| Task | Owner | Tests |
| --- | --- | --- |
| `GET /api/setup/status` | `agent/setup.ts`, `server.ts` | `agent/test/setup.test.ts` |
| `POST /api/setup/install-extension` | unpack zip → `SPLIT_FINDER_EXTENSION_DIR` | same + manual Chrome load |
| Dashboard UI: Browser helper band, Install button, path, Chrome link | `agent/dashboardPage.ts` | ui-reviewer before PM |
| Pass `SPLIT_FINDER_EXTENSION_ZIP` from Tauri resources | `src-tauri/src/lib.rs` | `cargo check`, packaged app smoke |

**UX checklist (FirstRun.dc.html parity):**

- [x] Paper/surface tokens, ink primary button
- [x] Loading state on setup line
- [x] Single recovery sentence on failure
- [x] ui-reviewer pass vs mockup (Nov 22, source review — token/FirstRun/header gaps logged)

**Not in P1:** Deals/Review in app (P3), key entry in app (P2).

---

## P2 — Settings and keys in app

**Status:** Done in code (Nov 22) — `/ui/` Settings + FirstRun + header Scan now; SerpApi **Check key** + eBay **Check keys** (`POST /api/settings/check-ebay`); keys in `app-secrets.json` (mode 600) + non-secret `app-settings.json`; sync via `appSyncKeys`. **Not done:** macOS Keychain API, full `Settings.dc.html` parity.

| Task | Notes |
| --- | --- |
| `desktop-ui/` Vite entry sharing React from `extension/entrypoints/options` | WXT alias `@core`; build into `desktop/dist/ui/` |
| Tauri window loads `app://` or local static for Settings | Keys in app secure storage (keychain stub → file in app data) |
| `POST /api/settings` + extension `runtime.sendMessage` or poll for sync | Helper still holds keys until P4 cutover |
| SerpApi check key in app | Reuse core budget parser; no new network path |
| Mockup | `Settings.dc.html` |

**Tests:** `core/test/settings.test.ts` patterns; extension worker test for synced settings shape.

**Acceptance:** Alex can paste SerpApi key in **app**; extension scan works without opening Chrome options.

---

## P3 — Deals in app (read-only)

**Status:** Done in code (Nov 22) except visual polish — panel sync; sectioned Deals list with **Look up** (`/api/paid/queue` → `appSyncPaid`); sort menu; CSV + stale + limit/ebay notices; Detail export; `matchState` + review tags; footer meters. **Not done:** live worker quote on Look up (upper bound shown), full Main/Detail mockup pass.

| Task | Notes |
| --- | --- |
| SQLite or JSON store in app data; bridge POST replaces export-only | Schema mirrors IndexedDB export |
| Port Deals list component | `Main.dc.html` row layout, sort, sections |
| Extension remains write path for scans | Dual UI OK |
| Keepa meters in app footer | From scan summary + settings |

**Tests:** Fixture bridge POST → app store → Deals API returns rows; vitest on store adapter.

**Acceptance:** After scan in Chrome, Deals visible in app without opening side panel.

---

## P4 — Scan + Review in app; thin helper

**Status:** Done in code (Nov 22) except mockup polish — helper + sync; app **Home** Scan now; **Review** queues split/match/**eBay** answers (`openEbayQuestions` from bridge); `appSyncKeys` fingerprint avoids re-checking eBay every poll. **E2E green:** `e2e/app-scan-queue.spec.ts`, `e2e/helper-app-primary.spec.ts`. App **Review**: Ask AI / Ask all / Approve all verified via `/api/review/ask/queue` + `appSyncAsk`; verified suggestions + **Approve AI suggestion**; **Settings › Ask AI after each scan** syncs to helper. Full Review mockup parity still open. Options redirect when packaged or `appPrimaryUi`.

| Task | Notes |
| --- | --- |
| Rename/rebadge extension manifest → **Split Finder Helper** | Smaller permissions surface over time |
| Move Scan now to app; worker RPC over `localhost` | New message types in `extension/lib/messages.ts` |
| HD read: app requests page ids → helper `readPages` → POST results | Existing `hdReader.ts` |
| Chip opens app window (Tauri deep link / focus) | Fallback side panel |
| Review + Detail ports | Mockups Detail.dc, Review flow |
| Remove duplicate options UI from helper | Options only in app |

**Tests:** `e2e/app-scan-queue.spec.ts` (spawns agent, `runAppSync`, scan ack); `e2e/helper-app-primary.spec.ts`; agent HTTP contract tests.

**Acceptance:** Alex can complete scan + Review without side panel; helper only on HD + background.

---

## P5 — Deprecate side panel primary

**Status:** Done in code (Nov 22) except store/marketing — helper header **Open app** when `appPrimaryUi`; toolbar panel off unless `compactHelperPanel`; **Split Finder Helper** manifest name (`SPLIT_FINDER_HELPER=1` builds); chip opens app when primary; app **FirstRun** install flow. **Not done:** CWS listing (PM scope), README/install still document extension-only fallback.

| Task | Notes |
| --- | --- |
| Optional compact Chrome panel for power users | Feature flag |
| Chrome Web Store listing for helper (optional) | Out of repo scope until PM |
| Publish DMG/exe with bundled helper + wizard | No manual unzip |

---

## Browser helper contract (P1→P4)

```
App  GET  /api/setup/status
App  POST /api/setup/install-extension
App  GET  /api/status | /api/bridge | /api/state
Ext  POST /api/state          (helper meters, no keys)
Ext  POST /api/bridge          (after scan, settings flag)
Ext  POST /api/panel           (panel report with estimates)
Ext  POST /api/hd-read         (P4: batch page payloads)
App  POST /api/scan/start      (P4)
App  POST /api/paid/queue      (P4: Look up / Verify)
App  POST /api/review/ask/queue (P4: Ask AI)
```

Version field in bridge JSON for compatibility gates.

---

## Packaging

| Artifact | Command |
| --- | --- |
| macOS app + zip | `npm run desktop:build` |
| Windows installer | `npm run desktop:build` on Windows |
| Rebuild sidecar after agent HTML change | `npm run desktop:bundle-agent` |

Ship **same version** on app + bundled zip (manifest `version` + app `tauri.conf.json`).

---

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| User loads wrong Chrome folder | App install API + manifest validator rejects stale `permissions` |
| Dual UI drift (P3) | Single export schema; contract tests |
| localhost bridge blocked | Loopback only; document firewall |
| Lane D too much React port work | Incremental: P1 static HTML → P2 shared React |

---

## Verification before “app is main product” (marketing)

Only after **P4 acceptance**: rename marketing, default docs to app-first install, helper as step 2.

`docs/install.md` §0 + README app-first section added (Nov 22). Full marketing cutover (DMG-only path, CWS helper listing) still open; P4 scan + review + Ask AI from app is in code.

## Engineering verification (Nov 22)

| Gate | Command | Status |
| --- | --- | --- |
| Unit + agent | `npm test` | green |
| Typecheck | `npm run typecheck` | green |
| Lane D E2E | `SPLIT_FINDER_E2E=1 npx playwright test e2e/app-scan-queue.spec.ts e2e/helper-app-primary.spec.ts e2e/app-ask-queue.spec.ts` | green |
| Secrets split | `agent/test/secretsStore.test.ts` | keys not in `app-settings.json` |

## Engineering acceptance — P2–P5 (Nov 22)

Functional acceptance from the phase tables above; **not** full mockup pixel parity or marketing-only work.

| Criterion | Evidence |
| --- | --- |
| P2: keys + settings in app; helper sync; SerpApi + eBay check | `SettingsView`, `appSyncKeys`, `check-serp` / `check-ebay`, `secretsStore` |
| P2 acceptance: scan without Chrome options | `appPrimaryUi` + options redirect (`options/main.tsx`) |
| P3 acceptance: Deals after scan in app | `dealsStore`, `GET /api/deals`, `DealsView` |
| P4 acceptance: scan + review + Ask AI without panel | scan/review/ask/paid queues + `appSyncRun`, E2E scan |
| P5: helper primary UX | Helper name, Open app, chip → app, compact panel flag |
| Invariants | `core/` clean; bridge only via agent; estimates labelled in Detail |

### Post-Lane-D backlog (not blocking engineering acceptance)

| Item | Owner |
| --- | --- |
| macOS Keychain for `app-secrets.json` | v2 security |
| ui-reviewer pass: Settings, Main, Detail, Review vs `.dc.html` | design polish |
| Live worker `quote` on app Look up (now upper-bound label) | P3 polish |
| CWS helper listing; DMG-only install copy | PM / marketing |