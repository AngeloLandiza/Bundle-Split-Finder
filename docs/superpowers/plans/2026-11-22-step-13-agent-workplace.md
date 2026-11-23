# Step 13: the desktop agent becomes the work place

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Testing scope (owner, Nov 20 and Nov 22): typecheck + unit tests only; no e2e, no screenshot rounds unless a design task needs one look; "more development, efficient usage".

**Owner (Nov 22):** improve drastically what was built in Cursor; "the native agent app will be the main work place (doesn't do that)"; "the app is really shitty design … use principal UI/UX practices"; "PO wants a fully automated system so make use of AI pipelines (expect cheaper non-Anthropic models later like DeepSeek) to automate as much as possible … what can be fully automated with VERY high accuracy"; "a fully automated (as much as possible) background agent that finds you stuff and then messages you when there's something in review or with a high ROI"; "if something else would be better … just do it, make sure the PO gets what he wants". PO brief (memory): Home Depot Includes lists, multi-part Amazon listings, no leftovers.

**Found (two read-only investigations, Nov 22):** the Node agent is a file mailbox — the extension still does every scan, Keepa call, AI call and notification on a 1-minute poll; the production extension likely cannot reach 127.0.0.1 at all (host permission only in the e2e build); `GET /api/settings` serves every key in plain text with no auth; no tray, no native notifications, quitting kills the agent; the UI is the 480px side panel inside a desktop window, the Deals row is broken, Detail shows "Parts sell for" = "After fees"; Windows packaging does not work. typecheck and 2,600 unit tests pass.

