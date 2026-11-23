# Step 15: what the first real runs showed, and the fixes

**Owner (Nov 23):** "is this a good product? did you do real e2e testing? … do a full walkthrough as if you are a user
and fix anything that doesn't make sense or is too many clicks or is broken … follow the best UI/UX practices, research
them." Testing scope for this step: real runs in the installed app with the owner's budget (25 searches; the reserve
leaves 22), plus typecheck and unit tests.

## What two real scans showed (fixtures/e2e-2026-11-23/)
1. Scan 1 died on the first page read and turned 16 bundles into questions. **Fixed** (doorway state, `waiting_page`,
   Read pages again, helper build check).
2. Scan 2 read everything (16 pages, 40 part prices, BOGO listings, 13.5 minutes) and still gave **0 estimates**:
   - With a Keepa key, Amazon lookups go only through Keepa; a lookup is estimated at 30 tokens and the default
     per-scan cap is 5, so none can ever run. 17 SerpApi searches allowed went unused. The app said "stopped at your
     search limit".
   - Recorded Keepa facts: the account refills 1 token a minute (bucket about 60); a search costs 10 tokens and
     returns the products with their data. So Keepa gives about 144 lookups a day at no extra cost; SerpApi gives 250
     a month.
   - 15 of 53 bundles are "Which parts" questions, all "AI unsure": BOGO pairs whose split the pair rule already
     gives; hyphen bundles whose halves Home Depot sells under exactly those models; AI answers rejected for "states 6
     tools; the parts hold 7" on "6-Tool Combo Kit … and Miter Saw".
   - 9 of the 13.5 minutes went to Home Depot part prices, before the Amazon step that produces estimates.
3. UI: the running step is not marked and has no count; "estimating time left" never becomes a number; 38 rows each
   carry a "Look up · 2 searches" button; the AI's suggestion is a separate box (not the preselected choice) and hides
   the quotes it found; eBay keys were rejected and only a Deals banner says so; Keepa tokens are never shown.

## Decisions
1. **A lookup never waits when any budget can pay for it.** Order per scan: Keepa tokens the account has above its
   reserve; then SerpApi within the per-scan cap and the monthly reserve; the rest waits. The per-scan Keepa cap
   default becomes "what the account has above the reserve" (0 = automatic). A lookup's Keepa estimate is what the
   recording shows (10), not 30.
2. **Lookups drip between scans.** While parts wait and Keepa refills, the agent looks up the next part on its own
   (no SerpApi), in value order, and re-estimates; one digest line when new estimates appear. Off switch in Settings.
3. **Amazon before Home Depot part prices** in the scan; part prices are capped by time, and continue later.
4. **Fewer questions, never a guess (rule 4):** a BOGO pair's split is the pair rule's; a hyphen or "W" split is
   settled when Home Depot itself sells each half under exactly that model and brand (the free part-price read) and
   the page contradicts nothing; "N-Tool Combo Kit … and X" counts N for the kit half only. Each rule is measured on
   the validation set and the real fixture: zero wrong, or it is not adopted. A part with no Amazon listing is "no
   Amazon listing found", not a question about the split.
5. **Review is one key per question** (HAX G7–G9, PAIR): the AI's choice is preselected, its quotes and links sit
   under it, Enter saves and moves on; "not verified" says why in plain words.
6. **Progress** follows the checklist: every step marked done / running / waiting / skipped / failed with "N of M";
   a time figure only once the rate is known.

## Work (parallel, then a third real scan)
- **P1 (Opus) lookups and pipeline:** decisions 1, 2, 3; Keepa account status in state; honest stop sentences;
  the running step marked with counts; `POST /api/lookups/run`.
- **P2 (Opus) splits and verification:** decision 4, measured.
- **P3 (Sonnet) UI:** decisions 5 and 6; one "Look up all" action in place of 38 row buttons; a row's one-line
  reason; key problems beside the key in Settings; Keepa tokens in the status block.
Then: rebuild both installers, third real scan (owner's remaining searches), walkthrough against docs/ux-checklist.md.
