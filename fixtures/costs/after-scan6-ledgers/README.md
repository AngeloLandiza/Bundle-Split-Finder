# Ledgers shaped like the owner's, for the costs (step 18)

The owner's data copies (`fixtures/e2e-2026-11-23/after-*`) hold no ledgers. These two files rebuild them from
`after-scan6/store/activity.json`, in the row shapes the agent writes:

- `serpapi-ledger.jsonl`: `{at, engine, label}`, one row per search each run counted (43, as the owner's ledger has:
  the seven scans' 41 and the two Verify clicks' 2), spread evenly over the run's time.
- `keepa-ledger.jsonl`: `{at, kind, key, label, tokens, tokensLeft, refillIn, refillRate}`, each run's Keepa tokens
  (1,058 in all) as 11-token searches and 1-token product pulls, 568 rows (the owner's has about 550), refill 1 a minute.

Only the times, counts and token sums come from the real runs; the split of a run's tokens into calls and the
`tokensLeft` figures are made up in the real shape. No key: a ledger row never holds one.
