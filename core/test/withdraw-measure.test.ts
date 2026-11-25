// The audit findings the app acts on by itself (core/src/audit/withdraw.ts), measured on every answer key before they were
// adopted (scripts/measure-repick.ts; docs/decisions.md, "The app replaces a wrong listing itself"). Adopted only at zero
// right listings withdrawn. Free; no network.

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadScanFolder } from '../../scripts/data-folder';
import { measureRepick } from '../../scripts/measure-repick';
import { sanityFindings } from '../src/audit/sanity';
import { certainWithdrawals, titleNamesAnother, twoModelsWithdraws } from '../src/audit/withdraw';
import { AFTER_SCAN5, dealsOf, FIXTURES, storedDeals, storeWithWrongListing, WRONG_SET } from './sanity-world';

const AFTER_SCAN6 = join(FIXTURES, 'e2e-2026-11-23', 'after-scan6');

describe('the measurement: no right listing withdrawn on any answer key', () => {
  const rows = measureRepick();
  const row = (population: string, rule: string) => rows.find((r) => r.population === population && r.rule === rule)!;

  it('the title rule: 804 labelled search rows and the Nov 24 backpack withdrawn, every one not the part', () => {
    expect(row('validation rows', 'title')).toMatchObject({ read: 1325, withdrawn: 804, right: 0, wrong: 804 });
    expect(row('validation counted', 'title')).toMatchObject({ withdrawn: 0, right: 0 });
    expect(row('corpus', 'title')).toMatchObject({ read: 279, withdrawn: 0, right: 0 });
    expect(row('Nov 24 (B0DGLWKS9S)', 'title')).toMatchObject({ withdrawn: 1, right: 0, wrong: 1 });
  });

  it('the two-models rule: only B0FD253MKS in the owner\'s sixth scan, for both vacuums; no listing a key marks right for two models', () => {
    expect(row("owner's after-scan6", 'two models')).toMatchObject({ read: 71, withdrawn: 2, right: 0, wrong: 2, unkeyed: 0 });
    for (const s of ['after-scan3', 'after-scan5']) expect(row(`owner's ${s}`, 'two models')).toMatchObject({ withdrawn: 0 });
    expect(row('validation counted', 'two models')).toMatchObject({ withdrawn: 0 });
    expect(row('corpus, every right listing counted', 'two models')).toMatchObject({ read: 30, withdrawn: 0 });
    expect(row('labels: one listing right for two models', 'two models').notes).toEqual([]);
    // The exposure if a right listing were also counted, by a mistake elsewhere, for another model: P119's charger names
    // P100 and P101. Not seen in any store; a use a rung confirmed is spared, and the owner is asked with it offered first.
    expect(row('right listings, if also counted for another model', 'two models')).toMatchObject({ read: 26, withdrawn: 1 });
    for (const r of rows.filter((x) => x.population !== 'right listings, if also counted for another model')) expect(r.right).toBe(0);
  });
});

describe('certainWithdrawals on the real deals', () => {
  it('after-scan6: B0FD253MKS for PCL700B and PCL702B (one each, whatever the number of deals); the price and estimate holds stay holds', () => {
    const deals = storedDeals(AFTER_SCAN6);
    const found = sanityFindings(deals);
    const w = certainWithdrawals(found, deals);
    expect(w.map((x) => [x.model, x.asin, x.kind])).toEqual([['PCL700B', 'B0FD253MKS', 'listing_two_models'], ['PCL702B', 'B0FD253MKS', 'listing_two_models']]);
    expect(w[0]!.reason).toBe('The same Amazon listing is counted for PCL700B and for PCL702B; one listing cannot be both.');
    // The price ratio (4.04) and the estimate (too good) on PCL702B's bundle are not certain on their own: never acted on.
    expect(found.filter((f) => f.kind === 'price_vs_home_depot' || f.kind === 'too_good').length).toBeGreaterThan(0);
  });

  it('the Nov 24 case: the backpack withdrawn for DWST08017 by its title', async () => {
    const deals = await dealsOf(await storeWithWrongListing());
    const w = certainWithdrawals(sanityFindings(deals), deals);
    expect(w).toEqual([expect.objectContaining({ bundleId: WRONG_SET, model: 'DWST08017', asin: 'B0DGLWKS9S', kind: 'title_other_model' })]);
  });

  it('after-scan5 rebuilt: PCL702B\'s two-tool listing is a title_extra_model hold only (counted once), never withdrawn', async () => {
    const deals = await dealsOf(await loadScanFolder(AFTER_SCAN5));
    expect(certainWithdrawals(sanityFindings(deals), deals)).toEqual([]);
  });

  it('a listing the owner chose, or "This is right", is never withdrawn', () => {
    const deals = storedDeals(AFTER_SCAN6);
    const owned = deals.map((b) => ({ ...b, parts: b.parts.map((p) => (p.asin === 'B0FD253MKS' ? { ...p, verifiedBy: 'owner' as const } : p)), options: b.options.map((o) => ({ ...o, parts: o.parts.map((p) => (p.asin === 'B0FD253MKS' ? { ...p, verifiedBy: 'owner' as const } : p)) })) }));
    expect(certainWithdrawals(sanityFindings(owned), owned)).toEqual([]);
    const cleared = sanityFindings(deals, { cleared: ['listing|RYOBI:PCL700B|B0FD253MKS', 'listing|RYOBI:PCL702B|B0FD253MKS'] });
    expect(certainWithdrawals(cleared, deals)).toEqual([]);
  });

  it('the pieces', () => {
    expect(titleNamesAnother('DEWALT', 'DWST08017', 'DWST60122-1 Dewalt Pro Backpack x McLaren F1 Team, Limited Edition')).toBe(true);
    expect(titleNamesAnother('RYOBI', 'PCL702B', 'RYOBI ONEAND 18V Cordless Wet/Dry Hand Vacuum Tool ONLY PCL702B')).toBe(false);
    // A kit's listing names its tools: never withdrawn for being counted for a tool of it too.
    expect(twoModelsWithdraws('DEWALT', 'DCD794', ['DCK225D2'], '20V MAX 2-KIT DCK225D2: DCD794 Drill, DCF809 Impact Driver')).toBe(false);
    // A title naming the part alone: the other model's count is the mistake.
    expect(twoModelsWithdraws('RYOBI', 'PCL702B', ['PCL700B'], 'RYOBI ONEAND 18V Cordless Wet/Dry Hand Vacuum Tool ONLY PCL702B')).toBe(false);
    expect(twoModelsWithdraws('RYOBI', 'PCL700B', ['PCL702B'], 'RYOBI 18V Cordless Hand Vacuums PCL700B & PCL702B (Tools Only)')).toBe(true);
    // RYOBI twins are one model.
    expect(twoModelsWithdraws('RYOBI', 'PCL515B', ['PCL515'], 'ONE+ 18V Cordless Reciprocating Saw')).toBe(false);
  });
});
