// npx tsx scripts/replay-fees.ts [data folder]. Free, no network, writes nothing.
// Signals round 3 replayed on a data folder (default: fixtures/e2e-2026-11-23/after-scan3): the deals rebuilt with the
// fee settings' default (fees.fulfillmentSource 'keepa') and the Keepa figures the owner's app had stored
// (store/tracking.json: each part's FBA fee in `derived.fba`, the pulled parts in the signals' velocity), then judged with
// the owner's numbers ($20, 20%, 50 a month). Prints how many complete estimates count every fulfillment fee and how many
// are before fulfillment, the Keepa tokens the drip's fee pulls would take (1 a listing), and the Deals order's top 8 with
// each row's verdict line. Every figure is an estimate from the fee settings, not the seller's real fees.

import { join } from 'node:path';

import { defaultSettings, type StoreData } from '../agent/store';
import { dealsResponse } from '../agent/views';
import { feePullsWanted } from '../agent/signalsPass';
import type { PartTrend } from '../core/src/keepa/trends';
import { buildReport, fulfillmentGap } from '../core/src/scan/report';
import { DEFAULT_SCAN_SETTINGS } from '../core/src/scan/types';
import { emptyTracking, retrackReport, type TrackingState } from '../core/src/tracking/state';
import { loadScanFolder, readStoreFile } from './data-folder';
import { ROOT } from './node-store';

const DIR = process.argv[2] ?? join(ROOT, 'fixtures', 'e2e-2026-11-23', 'after-scan3');
const store = await loadScanFolder(DIR);

const deals = readStoreFile<StoreData['deals']>(DIR, 'deals.json', { at: null, bundles: [], auditAt: null, auditBundles: [], lookups: {} } as StoreData['deals']);
const tracking = readStoreFile<StoreData['tracking']>(DIR, 'tracking.json', { ...emptyTracking(), derived: { bogo: {}, fba: {}, groups: {} } } as StoreData['tracking']);
const review = readStoreFile<StoreData['review']>(DIR, 'review.json', { at: null, questions: [], ebayQuestions: [], evidence: {} } as StoreData['review']);
const now = deals.at ? Date.parse(deals.at) : Date.now();

// The Keepa figures the app had stored: a trend for every listing it had pulled.
const asinOf = new Map((await store.listMatches()).flatMap((m) => (m.asin ? [[m.model, m.asin] as const] : [])));
const trends = new Map<string, PartTrend>();
const base = (asin: string): PartTrend => trends.get(asin) ?? { asin, amazonPrice: null, salesRank: null, offerCount: null, pulledAt: now, monthlySold: null, fbaFee: null };
for (const s of Object.values(tracking.signals)) {
  for (const o of s.options) for (const p of o.velocity.parts) if (p.asin && p.pulledAt !== null) trends.set(p.asin, { ...base(p.asin), monthlySold: p.monthlySold, salesRank: p.salesRank, pulledAt: p.pulledAt });
}
for (const f of Object.values(tracking.derived.fba)) {
  for (const p of f.parts) if (p.source === 'keepa' && asinOf.has(p.model)) trends.set(asinOf.get(p.model)!, { ...base(asinOf.get(p.model)!), fbaFee: p.fee });
}
const trend = (asin: string) => trends.get(asin);

const report = await buildReport(store, DEFAULT_SCAN_SETTINGS, { trend });
const settings = defaultSettings();
const alerts = { ...settings.alerts, minProfit: 20, minRoiPercent: 20, minMonthlySold: 50 };
const judged = retrackReport(tracking as TrackingState, report, trend, alerts, now, { keepa: true, flatFee: settings.settings.fees.fulfillmentFee }).state;

const complete = report.bundles.filter((b) => b.estimate !== null);
const before = complete.filter((b) => fulfillmentGap(b.parts.filter((p) => !b.uncovered.includes(p.model))).before.length > 0);
const pulls = feePullsWanted(report.bundles, trend, now, DEFAULT_SCAN_SETTINGS.freshnessMs);
console.log(`Keepa trends stored: ${trends.size} listings (${[...trends.values()].filter((t) => t.fbaFee != null).length} with an FBA fee).`);
console.log(`Complete estimates: ${complete.length}; with Amazon's FBA fee for every part: ${complete.length - before.length}; before fulfillment for some part: ${before.length}.`);
console.log(`Fee pulls the drip would make: ${pulls.length} listings, ${pulls.length} Keepa tokens (1 each, above the reserve).`);

const data = {
  deals: { ...deals, bundles: report.bundles }, review: { ...review, questions: report.review }, settings: { ...settings, alerts },
  runtime: { lastJob: null, serp: null, keepa: null } as unknown as StoreData['runtime'], tracking: { ...tracking, ...judged } as StoreData['tracking'],
};
const rows = dealsResponse(data, { sort: 'profit' }, now).rows;
console.log('\nDeals, by estimated profit (top 8):');
for (const r of rows.slice(0, 8)) {
  const est = r.profit === null ? 'no estimate' : `${r.profit < 0 ? '-' : '+'}$${Math.abs(r.profit).toFixed(2)}`;
  const fee = r.beforeFulfillment ? ` [before fulfillment for ${r.beforeFulfillment.parts} of ${r.beforeFulfillment.of}]` : '';
  console.log(`  ${r.bundle.brand} ${r.bundle.model}  $${r.price}  ${est}${fee}\n    ${r.signalNote ?? '(no verdict)'}`);
}