## Decisions (go in docs/decisions.md)
1. **The agent is the brain and the source of truth.** It owns schedule, store, keys, every paid call (SerpApi through `SerpApiClient` with the budget ledger and reserve, Keepa through `KeepaClient` with its token budget, AI through the provider-neutral adapters), the alert engine and notifications. The extension is a **paired worker**: Home Depot page/kit/part-price reads in the owner's Chrome (doorway tab), the chip, and on-page review that reads and writes through the agent. Unpaired, the extension keeps working alone as today.
2. **Security:** keys never leave the agent (no endpoint returns a key; the UI sees `hasKey` only). Every request needs the pairing token; Host must be 127.0.0.1:8790 and Origin must be the app's own or the paired extension's; body-size limit; no CORS for anything else. Pairing: the owner clicks "Connect to the app" in the extension (user gesture → host permission request), the app shows "Allow Chrome to connect?" → token. Keys at rest: file chmod 600 now, OS keychain later (decision logged).
3. **Store:** one store module in the agent, single writer (the agent process), atomic writes (temp + rename), typed collections; the four file queues and two snapshot stores collapse into it. One typed API contract in `core/src/api/` shared by agent, desktop UI and extension.
4. **Worker jobs:** the agent queues Home Depot read jobs; the extension long-polls `/api/worker/next` while Chrome is open (woken by a 1-minute alarm), posts results; jobs wait while Chrome is closed and the app says "Chrome is closed — Home Depot pages wait".
5. **Automation (the PO's "fully automated"):** after each scheduled scan the agent runs, without the owner: Amazon matching and lookups within budget; eBay judging; AI research/assist on every open Review question. **Autopilot** (on by default, a Settings switch): a suggestion that passes code verification is applied automatically, recorded in Activity with **Undo**, and named in the digest; anything unverified, "cannot tell" or "none fits" stays in Review for the owner. Rule 4 holds: verification is evidence-checked by code, never a model's word; the owner can turn Autopilot off. eBay stays a reference.
6. **Messages:** native notifications from the desktop shell (scan finished with N new deals above the ROI threshold; N questions need you; Autopilot applied N answers) and an optional Telegram bot (owner's bot token + chat id) carrying the same digest — no keys in messages.
7. **AI providers:** one adapter interface; Claude (existing) and an OpenAI-compatible adapter (DeepSeek and others: base URL + model + key). Research without Anthropic server tools uses the Home Depot tools only. Model per pipeline in Settings.
8. **Desktop UI** rebuilt on the design system as a desktop work place: left rail (Today, Deals, Review, Activity, Settings), Today as landing ("Needs your answer", "Best deals", "The agent"), Deals as a real sortable table with a right detail pane, Review as master–detail with evidence and source links, Activity (runs, spend, Autopilot log with Undo), Settings in spec two-part rows saving on change. Shared components, no inline styles.
9. **Shell:** tray icon with open-question badge, close to tray (agent keeps running), launch at login (switch), min size 1000×680 remembered, menu shortcuts (Scan Cmd+R, Settings Cmd+,), native notifications. Windows packaging is out of this step (logged).

## Waves
**Wave 1 (parallel, disjoint files)**
- **W1 Agent foundation (Opus):** `core/src/api/` contract; agent router, auth + pairing, Host/Origin checks, body limit; unified store; worker-job queue + long-poll; server-sent events for live UI updates; keys never served; delete `dashboardPage.ts` and the duplicate queue modules (migrate their data once).
- **W2 Desktop UI rebuild (Opus design + build):** design.md "Desktop app" section; component library; all screens on a typed mock client generated from the W1 contract outline (below); wired to the real client in Wave 2.
- **W3 Shell (Sonnet):** tray, close-to-tray, launch at login, min/remembered size, menu shortcuts, native notification bridge (agent emits events; shell shows them), remove the hard-coded repo path.

**Wave 2**
- **W4 Agent runs the work (Opus):** scheduler; scans in the agent (`runScan` with remote Home Depot readers via worker jobs); Keepa tracking loop; alert engine; AI pipelines + Autopilot with Undo; Telegram.
- **W5 Extension as worker (Sonnet):** pairing UX, production host permission, long-poll loop, no key pulling, on-page review through the agent, standalone fallback.
- **W6 Provider-neutral AI (Sonnet):** OpenAI-compatible adapter for judge/assist/research; Settings per pipeline.
- **W7 Wire UI (Sonnet):** real client + SSE, states (offline, Chrome closed, limit, error) everywhere.

**Wave 3:** security + automation review (Opus, one pass), cleanup (Haiku), docs (honest status), CLAUDE.md updated for the new architecture.

## API contract outline (W1 implements; W2 mocks)
`GET /api/state` → {agent: {status, step?, progress?, nextScanAt, lastScan}, helper: {paired, connected, lastSeenAt}, budget: {serpLeft, serpReserve, keepaTokens, aiSpentUsd, aiCapUsd}, counts: {review, autopilotApplied, newDeals}, keys: {serpapi, keepa, anthropic, openai, ebay, telegram: boolean}}
`GET /api/deals?sort&section` → rows (bundle, price, off, matchState, profit, roi, roiRange, needsAnswer, updatedAt) · `GET /api/deals/:id` → detail (parts with prices by source + links, ways to sell, estimate basis)
`GET /api/review` → questions with evidence, sources, AI suggestion · `POST /api/review/:id/answer` · `POST /api/review/ask-all` · `POST /api/review/approve` {ids}
`GET /api/activity` → runs, spend, Autopilot log · `POST /api/autopilot/:id/undo`
`POST /api/scan` · `POST /api/scan/stop` · `GET/PATCH /api/settings` (no keys out; `PUT /api/keys/:name`)
`POST /api/pair/request` · `POST /api/pair/approve` · `GET /api/worker/next` (long-poll) · `POST /api/worker/result`
`GET /api/events` (SSE: state, deals, review, activity, notify)

## Where this stands (2026-11-23)
On main (not pushed). typecheck clean; 1,719 core/agent + 1,119 extension unit tests; extension, desktop UI and `cargo check` build. No e2e, no live calls (owner's testing scope).
- **Agent does the work:** schedule, scans within the SerpApi budget/reserve/per-scan cap, Keepa inside scans, eBay pass, AI pass on every open question (research over Chrome, assist from evidence), Autopilot (verified + trusted model only; default research/assist model Opus 5.5, measured; Undo), one digest per run as a native notification and optional Telegram, Activity log, monthly AI cap ($25 default).
- **Security:** token on every request, Host/Origin checks, pairing by code, keys only in the agent (never returned), the shell trusts port 8790 only after an HMAC challenge, crash-safe store (fsync, corrupt file → paused safe state), legacy plaintext keys removed.
- **Extension:** paired worker for Home Depot reads (page, kit, part price, search, research page) with lease renewal; standalone mode unchanged.
- **Desktop app:** rail (Today, Deals, Review, Activity, Settings), Deals table + detail pane, Review master–detail with evidence and keyboard, pairing approval in-app, tray with question count, close to tray, launch at login, shortcuts, native notifications.
**Not done:** Windows packaging; keychain for keys; SQLite; the DMG not built in this session; nothing exercised end to end in a real Chrome + app pairing; DeepSeek not evaluated (untrusted until measured); known flaky test (hdReader concurrency under full-suite load).
