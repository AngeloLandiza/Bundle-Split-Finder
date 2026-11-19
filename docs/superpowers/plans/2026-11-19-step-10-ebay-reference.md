# Step 10: eBay reference value, checked by a swappable model

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** each part shows what New units of it actually sell for on eBay, as a labelled reference price (never counted in ROI yet), with every eBay listing it rests on checked for identity by a language model behind a provider-neutral interface, Claude first.

**Owner's decisions (Nov 19):** "build it so its model agnostic. lest do claude first." · "reference until its reliable." · PO (Nov 18): value parts by eBay, "eBay is more helpful at figuring out what price is actually receiving volume"; New only.

**Architecture:** eBay Browse API (owner's production keys) → deterministic pre-filter → `ListingJudge` (Claude adapter first) → code-side verification of the judge's quotes → per-part eBay value from listings that are verified matches and have sold units → `PriceOption` kind `ebay_sold_new` with `reference: true`. Unsure listings become Review questions; owner answers grow a labelled set that measures the judge. Core stays pure (fetch is passed in).

## Verified facts (probes and docs, Nov 19)
- Browse `item_summary/search` (production): `filter=conditionIds:{1000},buyingOptions:{FIXED_PRICE}`, `category_ids=3247` (Power Tools) and `limit=200` all work; "RYOBI PCL206" New in 3247: 77 listings. Category does not separate tool from accessory: hard cases for the drill sit in Cordless Drills (184655). Summaries carry `epid` on some listings.
- `getItem` gives `estimatedAvailabilities[0].estimatedSoldQuantity` (units sold by that listing over its life), `mpn`, `brand`, `localizedAspects`, `lotSize`, `description` (HTML), `shortDescription`, `sellerItemRevision`. **`getItems` (batch) returns 403 "Insufficient permissions"**: one `getItem` per listing.
- Marketplace Insights (sold prices): scope refused (`invalid_scope`); needs an application to eBay. Out of scope here; Browse cannot give past sale prices, so the label never says "sold at".
- OAuth client-credentials token: valid 7200 s; the token grant is limited to 1,000 a day (eBay OAuth rate-limit page) → cache it. Browse daily call limit: not confirmed from docs (pages 403); the scan caps its own calls.
- Claude from the browser: header `anthropic-dangerous-direct-browser-access: true` (SDK `dangerouslyAllowBrowser`); refused for ZDR/Compliance-API organisations. Structured outputs supported on claude-haiku-5-5 and claude-opus-5-5; schema objects need `additionalProperties: false`; no `minimum`/`maximum`/`minLength`/`oneOf`. The SDK in an MV3 service worker is undocumented → the adapter uses plain `fetch` (documented path).

## Global constraints
- No eBay user data anywhere (exemption): drop `seller` and any buyer/feedback field at parse time; never send them to a model; fixtures stripped.
- Keys (eBay App ID, Cert ID; Anthropic key) live in `chrome.storage.local` only, sent only to `https://api.ebay.com` and `https://api.anthropic.com`; never logged, printed, put in a URL or fixture. Node reads them from `.env` (`PRD_EBAY_APP_ID`, `PRD_EBAY_CERT_ID`, `ANTHROPIC_API_KEY`) without printing.
- Never guess: a listing counts only as a verified `match`; anything else is `not_match` or `unsure` (→ Review). The model never supplies a price or a sold count.
- eBay value is `reference: true` and enters no ROI until the owner decides the judge is reliable (threshold below).
- Default tests: zero network (recorded eBay responses, recorded judgements, fake fetch). Anything that calls a model costs money: dry-run first, owner's yes before a run; subagents never call a paid model or eBay live.
- Spend caps per scan: eBay searches ≤ 40, `getItem` ≤ 300, listings judged ≤ 60 (Settings), judgements cached so a listing is judged once per (item, revision, prompt version, model).

## Tasks
### Task 1 — core eBay listings (Sonnet)
Files: `core/src/ebay/types.ts`, `parse.ts`, `filter.ts`, `value.ts`; tests on `fixtures/ebay/*`.
- `EbayListing {itemId, title, price, currency, conditionId, categoryIds, epid?, mpn?, brand?, aspects: {name,value}[], descriptionText (HTML stripped, ≤ 4000 chars), soldQuantity: number|null, revision?, url}`; no seller fields exist in the type.
- `preFilter(part, listings)`: drops non-New, priceless, brand-mismatched (brand/aspect names another brand), and listings whose title, MPN and aspects name neither the part's model nor its RYOBI B twin as a whole token. Never accepts; only drops or passes on. Cap: 8 candidates a part, search order.
- `ebayValue(judged)`: from verified matches with `soldQuantity > 0`: listings, units sold, low, high, sold-weighted median price, up to 3 links. None → no option.
- Test: PCL206B fixture → the bit holders and toolbox insert dropped; drills and cases passed on.

### Task 2 — the judge contract and the Claude adapter (Opus)
Files: `core/src/judge/types.ts`, `prompt.ts`, `schema.ts`, `verify.ts`, `core/src/judge/claude.ts`.
- `interface ListingJudge { id: string; model: string; judge(input: JudgeInput, signal?): Promise<JudgeRaw> }`. `JudgeRaw {verdict: 'match'|'not_match'|'unsure', toolOnly: boolean|null, quantity: number|null, condition: 'new'|'other'|null, extras: string[], evidence: {claim, quote}[], reason}`. `PROMPT_VERSION`.
- `verifyJudgement(raw, listing)`: every quote must occur in the listing's title, aspects or description (whitespace- and case-normalised); a `match` also needs a quote containing the model or twin, `quantity === 1`, `toolOnly === true`, `condition === 'new'`, no extras; otherwise downgraded to `unsure` with the reason. Malformed output → `unsure`.
- Claude adapter: plain `fetch` to `/v1/messages` with `x-api-key`, `anthropic-version`, the browser header, `output_config.format` JSON schema, `max_tokens` ~800; no retries; returns token usage; typed errors for 401/429/5xx (a failed call is `not judged`, never a verdict). Provider-neutral: a second adapter (e.g. DeepSeek) is a new file only.
- Tests with a fake fetch: the request shape, schema validity, quote verification (a fabricated quote → unsure), a card claiming "tool only" with a battery quote → unsure.

### Task 3 — record eBay for the validation set (script Sonnet; run by the main session)
`scripts/ebay-record.ts --dry-run | --run`: for the validation set's part models (fixtures/validation), search (category 3247, New, fixed price, limit 200) and `getItem` for each pre-filter candidate; write `fixtures/ebay/validation-2026-11-19.json` with seller stripped. Free (no SerpApi); dry-run prints call counts.

### Task 4 — labels, scorer and eval (Sonnet; labels drafted by an Opus subagent)
- `fixtures/ebay/labels.json`: per candidate listing `{itemId, model, verdict, labelledBy: 'draft' | 'owner', note}`. Drafts come from an Opus reading of each listing with quotes, marked `draft`; the owner checks a sample in Review or a page.
- `npm run judge:eval -- --model <id> [--dry-run]`: dry-run prints listings and estimated cost; a run judges the recorded candidates, saves `fixtures/ebay/judgements-<model>.json` (replayed by default tests), and scores: false matches, matches found, unsure rate, tokens and cost.
- **Reliable** (proposal for the owner): on ≥ 100 labelled listings, ≥ 30 owner-checked, zero false matches and ≥ 70% of true matches accepted. Meeting it is the owner's cue to decide whether eBay counts in ROI.

### Task 5 — the extension (Sonnet)
- Settings: eBay App ID and Cert ID; Anthropic key; model (default from the eval, owner's choice); listings judged per scan (60). Token cached in `chrome.storage.session`.
- Scan: after Home Depot part prices, for each part: search → pre-filter → `getItem` → judge (cache first) → `ebayValues` store (new IndexedDB store); counts `ebaySearches`, `ebayItemReads`, `listingsJudged`, tokens.
- Detail: Reference group line `eBay · New · $38.50–$54.99 · 3 listings, 41 sold` with listing links; Review: "Is this eBay listing exactly PCL206B, New, tool only?" with the judge's reasons and the link; an answer overrides the judgement and is exported for the labels. CSV: `ebay_ref_low`, `ebay_ref_high`, `ebay_units_sold`.
- E2E: replay server serves recorded eBay responses and a fake model endpoint.

### Task 6 — review and ship
UI review (Detail line, Review question, Settings), QA walkthrough, decisions.md, the plan's "Where this stands", merge.

## Review focus
1. A case, holder or battery listing for the tool reaching a verified `match`.
2. A listing selling a 2-pack or "tool + battery" counted as the bare tool.
3. Keys or seller names reaching a log, fixture, export or model prompt.
4. A failed or rate-limited model call shown as a verdict or blocking the scan.
5. A part with no eBay match showing $0 instead of no eBay line.
