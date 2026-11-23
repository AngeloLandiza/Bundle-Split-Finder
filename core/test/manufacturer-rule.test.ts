import { describe, expect, it } from 'vitest';

import { MANUFACTURER_ALIASES, makerAgrees, makerReading } from '../src/keepa/brandAliases';
import { checkListingFields } from '../src/keepa/listingFields';
import { checkIdentity } from '../src/keepa/verify';
import { checkListingJudge, type ListingJudgeRaw } from '../src/listingJudge';
import { applyCatalogCheck, catalogChecksWanted, LADDER_VERSION } from '../src/scan/catalogCheck';
import { wantedFor } from '../src/scan/classify';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { manufacturerValues, measureManufacturerRule, replayScan5Deals, scan5MakerRows } from '../../scripts/measure-autoconfirm';
import { measureIdentity } from '../../scripts/measure-identity';

// The manufacturer rule (core/src/keepa/brandAliases.ts makerAgrees) on the owner's fifth scan
// (fixtures/e2e-2026-11-23/after-scan5): the listings a catalog check held for their manufacturer field, as the scan
// stored them (title, brand) with the manufacturer the recorded check quotes. No network.

const scan5 = scan5MakerRows();
const listing = (asin: string) => scan5.find((r) => r.asin === asin)!.listing;
const want = (model: string) => wantedFor('RYOBI', model, new Map());

