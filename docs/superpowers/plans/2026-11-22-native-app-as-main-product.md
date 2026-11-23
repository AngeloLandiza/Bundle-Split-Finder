# Native app as the main product — architecture plan (with critique)

**Goal:** Native **Mac/Windows app as the primary product**, with a **thin Chrome helper** for Home Depot. **Decision: Lane D** (Alex, Nov 22). Implementation: `2026-11-22-native-app-as-main-product-impl.md`.

**References:** `docs/v1-plan.md` (HD Includes, browser-only reads), `docs/design.md`, `docs/superpowers/plans/2026-11-22-keepa-agent-discovery-tracking.md`, mockups in `docs/design/mockups/`.

---

## 1. What “main product” should mean

For a non-technical reseller, **main product** means:

1. **One thing to install** — drag to Applications / run Setup.exe; no Terminal, no “Load unpacked”.
2. **One place to work** — open the app to see Deals, run scans, answer Review, change settings.
3. **Home Depot still feels integrated** — chip on bundle pages, “This page” context, Includes-driven splits (v1 acceptance).
4. **Looks like the workshop ledger** — `docs/design.md` tokens (paper, ink, mono figures), not debug JSON or generic dashboards.

Anything that still requires the user to **manage two products** (app + manual extension) is **not** main-product UX, even if it is technically fine for v2 prototype.

---

## 2. Non-negotiables (from v1 + recorded facts)

| Requirement | Why it binds architecture |
| --- | --- |
| **Includes list on Home Depot** | Only on the real product page in the user’s **logged-in browser session**; SerpApi product JSON does not carry it (`v1-plan.md`). Plain HTTP from a native process gets a **placeholder page**. |
| **`sidePanel` + chip on `homedepot.com/p/*`** | Chrome extension APIs; not available to a generic native window without an embedded Chromium + extension. |
| **Keys stay local** | SerpApi, eBay, Anthropic, Keepa in **browser or app-local storage**, not a shared server. |
| **No guessing** | Review, confirm price, packaging — same `core/` behaviour; UI must surface uncertainty (design principle 5). |
| **Budget honesty** | Every paid action shows cost (design principle 4). |

**Conclusion:** You cannot delete **all** browser-side capability and keep v1 behaviour. The question is **how small** the browser piece can become and **whether the seller sees the native app as “the product.”**

---

## 3. Options (scored)

### A. Extension-first (today)

- **UX:** Seller lives in Chrome side panel; desktop app = agent dashboard (prototype).
- **Extension required?** Yes, and it is the whole UI.
- **Verdict:** Works for developers; **fails** “main product” for Alex.

### B. Native app only — no extension

- **Idea:** Tauri/Electron UI + APIs only (SerpApi HD listings, Keepa Amazon; no page read).
- **UX:** Polished app, but **splits degrade** (title-only, “contents not known”, wrong BOGO/kit depth).
- **Verdict:** **Reject** for this business; contradicts v1 and owner examples (PCL1201K2 kits, Includes).

### C. Native app + headless browser automation (Playwright in agent)

- **Idea:** App runs scans 24/7 without Chrome open; scrape HD in a container.
- **UX:** Single product feel.
- **Verdict:** **Out of scope** (v2 plan + `decisions.md`): HD stays **extension doorway**; automation risks blocks, stale sessions, and is not the owner’s browser. **Do not** sell this as v2.

### D. Native app hosts **all UI**; **minimal “bridge” extension**

- **Idea:** Move Deals, Review, Detail, Settings from side panel → **native window** (Tauri + embedded web UI **reusing** extension React + `core`, or native widgets). Extension keeps: content script, HD reader tab/`scripting`, chip, `sidePanel.open` bridge, optional notification permission.
- **UX:** App is what they open; Chrome shows chip + “open in Split Finder” if side panel unavailable. **One installer** can bundle extension + register via enterprise policy or in-app “Install browser helper” (still Chrome MV3).
- **Extension required?** **Yes, but thin** (~reader + chip + messaging). Seller mental model: “I use Split Finder”; helper is like a printer driver.
- **Verdict:** **Best long-term fit** for “main product” without lying about HD.

### E. Electron “browser shell” with **built-in Chromium + packed extension**

- **Idea:** One `.app` ships Chromium profile + unpacked MV3; seller browses HD **inside the app**; chip runs in that window.
- **UX:** Truly one icon; matches “app is the product.”
- **Costs:** Large binary (~150MB+), security updates, **two Chromiums** if they also use Chrome for Amazon Seller Central, extension store rules if ever published.
- **Verdict:** **Viable** if Alex wants zero Chrome extension install; **heavier** than D. Prefer **only if** bridge extension install is unacceptable.

### F. Progressive web app (PWA)

- **Verdict:** **No** — no `sidePanel`, no stable HD content injection on arbitrary origins.

| Option | Main-product UX | Keeps HD fidelity | Build cost | Risk |
| --- | --- | --- | --- | --- |
| A (today) | Low | Yes | Done | Low |
| B | High | **No** | Medium | **High** (wrong answers) |
| C | High | Fragile | High | **High** |
| **D** | **High** | **Yes** | **High** | Medium |
| E | **Highest** | **Yes** | Very high | Medium–high |
| F | — | — | — | Dead |

**Recommendation:** **Plan for D**; keep **E** as fallback if “Install helper in Chrome” fails user testing.

---

## 4. Recommended target architecture (option D)

