# The owner's real app data after two scans (Nov 23 2026)

Copied from the installed app's data folder after the first two end-to-end scans (no keys: checked against the key
store before copying). `scan/` is the scan store (bundles with their read pages, catalog, matches, part prices,
reviews, the two scan jobs); `store/` is the agent's review questions, AI suggestions and activity.

What it shows:
- Scan 1: the first page fetch came back without its state; every bundle became a "Which parts" question (fixed).
- Scan 2: 16 bundle pages, 3 kit pages, 40 part prices and the BOGO listings read; 53 bundles; 38 waiting for
  Amazon lookups; 15 "Which parts" questions, all "AI unsure"; 0 estimates. The Amazon step did nothing:
  with a Keepa key lookups go only through Keepa, one lookup is estimated at 30 tokens and the per-scan cap is 5
  (`keepaPlan: {discoveryTokens: 4, lookups: 0}`), while 17 of the 18 SerpApi searches allowed went unused. The run
  ended `run_cap` and the app said "Scan stopped at your search limit".
- Questions that should not be questions: BOGO pairs (PCL1201K2-FVC51K …) whose split the pair rule already gives;
  hyphen bundles whose halves Home Depot sells under exactly those models (partPrices.json); AI answers rejected for
  "The bundle states 6 tools; the parts hold 7" on "6-Tool Combo Kit … and Miter Saw".

## after-scan3/ (same day, after the step 15 fixes)
The third real scan: 4 minutes, 16 searches, 59 bundles, 32 with an estimate (34 a few minutes later, as the Keepa drip
went on), 10 open questions, AI $0.13. What it shows next: the best estimate is +$6.63 on a $179 BOGO pair at $0
fulfillment; 26 bundles sit in "Losing money", many at -100% because a part with no price yet is counted at zero
(`estimate.countedAtZero`: DCK200D1P1 in 10 bundles, PCL1600K2 in 4, …), which is not an estimate of anything.

Read again with the rule that followed ("An estimate exists only when every part the owner must sell has a counted price",
docs/decisions.md): 13 complete estimates (3 above zero) and 39 bundles missing a price, each with its break-even.
`npx tsx scripts/audit-estimates.ts` prints them; `?mock=real` in the desktop UI shows them.