describe('the manufacturer rule', () => {
  it('the table: TTI for RYOBI with its listings; the brand plus "Tools" and nothing wider', () => {
    expect(MANUFACTURER_ALIASES.RYOBI!.map((a) => a.maker)).toEqual(['TTI']);
    expect(MANUFACTURER_ALIASES.RYOBI![0]!.evidence[0]).toBe('B09HDZ5MPV (PBP004, right)');
    expect(MANUFACTURER_ALIASES.DEWALT).toBeUndefined();
    expect(makerReading('RYOBI', 'RYOBI Tools').as).toBe('company');
    expect(makerReading('RYOBI', 'Ryobi tools').as).toBe('company');
    expect(makerReading('DEWALT', 'DEWALT Tools').as).toBe('company');
    for (const other of ['RYOBI Power Tools', 'RYOBI Tools Inc', 'Ryobi Co', 'Partyreal', 'Tools']) expect(makerReading('RYOBI', other).as).toBe('other');
    expect(makerReading('DEWALT', 'TTI').as).toBe('other');
    expect(makerAgrees('RYOBI', 'TTI', { makers: false })).toBe(false);
    expect(makerAgrees('RYOBI', null)).toBe(true);
  });

  it('the recorded listings: what the fifth scan read, word for word, before the rule', () => {
    expect(scan5.map((r) => [r.model, r.asin, r.listing.manufacturer])).toEqual(expect.arrayContaining([
      ['PBP004', 'B09HDZ5MPV', 'TTI'], ['PCG002', 'B0B1QRQYK2', 'RYOBI Tools'], ['PCL031B', 'B0CRFS4F6G', 'TTI'],
    ]));
    // The stored reason comes back exactly when the part number field is the part's (the check reached its maker test).
    expect(checkListingFields(want('PBP004'), { ...listing('B09HDZ5MPV'), partNumber: 'PBP004' }, { makers: false }).reason)
      .toBe("Amazon's catalog lists brand RYOBI but manufacturer TTI; its title names PBP004, but the listing's manufacturer is TTI");
  });

  it('confirms PBP004, PCG002 and PCL031B on their recorded listings, saying why', () => {
    expect(checkListingFields(want('PBP004'), listing('B09HDZ5MPV'))).toMatchObject({
      status: 'confirmed', rule: 'title', reason: "Amazon's catalog lists brand RYOBI, and its title names PBP004; manufacturer TTI: TTI (Techtronic Industries) makes RYOBI",
    });
    expect(checkListingFields(want('PCG002'), listing('B0B1QRQYK2'))).toMatchObject({
      status: 'confirmed', reason: "Amazon's catalog lists brand RYOBI, and its title names PCG002; manufacturer RYOBI Tools: RYOBI's own name",
    });
    expect(checkListingFields(want('PCL031B'), listing('B0CRFS4F6G')).status).toBe('confirmed');
    // Rung 0 with the part number the check had read.
    expect(checkIdentity(want('PCL031B'), { ...listing('B0CRFS4F6G'), partNumber: 'PCL031B' })).toEqual({
      status: 'confirmed', reason: "Amazon's catalog lists brand RYOBI, part number PCL031B; manufacturer TTI: TTI (Techtronic Industries) makes RYOBI",
    });
  });

  it('anything else stays as it was: an unrelated manufacturer holds, another brand field still contradicts', () => {
    // B08L38QFFW, recorded: brand RYOBI, manufacturer Partyreal, part number PSBDD01.
    const partyreal = measureIdentity().rows.find((r) => r.asin === 'B08L38QFFW' && r.model === 'PSBDD01')!;
    expect(checkListingFields(partyreal.want, partyreal.listing)).toMatchObject({ status: 'unknown', reason: "Amazon's catalog lists brand RYOBI but manufacturer Partyreal; its title names PSBDD01, but the listing's manufacturer is Partyreal" });
    expect(checkListingFields(want('PBP004'), { ...listing('B09HDZ5MPV'), manufacturer: 'Tourmate' }).status).toBe('unknown');
    expect(checkIdentity(want('PBP004'), { ...listing('B09HDZ5MPV'), partNumber: 'PBP004', brand: 'Tolxh' })).toMatchObject({ status: 'contradicted' });
    // Every other condition stands: a pack of two is still held.
    expect(checkListingFields(want('PBP004'), { ...listing('B09HDZ5MPV'), packageQuantity: 2 }).status).toBe('unknown');
  });

  it("the listing judge's check reads the manufacturer the same way", () => {
    const raw: ListingJudgeRaw = { quotes: [{ about: 'model_number', field: 'title', quote: 'Charger PCG002' }], reason: 'The title names PCG002.', verdict: 'same' };
    const l = listing('B0B1QRQYK2');
    expect(checkListingJudge(want('PCG002'), l, raw).status).toBe('ai_checked');
    expect(checkListingJudge(want('PCG002'), l, raw, { makers: false })).toMatchObject({ status: 'cannot_tell', reason: 'the manufacturer is RYOBI Tools' });
    expect(checkListingJudge(want('PCG002'), { ...l, manufacturer: 'Partyreal' }, raw).status).toBe('cannot_tell');
  });

  it('measured: 4 listings change, 2 right, 0 wrong, 2 with no key; every value seen is listed', () => {
    const m = measureManufacturerRule();
    expect({ changed: m.changed, right: m.right, wrong: m.wrong, unknown: m.unknown }).toEqual({ changed: 4, right: 2, wrong: 0, unknown: 2 });
    const values = manufacturerValues().map((v) => `${v.brand} ${v.manufacturer} ${v.listings.length} ${v.reading}`);
    expect(values).toEqual(expect.arrayContaining(['RYOBI TTI 2 alias', 'RYOBI RYOBI Tools 2 company', 'RYOBI Partyreal 1 other']));
  });

  it('replay: the three $99 RYOBI deals become Buy now', () => {
    const r = replayScan5Deals();
    expect(r.map((d) => [d.model, d.buyNow, d.waiting])).toEqual([
      ['PSK1212SB-PCL515B', true, []], ['PSK1212SB-PCL633B', true, []], ['PSK1212SB-PCL031B', true, []],
    ]);
    expect(r[0]!.after).toBe('Worth buying now: +$43.19 (43.6% ROI), sells about 200 a month, its listings confirmed now.');
  });

  it('a stored unknown from ladder 2 is read again once, and the title match is verified', async () => {
    const store = new MemoryScanStore();
    await store.putMatch({
      key: 'RYOBI:PBP004', brand: 'RYOBI', model: 'PBP004', status: 'matched', asin: 'B09HDZ5MPV', grade: 'probable', alternatives: [], decidedBy: 'auto', updatedAt: 1, waitingSince: null,
      catalogChecks: [{ asin: 'B09HDZ5MPV', status: 'unknown', reason: "Amazon's catalog lists brand RYOBI but manufacturer TTI; its title names PBP004, but the listing's manufacturer is TTI", at: 1, ladder: 2 }],
    });
    const parts = new Map([['RYOBI:PBP004', { saving: 10 }]]);
    expect(await catalogChecksWanted(store, parts)).toEqual([expect.objectContaining({ asin: 'B09HDZ5MPV', recheck: true })]);
    await applyCatalogCheck({ store, catalog: new Map(), now: () => 5 }, listing('B09HDZ5MPV'));
    expect(await store.getMatch('RYOBI:PBP004')).toMatchObject({
      grade: 'strong', verifiedBy: 'listing_fields',
      catalogChecks: [expect.objectContaining({ status: 'confirmed', ladder: LADDER_VERSION })],
    });
    expect(await catalogChecksWanted(store, parts)).toEqual([]);
  });
});
