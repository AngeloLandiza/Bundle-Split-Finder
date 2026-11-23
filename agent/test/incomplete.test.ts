import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadScanFolder, readStoreFile } from '../../scripts/data-folder';
import { DEFAULT_FEES } from '../../core/src/money';
import { buildReport } from '../../core/src/scan/report';
import { DEFAULT_SCAN_SETTINGS } from '../../core/src/scan/types';
import { dealDetail, dealsResponse } from '../views';

// Nov 23, the owner's third real scan (fixtures/e2e-2026-11-23/after-scan3), through the agent's own views: a bundle
// missing a price has no headline profit, and says what is priced, the break-even, and what moves each part forward.

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan3');
const NOW = Date.UTC(2026, 10, 23, 14);

async function data() {
  const report = await buildReport(await loadScanFolder(DIR), DEFAULT_SCAN_SETTINGS);
  const review = readStoreFile(DIR, 'review.json', { at: null, questions: [], ebayQuestions: [], evidence: {} });
  return {
    deals: { at: null, bundles: report.bundles, auditAt: null, auditBundles: [], lookups: {} },
    review: { ...review, questions: review.questions, ebayQuestions: [] },
    runtime: { lastJob: null },
    settings: { settings: { fees: DEFAULT_FEES, searchesPerScan: 20 }, alerts: {} },
  } as never;
}

describe('a deal missing a price, in the agent\'s views', () => {
  it('the row has no profit or ROI, and carries the priced count and the break-even; complete rows stay on top', async () => {
    const res = dealsResponse(await data(), { sort: 'profit' }, NOW);
    const row = res.rows.find((r) => r.bundle.model === 'DCK200D1P1W921B')!;
    expect(row).toMatchObject({ profit: null, roi: null, roiRange: { low: null, high: null } });
    expect(row.incomplete).toEqual({ priced: 1, total: 2, pricedNet: 140.25, breakEvenNet: 158.75, breakEvenPrice: 186.76, unpriced: ['DCK200D1P1'] });
    // No row both has a profit and is missing a price.
    expect(res.rows.filter((r) => r.profit !== null && r.incomplete)).toEqual([]);
    // Within a section, the estimates first, then the bundles missing a price, the smallest break-even first.
    const missing = res.rows.filter((r) => r.section === 'missing_listing');
    const gaps = missing.filter((r) => r.incomplete).map((r) => r.incomplete!.breakEvenNet);
    expect(gaps).toEqual([...gaps].sort((a, b) => a - b));
  });

  it('the detail: an incomplete estimate in place of the estimate, each unpriced part with its state and its one action', async () => {
    const d = await data();
    const key = (model: string) => dealsResponse(d, { sort: 'profit' }, NOW).rows.find((r) => r.bundle.model === model)!.id;
    const kit = dealDetail(d, key('DCK200D1P1W921B'))!;
    expect(kit.estimate).toBeNull();
    expect(kit.incompleteEstimate).toMatchObject({
      priced: 1, total: 2, cost: 299, breakEvenNet: 158.75, breakEvenPrice: 186.76, notCounted: [], soldAs: null,
      // The kit's page is not read yet (only Home Depot's part page named it): the next scan, or the drip, reads it.
      parts: [{ model: 'DCK200D1P1', qty: 1, state: 'no_listing', action: 'confirm_price', questionId: null, kit: { pageRead: false, parts: null, waiting: 0 } }],
    });
    expect(kit.incompleteEstimate!.basis).toMatch(/An estimate from your fee settings, not your real Amazon fees\.$/);
    const review = dealDetail(d, key('DCK540D1WCF860B'))!;
    expect(review.incompleteEstimate!.parts).toEqual([{ model: 'DCF860B', qty: 1, state: 'review', action: 'answer', questionId: 'match:DEWALT:DCF860B' }]);
    const waiting = dealDetail(d, key('PCL1201K2-PCL430B'))!;
    expect(waiting.incompleteEstimate!.parts).toEqual([{ model: 'PCL430B', qty: 1, state: 'waiting', action: 'look_up', questionId: null }]);
    // PCL1600K2's listing is inactive and its page lists 19 parts, 3 of whose models still wait for a lookup.
    const six = dealDetail(d, key('PCL1600K2-P553'))!;
    expect(six.incompleteEstimate!.parts.find((p) => p.model === 'PCL1600K2')).toEqual({
      model: 'PCL1600K2', qty: 1, state: 'inactive', action: 'confirm_price', questionId: null, kit: { pageRead: true, parts: 19, waiting: 3 },
    });
  });

  it('a complete estimate counts no model part at $0: only items with no model number can be not counted', async () => {
    const d = await data();
    const res = dealsResponse(d, { sort: 'profit' }, NOW);
    for (const r of res.rows.filter((x) => x.profit !== null)) {
      const det = dealDetail(d, r.id)!;
      expect(det.incompleteEstimate).toBeUndefined();
      const models = new Set(det.bundle.parts.map((p) => p.model));
      expect(det.estimate!.countedAtZero.filter((m) => models.has(m))).toEqual([]);
    }
  });
});
