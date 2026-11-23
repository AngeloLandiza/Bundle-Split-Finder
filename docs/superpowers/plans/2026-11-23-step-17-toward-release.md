# Step 17: toward a build Alex can use

**Owner (Nov 23):** "Do more improvements till this is perfect."

## What a check of the live app showed first
The best real deal (DCK225D2WCS369B, $269, about +$69, 25.7% ROI on catalog-verified listings) had no buy signal at
all: signals were judged only inside a scan, and the estimate came from the between-scan drip. Keepa's sales volume and
FBA fee were not kept from drip pulls, and every estimate assumed $0 fulfillment.

## Done (each entry in docs/decisions.md)
- **Buy signals wherever an estimate changes** (drip, catalog check, owner's answer, Undo, confirmed price, start), with
  the same once-a-day rule; every Keepa pull keeps monthly sold, FBA fee, referral %, rank.
- **Realistic fees:** the main estimate uses Amazon's FBA fee from Keepa by default; an estimate missing a fee is
  labelled "before fulfillment for N of M parts", sorts after full ones and is never a buy; fee pulls for every part
  that counts (1 token each). On the third scan's data the count above zero goes from 3 to 0.
- **Security review** (docs/security-review-2026-11-23.md): no Critical; one Important fixed (eBay error text cut
  before keys were removed); four Minor fixed; six Minor listed.
- **UX critique on real data:** Today leads with the best deals and their verdicts; reseller wording for listing
  states; inspector ordered by decision; Activity as sentences by day with Undo; contrast measured and raised.
- **Runs by itself:** a welcome step recommending a schedule from the real budget (250 a month, 100 reserve, Keepa:
  "Daily at 7:00", about 120 a month); keep awake during a scan; a Telegram test message.
- **Settings › Data:** Export audit file (fails closed if a key value appears) and Reset scan data (backup first).
- **Tests reliable under load** (60 s limits, event waits instead of sleeps): three full runs pass with the machine busy.
- **Windows check prepared:** .github/workflows/windows-smoke.yml and scripts/windows-smoke.ps1 — not pushed, not run.
- **docs/guide.md:** the getting-started guide for the daily user.

## Not done, and why
- The Windows build has not run on a real PC; the smoke workflow needs a push and a manual start by the owner.
- The Mac window has not been looked at outside full screen (the app sat on its own Space while the owner worked).
- The installers are unsigned.
- eBay still rejects the owner's keys; the app now passes eBay's own words through after the next scan.
- Paid follow-up asks and "ask again on new evidence" stay off: measured, no gain.
- Worktrees from this session's builders are still registered under .claude/worktrees/ (their branches are merged).
