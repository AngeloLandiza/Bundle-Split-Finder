// The owner's after-scan3 deals as the agent now sends them once fees are counted per part (signals round 3). The figures are
// the replay table in docs/decisions.md ("Replayed on after-scan3", `scripts/replay-fees.ts`, with the 3 FBA fees his app had
// stored): those eight rows with their replayed profit and how many parts still have no fulfillment fee. The sentences are
// worded as the agent words them ("before fulfillment for 1 of 2 parts — Keepa is asked next"). Rows the replay table does not
// list are left as the scan stored them. Mock data only: labelled here, never in the app.

import type { DealDetail, DealRow } from './types';

interface Replay {
  profit: number;
  parts: number;
  of: number;
  /** The part with no fee yet, for the basis sentence. */
  none: string;
}

/** Replayed profit by model (docs/decisions.md, Signals round 3). */
const REPLAY: Record<string, Replay> = {
  DCK540D1WCS382B: { profit: -0.94, parts: 2, of: 2, none: 'both parts' },
  DCK540D1WCS565B: { profit: -7.11, parts: 2, of: 2, none: 'both parts' },
  DCK540D1WCB1404: { profit: -7.7, parts: 2, of: 2, none: 'both parts' },
  'PCL1201K2-PCL424B': { profit: -8.38, parts: 1, of: 2, none: 'PCL424B' },
  'PCL1201K2-P755': { profit: -11.75, parts: 1, of: 2, none: 'P755' },
  'PCL1201K2-PCL445B': { profit: -13.69, parts: 1, of: 2, none: 'PCL445B' },
  DCK540D1WDCB606: { profit: -14.83, parts: 2, of: 2, none: 'both parts' },
  'PCL1201K2-PCL515B': { profit: -15.15, parts: 1, of: 2, none: 'PCL515B' },
};

/** The same rows before the fee pulls changed them: the scan's stored profit, three of them above zero, all before fulfillment. */
const EARLY: Record<string, Replay> = {
  'PCL1201K2-PCL424B': { profit: 6.63, parts: 1, of: 2, none: 'PCL424B' },
  'PCL1201K2-P755': { profit: 3.26, parts: 1, of: 2, none: 'P755' },
  'PCL1201K2-PCL445B': { profit: 1.32, parts: 1, of: 2, none: 'PCL445B' },
};

const dollars = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;

function noteOf(x: Replay): string {
  const why = `before fulfillment for ${x.parts} of ${x.of} parts — Keepa is asked next`;
  return x.profit < 20 ? `Not worth buying now: est. ${dollars(x.profit)} is below your $20, and ${why}` : `Not worth buying now: ${why}`;
}

const basisOf = (x: Replay): string =>
  x.parts === x.of
    ? `Before fulfillment for ${x.of} of ${x.of} parts: Keepa has not been asked about their listings yet. 15% referral (at least $0.30); 0% tax; $0.00 inbound. An estimate, not your real Amazon fees.`
    : `Before fulfillment for ${x.parts} of ${x.of} parts: Amazon's FBA fee from Keepa for PCL1201K2 ($15.01); none yet for ${x.none}: Keepa has not been asked about its listing. 15% referral (at least $0.30); 0% tax; $0.00 inbound. An estimate, not your real Amazon fees.`;

/** Apply the replay (or the early figures) to the mock's rows and details, in place. */
export function applyFees(deals: DealRow[], details: Record<string, DealDetail>, table: 'replay' | 'early'): void {
  const by = table === 'replay' ? REPLAY : EARLY;
  for (const r of deals) {
    const x = by[r.model];
    if (!x) continue;
    const cost = details[r.id]?.estimate?.cost ?? r.price ?? 0;
    const roi = cost > 0 ? Number((x.profit / cost).toFixed(4)) : (r.roi ?? 0);
    r.profit = x.profit;
    r.roi = roi;
    r.beforeFulfillment = { parts: x.parts, of: x.of };
    r.signalNote = noteOf(x);
    r.buyNow = false;
    const d = details[r.id];
    if (!d) continue;
    d.signalNote = r.signalNote;
    d.beforeFulfillment = r.beforeFulfillment;
    if (d.estimate) d.estimate = { ...d.estimate, profit: x.profit, roi, afterFees: Number((d.estimate.cost + x.profit).toFixed(2)), basis: basisOf(x) };
  }
}