```
┌─────────────────────────────────────────────────────────────┐
│  Split Finder.app / .exe  (Tauri) — MAIN PRODUCT            │
│  • Deals / Review / Detail / Settings  (design.md UI)         │
│  • Scan control, budget meters, Keepa scale, alerts           │
│  • Embedded agent (already started on launch)                 │
│  • localhost API + durable store (SQLite or IndexedDB port)   │
└───────────────────────────┬─────────────────────────────────┘
                            │ native messaging / localhost bridge
┌───────────────────────────▼─────────────────────────────────┐
│  Browser helper (MV3) — SMALL                               │
│  • homedepot.com content script + chip                      │
│  • background: read HD pages, POST Includes to app            │
│  • optional: open app window instead of side panel            │
└─────────────────────────────────────────────────────────────┘
```

**Data:** App is **source of truth** (flip v2 prototype: extension syncs **to** app, not only export JSON). Keys live in app secure storage; helper receives **session tokens** or never holds secrets (helper only forwards page payloads).

**Scan flow:** User clicks **Scan now** in **app** → app schedules SerpApi/Keepa via `core/` → when HD **page read** needed, app asks helper → helper reads in **user’s Chrome** (or in-app browser if E) → results back to app → UI updates.

---

## 5. UI/UX principles (native main window)

Apply `docs/design.md` literally; the mockups are the spec.

| Surface | Native main window behaviour |
| --- | --- |
| **Shell** | Fixed min width ~400px (side panel DNA), resizable desktop window; **one** surface band — no card-in-card. |
| **First run** | **In app**, not `options.html` in Chrome: steps 1–3 from `FirstRun.dc.html`; SerpApi key check before Scan enables. |
| **Loading** | Per-section skeleton rows (hairlines + muted ink-3 placeholders); never raw JSON. Errors = one sentence + recovery action. |
| **Deals / Detail / Review** | Port existing React screens; same sort, tags, loss colour, estimate labels. |
| **HD chip** | Still on Home Depot in Chrome (helper); click opens **app window** to This page (or side panel fallback if helper-only). |
| **Agent / alerts** | In-app banner + OS notification; no separate “prototype dashboard” as the hero screen. |

**Kill list (explicit):** “Local agent (prototype)”, debug `<pre>` as default, duplicate Setup in Terminal.

---

## 6. Phased delivery (pragmatic)

| Phase | Deliverable | Extension role | Status |
| --- | --- | --- | --- |
| **P0** | Fix install: one-click unpack, valid manifest, app auto-starts agent | Full UI (unchanged) | Done |
| **P1** | App home = **setup wizard + status** (design.md) | Full UI | Done (code) |
| **P2** | **Settings + key check** in app; sync keys to extension securely | Full UI | Planned |
| **P3** | **Deals list** in app (read-only from store); extension still writes scan | Dual UI | Planned |
| **P4** | **Review + Scan now** in app; helper = HD read + chip only | **Thin helper** | Planned |
| **P5** | Deprecate side panel as primary; optional “compact mode” in Chrome | Helper only | Planned |

Stop at any phase if Alex prefers dual UI; **do not** skip P4 before claiming “app is main product.”

---

## 7. Self-critique (three passes)

### Critique 1 — “Just ship a prettier dashboard”

- **Weakness:** That is **not** main product; seller still lives in Chrome for every action.
- **Fix:** Dashboard becomes **secondary**; primary surfaces are Deals/Review in app (phase P3+).

### Critique 2 — “Drop extension in P2”

- **Weakness:** Breaks Includes, chip, v1 item 328814689 acceptance.
- **Fix:** Helper remains until **automated replacement** exists with **fixture-proven** parity (not SerpApi-only).

### Critique 3 — “Electron everything day one”

- **Weakness:** Rewrites UI + packaging + doubles browser maintenance; does not remove **need** for extension-like code inside Chromium.
- **Fix:** **Tauri + reuse React** from `extension/` in a `desktop-ui/` entry; add Electron shell **only** if Chrome helper install fails in user test.

### Critique 4 — “Non-technical users won’t install a helper”

- **Weakness:** Real; Chrome Web Store would help but is a separate programme.
- **Fix:** App wizard: detect helper → **one button** “Enable in Chrome” (opens `chrome://extensions` + copy path + short video); consider **E** for a “Split Finder Browser” window inside app for HD only.

### Final strength check

| Question | Answer |
| --- | --- |
| Can app be **perceived** as main product? | **Yes**, with D or E. |
| Can extension be **eliminated** entirely? | **No**, without losing HD fidelity or accepting v1 regression. |
| Is there a **clear UX spec**? | **Yes** — port mockups to main window; helper invisible. |
| Is plan **honest about cost**? | **Yes** — P3–P4 are a **large** UI move, not packaging only. |

---

## 8. Decision

**Lane D — App-first UI + thin browser helper** (chosen).

Implementation phases, tasks, tests, and acceptance: **`docs/superpowers/plans/2026-11-22-native-app-as-main-product-impl.md`**.

Lane E (embedded browser) remains escalation only if Chrome helper install fails user testing.

---

## 9. Relation to packaging (DMG / exe)

Installers should eventually ship:

- **App binary** (with embedded agent — done).
- **Browser helper** (unpacked MV3 + guided install), **not** “figure out Load unpacked yourself.”

Until P4, the **canonical** seller UI remains the **extension side panel**; the app is the **on-ramp and ops desk**, not a replacement yet.