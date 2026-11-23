# Keepa, discovery/tracking scale, and background agent (plan)

**Owner (Nov 22):** Use Keepa for Amazon instead of SerpApi where it fits. Split Keepa spend into
**discovery** (find bundles and combinations) and **tracking** (sales velocity, price and seller
trends) on a **scale** that shifts toward tracking once the universe is mapped. Run a
**background agent** that messages him when Review needs him or a bundle clears his buy thresholds.
**Both** discovery scopes count: every Home Depot bundle SKU worth watching **and** every way-to-sell
listing combination per bundle.

**Architecture default (v2 prototype):**

- **Chrome extension** — Review, Includes, kit pages, chip, confirm price (unchanged role).
- **Local agent (later in v2)** — optional Node or menubar app: schedule, Keepa-heavy scans,
  dashboard, desktop notifications; **no Docker** for the prototype (containerize only when
  deploying to a VPS or a fixed home server).
- **`core/`** — shared scan, match, Keepa client, budgets.
- **SerpApi** — Home Depot listing pages until another source exists.
- **Sync** — prototype: extension remains source of truth; agent reads **export** or a localhost
  bridge when added. No cloud DB in v2 prototype.

Optional **relay** (Telegram) after Alex picks a channel. Nothing in this plan spends live tokens
in tests; record once, replay from fixtures (same rule as SerpApi).

