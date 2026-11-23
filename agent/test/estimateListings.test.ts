import { describe, expect, it } from 'vitest';

import { identityFromKeepa } from '../../core/src/keepa/verify';
import { applyCatalogCheck } from '../../core/src/scan/catalogCheck';
import { buildReport } from '../../core/src/scan/report';
import { knownModels } from '../../core/src/scan/split';
import { DEFAULT_SCAN_SETTINGS } from '../../core/src/scan/types';
import { loadScanFolder } from '../../scripts/data-folder';
import { AFTER_SCAN3, recordedKeepaProducts } from '../../scripts/replay-catalog';
import { listingsOf } from '../views';

// Catalog check: an estimate says how many of its parts rest on verified listings and how many on title matches. On the
// owner's third real scan (fixtures/e2e-2026-11-23/after-scan3), before and after the recorded Keepa pulls are applied.

const counted = async (store: Awaited<ReturnType<typeof loadScanFolder>>) =>
  (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.filter((b) => b.estimate !== null).map((b) => ({
    model: b.model,
    label: listingsOf(b.parts.filter((p) => !b.uncovered.includes(p.model))).listings?.label ?? null,
  }));

describe('the estimate label', () => {
  it('words the counts', () => {
    expect(listingsOf([{ grade: 'strong', verifiedBy: 'keepa_catalog', asin: 'A' }, { grade: 'probable', verifiedBy: 'title', asin: 'B' }]).listings).toEqual({
      verified: 1, titleMatches: 1, label: '1 part on a verified listing, 1 on a title match.',
    });
    expect(listingsOf([{ grade: 'probable', asin: 'A' }, { grade: 'probable', asin: 'B' }]).listings!.label).toBe('2 parts on title matches.');
    expect(listingsOf([{ grade: null, verifiedBy: 'owner', asin: 'A' }, { grade: 'exact', asin: 'B' }]).listings!.label).toBe('2 parts on verified listings.');
    expect(listingsOf([{ grade: null, asin: null }])).toEqual({});
  });

  it('on the third scan: the recorded pulls of PCL235, DCB606 and DCF921B move their estimates\' parts from title matches to verified', async () => {
    const store = await loadScanFolder(AFTER_SCAN3);
    const before = await counted(store);
    const { catalog } = await knownModels(store);
    for (const p of recordedKeepaProducts().values()) await applyCatalogCheck({ store, catalog, now: () => Date.UTC(2026, 10, 23, 18) }, identityFromKeepa(p));
    const after = await counted(store);
    // 13 complete estimates; of the three recorded pulls only DCB606 is a part of one of them (PCL235 and DCF921B are in
    // bundles still missing a price). The six DCK540D1 estimates keep resting on DCK540D1's title match.
    expect(before).toHaveLength(13);
    expect(after.map((a) => a.model)).toEqual(before.map((b) => b.model));
    const changed = after.filter((a, i) => a.label !== before[i]!.label);
    expect(changed.map((c) => [c.model, before.find((b) => b.model === c.model)!.label, c.label])).toEqual([
      ['DCK540D1WDCB606', '2 parts on title matches.', '1 part on a verified listing, 1 on a title match.'],
    ]);
    expect(after.filter((a) => a.model.startsWith('DCK540D1')).every((a) => /title match/.test(a.label!))).toBe(true);
  });
});
