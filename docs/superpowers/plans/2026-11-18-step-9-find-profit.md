# Step 9: find the profitable bundles — research and plan (not built)

Owner, Nov 18: "i ran a scan i have 0 positive ROIs. i need this product to work. I know there are a lot out there that have positive and also good positive ROIs … discover, research, and plan." Nothing here is implemented yet.

## What the research found

Data: the validation set (33 real bundles, 150 parts, blind labels), Home Depot pages read in the owner's Chrome on Nov 18, and a numbers diagnosis of every bundle (no searches spent).

1. **Fees are not the cause.** Defaults are lenient: 15% referral, no fulfilment, no sales tax, no inbound cost.
2. **About 12 of the 31 bundles are not deals at all.** Home Depot's price is at or above what the parts sell for (10 show no was-price). Example: DCK940D2W2032 costs $1,178 and the kit alone is $799 at both stores. Lookups spent on them are wasted.
3. **The rest lose because parts the tool is unsure of count as $0.**
   - In review (the owner has not answered): PSK1212SB-PCL265B ($99: 4 Ah + 2 Ah batteries, charger, impact wrench) reads −53%; with its two labelled-correct review listings it is **+72%**.
   - No new Amazon listing on page 1 of the search: the drill PCL206 and the circular saw PCL500 sit in about 10 bundles; Amazon showed only Renewed rows or "fits for Ryobi" parts. They were searched without the tool-only B (PCL206B), and no B search was made.
   - Kits with no Amazon listing whose contents are not named: RYOBI starter kits (PSK0114: "4Ah Battery & Charger"), most DEWALT kit pages (no Includes list).
   - Items with no model number (the kit's charger, bags, blades) count $0.
4. **Home Depot's own prices show the size of the gap.** PSK0114-PCL265B costs $79 and holds a PBP004 battery ($129 at Home Depot), a PCG002 charger ($34.97) and a PCL265B impact wrench ($99): $263 of retail. The tool says −100%.
5. **The deal source the tool cannot see: Home Depot's buy-one-get-one.** Single RYOBI tools (PCL265B, PCL525B, PCL430B) carry `conditionalPromotions` with `experienceTag: "BOGO"`, promotion 945815, Oct 26, 2026–Jan 31, 2027: "Purchase Select Ryobi Starter Kit and receive a select FREE Tool" (reward 100% on the target tool). The prepackaged bundles (PSK…-PCL…B) are this deal; the free-tool pairing for any qualifying kit is not scanned. The PO's brief asked for BOGO "item by item"; v1 cut it. The eligible lists (source kits, target tools) load separately on the page; where from is not yet known.
6. **The price the tool uses is at the low end.** For parts matched from the brand catalog pages it takes the low end of the rows seen (PCL235B $44.90 against $52.99–58.90 elsewhere). Taking the typical price instead flips 1 → 5.
7. **Fulfilment cost decides kit splitting.** At $5 a unit the PCL1600K2 family's gains nearly vanish: an 8-part split pays 8 fulfilment fees. High value per part (a starter kit + a free tool: 3 parts worth $263) survives fees; a kit split into eight $20–60 tools barely does.

Counterfactuals on the 31 (positive count): now 1; review parts the labels confirm counted 2; plus Renewed price as a floor 6; every uncertain candidate confirmed 13; referral 12% instead of 15% adds 2–3.

## Owner's decision (Nov 18): show every sell price, labelled
"since my PO hasn't answered yet, I think we should see all the options for the sell price with labels so we understand like what is the max ROI and the min ROI and the tool condition and at what seller. and ig we can have home depot price too." Fees stay as they are for now (question 2 dropped).

So questions 1, 3 and 4 below are answered by showing every option instead of choosing one. Each part carries a list of sell prices, each labelled with where it comes from, the condition, and the seller where known:

| Option | Source | Condition | Seller | Cost to get |
|---|---|---|---|---|
| Amazon featured price | search row `extracted_price` | New (the listing) | unknown until its page is read | already paid with the lookup |
| Amazon list price | search row `extracted_old_price` | New | — | already paid |
| Amazon lowest offer | search row `more_buying_choices` ("$70.70 (37+ used & new offers)") | used or new, mixed | several | already paid |
| Amazon Renewed | a Renewed listing in the same results | Renewed | Amazon Renewed | already paid |
| Home Depot | the part's own Home Depot page | New, boxed | Home Depot | free, read in the owner's browser |
| Buy Box seller | the listing's page (`purchase_options.buy_new`: price, sold by, ships from) | New | named (e.g. "Sold by ArcianCo, ships from Amazon") | 1 search per listing, only on request (Verify already reads this page) |

Each bundle shows a range instead of one number: **lowest ROI** (every part at its lowest labelled option, $0 where none), **Amazon New ROI** (featured prices only: what the tool shows today, plus confirmed review parts), and **highest ROI** (every part at its highest option). Detail shows each part's options with their labels and links; Deals sorts by any of the three; the CSV gets all three. Nothing is presented as more certain than its label.

## Questions only the owner or PO can answer (they change the plan)

1. **Selling condition.** Tools taken out of a kit have no retail box. Does the PO list them as New on Amazon, as Used/Like New, or elsewhere (eBay)? The tool has a packaging rule for this but does not use it in the estimate. If loose kit tools cannot be sold New, kit splitting is worth much less and starter-kit-plus-free-tool deals (the free tool comes boxed) matter most.
2. **Real fees.** FBA or self-fulfilled; the per-unit cost; the referral rate he pays on power tools (12% or 15%).
3. **Renewed as a floor.** May a Renewed price stand in, labelled, for a tool with no New listing?
4. **Home Depot price as a fallback.** May a part with no Amazon listing be estimated at an owner-set share of its Home Depot price, labelled and off by default?

## The plan, in order of payoff and safety

### Phase A: look at the right deals (largest lever)
- A1. **Read Home Depot's BOGO promotions** from product pages for free in the owner's browser (`conditionalPromotions`: BOGO, dates, description, reward). Find where the eligible source and target lists come from (research first; a docs-checker or a captured page, never a guess).
- A2. **Evaluate a promotion item by item**, as the PO asked: the cheapest qualifying starter kit plus the most valuable free tool, priced as a bundle (cost = the kit; parts = the kit's contents + the free tool). Shown in Deals with the promotion's name and end date.
- A3. **Skip what is not a deal.** A bundle with no discount (no was-price and not below its parts' Home Depot prices) gets no lookups until it drops, and Deals says why.
- A4. **More deal pages, for free.** Read Home Depot's promotion and Special Buy listings in the owner's browser instead of paying a search per listing page.

### Phase B: value the parts honestly (each figure labelled)
- B1. **Two estimates per bundle:** "confirmed" (today's) and "likely" (adding review candidates and labelled fallbacks), ranked by likely, each part showing what its value rests on. The owner confirms with one click per question, with the source links.
- B2. **Search the tool-only form** for RYOBI tools (PCL206B, not PCL206), once per tool; about 10 tools cover most bundles.
- B3. **Name kit contents** from the kit's own Home Depot page or the starter kit's page (PSK0114's battery and charger), the way PSK1212SB's page already names PBP004, PBP003 and PCG002.
- B4. **A typical price, not the lowest row.** Price a matched listing at what its own lookup shows, or the median of the rows seen for it, labelled.
- B5. **Owner-approved fallbacks** (Questions 3 and 4): Renewed price or a share of the Home Depot price, opt-in, labelled, never shown as an Amazon listing price.

### Phase C: fees and condition that match the business
- C1. Set the fee defaults from the PO's answers (referral, per-unit fulfilment).
- C2. Apply the packaging rule in the estimate once the PO answers Question 1 (New vs other condition per part).

### How each step is proven
Every lever is measured on the validation set before it ships (the harness replays with no network), and on the owner's real scans through the audit loop: positive count, ROI, and no wrong match. The validation set gains the BOGO deals Phase A finds.

## Searches
Phase A reads Home Depot for free. B2 needs about 10 Amazon lookups; confirming uncertain candidates by product page about 10. The validation bucket has 29 left; the owner approves each run.

## Order I recommend (after the owner's decision)
1. **Sell-price options and the ROI range** (the decision above; replaces B1, B4, B5): from data already paid for plus free Home Depot pages. Measured on the validation set: how many bundles are positive at lowest, Amazon New and highest.
2. **BOGO promotions** (A1–A2) and **skipping non-deals** (A3).
3. **Search the tool-only B form** (B2) and **name kit contents** (B3).
4. More free deal pages (A4); fees and condition (C) when the PO answers.

## Phase 1 tasks (owner: "Yea", Nov 18)

**Contract (Task 1 produces; Tasks 2–3 consume):**
- `PriceOption = { kind: 'amazon_new' | 'amazon_list' | 'amazon_lowest_offer' | 'amazon_renewed' | 'amazon_buybox' | 'homedepot'; price: number; condition: 'new' | 'renewed' | 'used_or_new'; seller: string | null; shipsFrom: string | null; offers: number | null; asin: string | null; link: string | null; seenAt: number }`.
- Each report part row gains `prices: PriceOption[]` (sorted high to low); each way to sell gains `range: { lowest: BundleResult | null; amazonNew: BundleResult | null; highest: BundleResult | null }` and the bundle row its primary option's range. `amazonNew` equals today's estimate (backward compatible).
- Scan dependency `readPartPrices?: (parts: { brand: string; model: string }[]) => Promise<{ brand; model; itemId: string | null; price: number | null; title: string | null; link: string | null }[]>` — free Home Depot standalone prices read in the owner's browser; stored on the part's catalog entry with its time.

**Task 1 (Opus): core.** Parse and store the extra fields a search row already carries (`extracted_old_price`, `more_buying_choices` price and count) on the listing; record a part's Renewed listing from the same results only when the title names the part's model as a whole token and states its brand (Renewed rows stay rejected as the match; they become a labelled option); parse `purchase_options.buy_new` (price, sold by, ships from) when Verify reads a listing's page; the catalog entry keeps a Home Depot standalone price; the report builds `prices` and `range`. Lowest = each part's lowest option, $0 where none; highest = each part's highest. Tests on recorded responses and the validation set; no estimate becomes more certain than its label; the 216 pairs and the validation replay unchanged for `amazonNew`.

**Task 2 (Sonnet): Home Depot part prices, free.** `readPartPrices` in the extension's reader: Home Depot's own search for the model inside the doorway tab (as pages are read), the product page's `pricing(…).value`, one id per model, the same pause and refusal rules, its own per-scan cap; the runner calls it for parts with no Home Depot price or an old one (freshness setting). Tests with fakes and the replay server.

**Task 3 (Sonnet): panel and CSV.** Deals shows the range ("−6% to +183%") with the Amazon New figure as today; Sort gains Lowest ROI and Highest ROI; Detail lists each part's prices with their labels, condition, seller and links ("Amazon · New · featured", "Amazon · lowest of 37+ used & new offers", "Home Depot · New · sold alone", "Amazon Buy Box · Sold by X, ships from Amazon"); Verify's cost line stays; CSV gains `roi_lowest`, `roi_amazon_new`, `roi_highest`. Every figure labelled an estimate.

**Task 4 (controller): validation.** Home Depot standalone prices for the validation parts read in the owner's Chrome into `fixtures/validation/hd-part-prices-2026-11-18.json`; the harness reports positive counts at lowest, Amazon New and highest; QA walkthrough; docs.

## The PO's answers (Nov 18) and what they change
PO: "1. Depends, I try to not to remove anything from OEM packaging but some tools have listings named (bulk packaging) or state in the description that it is repackaged, so just look for listings that say New, no used or refurbished listings. 2. No, those are usually amazons liquidations so price is way different. 3. I would try to pinpoint the value to eBay or Facebook marketplace (eBay is more helpful at figuring out what price is actually receiving volume)."

- Only New sell prices count. Renewed and the mixed used-and-new "more buying choices" price are dropped from every ROI.
- "(bulk packaging)" / "repackaged" New listings are acceptable for tools that come loose from a kit; the matcher must not reject them for that wording (to verify).
- eBay sold-New prices (the price that actually moves) value parts with no Amazon New listing; Facebook Marketplace has no data source and is out. A new task, after the SerpApi eBay engine's sold and condition filters are confirmed from its docs; recording costs one search per part (owner approves the count).
- Home Depot's price is a labelled reference, never a sell price in an ROI; so is Amazon's list price.
- Range: lowest = Amazon New only ($0 where none); likely = Amazon New, else eBay sold New; highest = each part's better counting price.

## eBay: where it stands (Nov 18)
- SerpApi's eBay engine no longer filters to sold listings (`show_only` Sold/Complete deprecated).
- eBay's website shows sold listings only signed in, and showed a "verify yourself" check to automated reading: not used (no bot-check evasion).
- eBay Finding API (`findCompletedItems`) was decommissioned in Feb 2025 (secondary sources).
- Marketplace Insights API (sold prices) is limited release (invitation, business case): the PO's call.
- **Chosen next:** the owner is applying for an eBay developer account (one business day). Then one test call to the Browse API (open to any developer with a client-credentials token, basic scope — confirmed on its getItem page) to confirm what it returns, especially `estimatedSoldQuantity` (unconfirmed); then design the eBay option on it. The manual "check eBay sold" link with an owner-entered price stays a fallback.
- The owner's last instruction for this session: "just finish whatever you have now and we can continue later" — phase 1 (Tasks 1–4) and the bulk-packaging wording; eBay after the keys.

## Where this stands (2026-11-18, end of session)
Phase 1 is on main. Controller gate: typecheck clean, 956 core and 762 extension tests, validation and corpus tests, e2e 53 of 53.
- Labelled sell prices per part, New only (`amazon_new`, `amazon_buybox` incl. a one-seller page's only offer); Amazon list price and Home Depot's own price as references; ROI range lowest / Amazon New / highest (Opus, Opus review, fix round, re-check).
- Home Depot part prices read free in the owner's browser, in their own store, never a splitting fact (Sonnet reader; Opus fix round; re-check).
- New bulk-packaged and repackaged listings may be chosen (Opus, Opus review).
- Panel: the range under the headline, two range sorts, the grouped price list (counted, then "Reference · not counted"), CSV columns (Sonnet; UI review, fix round).
- A real defect found and fixed: the reader's tab was sometimes sent to Home Depot while its blank page was still loading, Chrome dropped it, and the scan waited 30 s ("The Home Depot tab did not load."). It now waits for the blank page (Opus, systematic debugging, controlled experiment 3/120 → 0/120).
- Validation: still 1 of 31 positive at every end of the range on the recorded data — the range opens only where a Buy Box is read, and the parts that hold the value (review answers, the B-form searches, kit contents, eBay) are the next phases.

Next, in order: eBay through the Browse API once the owner's developer keys arrive (one test call first); BOGO promotions (A1–A2) and skipping non-deals (A3); searching the RYOBI tool-only B form (B2) and naming kit contents (B3). Open for the owner: the packaging question still says Amazon's New needs factory packaging and now only sets a tag — keep, reword or remove.