**References:** [Keepa tokens](https://keepa.com/api-docs/plans-tokens.html), [product](https://keepa.com/api-docs/product.html), [product finder](https://keepa.com/api-docs/product-finder.html), `docs/v1-plan.md`, `docs/search-budget.md`.

---

## 1. What already exists (baseline)

| Mechanism | Maps to |
| --- | --- |
| HD listing pages in scan | Bundle **SKU** discovery (price, model, item id) |
| Split + Includes + Review | SKU **contents** discovery |
| Catalog crawl + match from saved listings | Amazon discovery amortized |
| `pendingLookups` vs `staleRefreshes` in `scanPlan.ts` | Implicit discover vs refresh |
| Ways to sell + `bestPlan` | **Combination** discovery per bundle |
| Scheduled scan + ROI alerts | Thin **tracking** + notify (Chrome only) |

What is missing: explicit **two budgets**, **Keepa**, **trend metrics**, **Review alerts**, **push
outside Chrome**, and a recorded rule for when discovery is **done enough** to slide the scale.

---

## 2. Discovery scope (both, per Alex)

### 2a. Bundle SKU universe

Everything the tool should **know about** on Home Depot for the chosen brands:

- One record per **bundle listing** (item id, brand, model, title, price, was-price, seen time).
- Split state: resolved, needs review, or contents not known.
- Whether the SKU is **active** in the last scan (still on deals pages) or **archived** (seen before, not on today's pages — still track price if we care).

**Discovery work per new SKU:** HD row (SerpApi), optional page read (browser), split question, part list, kit pages not read.

**Done for a SKU:** Split resolved; every part either matched, owner-priced, or honestly in Review/none; every kit inside the split read or waived.

### 2b. Way-to-sell combinations per SKU

For each bundle with a resolved split, every **sell plan** the optimizer can evaluate:

- Primary option today: best of {whole, split kits…} by profit with no leftovers preference (`primaryOf` in `report.ts`).
- **Full discovery** (Alex): persist and refresh **each** generated option (whole, each split pattern, each kit whole vs split), each with:
  - Part rows and ASINs used in that option's estimate
  - Leftovers named
  - Estimated profit, ROI, range (lowest / Amazon New / highest)

Combinations depend on **listing covers** (one ASIN covering multiple units, multipacks). Discovery must not guess a new combination: only plans the code already builds from stored matches and owner prices.

**Done for a SKU's combinations:** Every option has an estimate or a stated reason it cannot (missing listing, Review, unread kit). No option left as "never computed."

### 2c. Amazon discovery (Keepa tokens)

Per part still in discovery:

| Step | Keepa (typical) | SerpApi today |
| --- | --- | --- |
| Find candidates | Product Search 10 tokens (≤20 rows) or Finder 10+N/100 | `amazon` 1 search |
| Grade / verify | Product 1 token (batch); partNumber on object | `amazon_product` 1 search |
| Optional depth | +stats, +buybox (+2), offers (6/page) | limited |

Rule 4 unchanged: review caps, accessories, twin listings, multi-tool titles — **no auto-promote**.

---

## 3. Tracking scope

Once a **watch record** exists (bundle SKU + at least one combination marked watchlist), spend
Keepa on **refresh and trends**, not re-search.

### 3a. What to refresh

| Signal | Source | Use |
| --- | --- | --- |
| HD bundle price / was-price | SerpApi listing page or stored row | Cost side of ROI |
| Amazon New / Buy Box | Keepa product, `stats` or csv | Revenue side |
| Sales rank / monthly sold proxy | Keepa history | Velocity filter for "buy when" |
| Offer count / seller mix | Keepa offers or buyBox fields | Competition trend |
| Listing inactive | Keepa availability | Section + confirm-price path (existing) |

### 3b. What "recommend when to buy" means

Alerts compare **today vs stored baseline** (last scan or 7-day Keepa average), not point-in-time sort only:

- Margin **crossed up** through owner thresholds (profit and ROI in Settings).
- Margin **fell through** floor (optional "stop buying" alert).
- **Review cleared** since last message (estimate became real).
- **Discovery finished** for a SKU (first time Confirmed green).

Still label everything an **estimate** (fee settings, not real FBA/SP-API fees).

### 3c. Tracking token discipline

- Batch ASINs: up to 100 per product request (1 token each base).
- No Product Search for parts that already have `decidedBy` and ASIN.
- Stale threshold (existing refresh list) gates who gets a pull.
- **Depth tiers:** scan setting `trackingDepth`: `price_only` | `price_and_rank` | `full` (maps to Keepa optional params; document token cost in UI).

---

## 4. The scale (discovery ↔ tracking)

### 4.1 Two buckets per run

Settings (extension, later worker):

| Field | Meaning |
| --- | --- |
| `keepaTokensPerRun` | Cap per scan (like `searchesPerScan`) |
| `keepaDiscoveryShare` | 0–100% of cap reserved for discovery this run |
| `keepaReserve` | Tokens left untouched (like SerpApi reserve) |
| `discoveryMode` | `auto` \| `discovery_heavy` \| `tracking_heavy` |

**Auto scale** (suggested default):

```
discoveryShare = clamp(
  base + (openDiscoveryWork / totalWork) * (100 - base),
  minShare,
  maxShare
)
```

Where **openDiscoveryWork** counts:

- Bundle SKUs with split not resolved or never page-read
- Parts `waiting` / `unmatched`
- Match questions open
- Options never estimated for a resolved bundle
- Kits `kitsNotRead`

When all watched SKUs are **tracking-ready** (no row in sections split / waiting / missing_listing with uncovered models for primary option), `discoveryShare` → **minShare** (e.g. 10%), rest tracking.

### 4.2 SerpApi vs Keepa split

| Job | API |
| --- | --- |
| HD deals pages | SerpApi (`home_depot`) |
| HD Includes / kit | Browser (extension) |
| Amazon find / verify (discovery) | Keepa (primary); SerpApi fallback if Keepa empty and owner allows |
| Amazon refresh (tracking) | Keepa only |

### 4.3 Alex's rate limits

- **Test:** ~1 token/minute (per PO) — discovery runs must be **tiny** (one bundle, few parts); most work queued.
- **Production:** 20 tokens/minute — full scan with batched tracking viable; still use cap + scale.

Show **tokens left** and **refillIn** from Keepa responses in the footer (mirror SerpApi meter).

---

## 5. Background agent and messaging

### Phase A (extension only)

- Extend schedule: already runs when Chrome is open.
- Notifications:
  - Existing: ROI/profit threshold on **Confirmed** bundles (max 3).
  - **New:** Review digest ("4 match questions, 1 split") after scan.
  - **New:** "Discovery complete for &lt;model&gt;" when SKU becomes tracking-ready.
  - **New:** Trend alert when margin vs baseline crosses threshold (needs tracking store).

### Phase B (optional relay)

- Small HTTPS worker (Telegram bot or email): extension POSTs signed digest after scan (no keys in message).
- Alex gets pings with laptop closed **only** if worker holds **no** HD reader — worker runs Keepa tracking on **last exported** bundle list; HD prices stale until next extension sync.

**Recommendation:** Ship Phase A with Keepa; add Phase B when he confirms Telegram (or other).

---

## 6. Data model and storage (prototype v2)

**PO alignment:** Bundle rows, matches, Review and answers stay in the existing IndexedDB stores
(`bundles`, `matches`, `review`, …). For the **prototype**, new Keepa responses and scratch
trend/agent payloads go through the existing **`cache` store pattern** (keyed JSON, same as
SerpApi replay) rather than new stores or a cloud database. *For v2.1:* dedicated stores or
SQLite in a local agent when the dashboard needs queries across history.

Concepts to name in code when needed:

| Record | Purpose |
| --- | --- |
| `BundleWatch` | SKU on watchlist; `discoveryState`: `open` \| `ready` |
| `OptionSnapshot` | One way-to-sell's estimate + ASIN set + time |
| `PartTrend` | Last Keepa stats pull: price, rank, offers, `pulledAt` |
| `AlertBaseline` | Last notified profit/ROI per bundle key |

Export/audit gains fields when snapshots exist. **Docker headless HD scraping is out of scope:**
Includes stay on the extension doorway; the agent uses APIs (SerpApi HD + Keepa), not container
Chromium against homedepot.com.

---

## 7. Implementation phases

### Phase 0 — Measure (no production switch)

- `KeepaClient` + `KeepaBudget` in `core/src/keepa/` (no `chrome.*` / `node:*` in client; Node adapter in `scripts/`).
- Record fixtures for Product Search + Product on validation ASINs.
- Report: tokens/part vs SerpApi searches/part; match grades with `partNumber` from Keepa.

### Phase 1 — Amazon leg in extension

- Settings: Keepa key (storage like SerpApi).
- Scan planner: split queue into **discoveryQueue** and **trackingQueue** under token cap.
- Reporting: all options' estimates stored (not only primary) for CSV/UI when computed.

### Phase 2 — Scale + depth

- `discoveryMode` auto + UI slider (advanced).
- Tracking depth tiers; trend baselines; expanded alerts.

### Phase 3 — Local agent + dashboard (v2 prototype capstone)

- `agent/` (Node): scheduled scan using `core/`, Keepa + SerpApi HD, cache/SQLite on disk.
- Simple web UI or Tauri shell: token meters, discovery/tracking share, deal table, trend stubs.
- Extension bridge: import export or localhost POST of HD page-read results.
- **Not in prototype:** Docker, VPS deploy, headless Playwright HD.

### Phase 4 — Outbound messaging (after Alex answers §9)

- Desktop notifications in agent; optional Telegram/email relay.
- 24/7 only with always-on machine or VPS — not while a laptop is asleep.

---

## 8. Acceptance (for Alex)

1. With Keepa on 20/min, a scheduled scan completes without exhausting the bucket; deferred work is visible.
2. A bundle moves from **missing/review** to **Confirmed**; the next scan spends **fewer** discovery tokens on it.
3. Every resolved bundle in Detail shows **all** ways to sell with estimates or explicit "not yet."
4. He receives a message (desktop, then phone) when Review is non-zero **or** a watched bundle crosses buy thresholds **or** margin improves vs last week on a tracking-ready SKU.
5. No match auto-confirmed that step 8b would block.

---

## 9. Open questions for Alex

**Blocking Phase 4 only** (messaging / 24/7):

1. How should the agent notify you? Chrome desktop only, email, Telegram, Slack, SMS?
2. When Chrome is closed or the laptop is asleep: **(1)** scans wait until Chrome is back
   (extension + optional local agent while the machine is awake), or **(2)** always-on service
   elsewhere (needs VPS or a home PC)?

**Product tuning** (can default):

3. Watch **all** bundle SKUs ever seen, or only those still discounted on HD?
4. Track **all** way-to-sell options on every scan, or only primary + best alternate?
5. Confirm Keepa plan tokens/minute (1 test vs 20 prod)?
6. OK to keep **paid SerpApi** for HD only if free 250 is too tight?

**Defaults if silent:** Chrome notifications + Review digest; option (1) extension/agent while
awake; watch active discounted SKUs; persist all options when computed; Phase 0 uses his test
Keepa key with strict caps.

---

## 10. Where this stands

**Phase 0 done (Nov 22).** `core/src/keepa/`, product + search fixtures, `keepa:record`,
`keepa:measure`, `keepa:budget`, tests. Reserve uses Keepa meta after the first response.
**Nov 22 (goal in progress):** Phases 0–4 wired on fixtures and in the extension: Keepa key and
`keepaDiscoveryShare` cap (auto mode), `planKeepaRun` with reserve/depth/identify estimates, trends on
refresh, Review/ROI/trend/discovery-complete alerts, deferred meter in the side panel, signed relay digest,
desktop notify lines. Local agent: `agent/run.ts`, dashboard on :8790, macOS notify; extension may POST
the audit export after each scan when enabled (Settings › Your data). Option snapshots on scan end.
Still missing for §8 sign-off: live Keepa 20/min proof, Telegram beyond the generic signed webhook,
agent disk cache / rich deal table. Multi-option Detail uses `WaysToSell` (estimate or "No estimate yet").
Phase critiques recorded in `docs/keepa-v2-acceptance.md`.
Phases 1–2 can run in the extension; Phase 3 local agent is optional capstone for v2 prototype.

**Recorded (Nov 22, implementer):** prototype scratch data uses **cache pattern**, not cloud; **no
Docker** for v2 prototype; extension + optional **local agent** (not headless HD in a container).

---

## 11. Should we start phased development?

| Phase | Start now? | Needs |
| --- | --- | --- |
| **0 — Measure Keepa** | **Yes** | Alex sends Keepa API key; `npm run budget` equivalent for tokens; record fixtures |
| **1 — Amazon in extension** | After 0 shows grades | Keepa key in Settings; planner split |
| **2 — Scale + trends** | After 1 stable | Cache keys for trends; UI |
| **3 — Local agent UI** | Parallel or after 1 | Product proof; bridge spec |
| **4 — Telegram / 24/7** | After Alex §9 (1–2) | Relay or VPS decision |

Phase 0 does not change v1 behaviour in production; it adds `core/src/keepa/` and tests on
fixtures. Safe to start while v1 zip remains the PO deliverable.