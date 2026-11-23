import { describe, expect, it } from 'vitest';

import { BRAND_ALIASES, brandAliasOf } from '../src/keepa/brandAliases';
import { checkListingFields } from '../src/keepa/listingFields';
import { checkIdentity } from '../src/keepa/verify';
import { applyCatalogCheck } from '../src/scan/catalogCheck';
import { wantedFor } from '../src/scan/classify';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { LIVE_HELD, measureBrandAliases } from '../../scripts/measure-autoconfirm';

// Brand aliases for rungs 0 and 1 (core/src/keepa/brandAliases.ts), on the two listings the owner's live deals held and
// every recorded row with a known answer. No network.

const live = (model: string) => LIVE_HELD.find((h) => h.model === model)!.listing;
const want = (model: string) => wantedFor('RYOBI', model, new Map());

describe('brand aliases', () => {
  it('the table: TTI and ONEAND for RYOBI, each with its listings; nothing for DEWALT', () => {
    expect(BRAND_ALIASES.RYOBI!.map((a) => a.alias)).toEqual(['TTI', 'ONEAND']);
    expect(BRAND_ALIASES.DEWALT).toBeUndefined();
    expect(brandAliasOf('RYOBI', 'Fire Rose')).toBeNull();
    expect(brandAliasOf('DEWALT', 'TTI')).toBeNull();
  });

  it('confirms PBP004 on B09HDZ5MPV (brand TTI) and PCG002 on B0B1QRQYK2 (brand ONEAND), saying why', () => {
    expect(checkListingFields(want('PBP004'), live('PBP004'))).toMatchObject({ status: 'confirmed', reason: 'Amazon lists it under TTI, the maker of RYOBI; its title names PBP004' });
    expect(checkListingFields(want('PCG002'), live('PCG002'))).toMatchObject({ status: 'confirmed', reason: "Amazon lists it under ONEAND, Amazon's spelling of RYOBI ONE+; its title names PCG002" });
    // Without the aliases the catalog check reads them as another brand's.
    expect(checkIdentity(want('PBP004'), live('PBP004'), { aliases: false }).status).toBe('contradicted');
  });

  it('every other condition stands: an alias with another part number is still contradicted', () => {
    expect(checkIdentity(want('PCG002'), { ...live('PCG002'), partNumber: 'PCG006' }).status).toBe('contradicted');
  });

  it('measured: no recorded row changes, and the two live listings go from wrong to right', () => {
    const m = measureBrandAliases();
    expect(m.after).toEqual(m.before);
    expect(m.after.wrong).toBe(0);
    expect(m.liveBefore).toMatchObject({ wrong: 2 });
    expect(m.liveAfter).toEqual({ right: 2, wrong: 0, unknown: 0 });
  });

  it('the stored title match is verified with the evidence (the deal is then judged again)', async () => {
    const store = new MemoryScanStore();
    await store.putMatch({
      key: 'RYOBI:PCG002', brand: 'RYOBI', model: 'PCG002', status: 'matched', asin: 'B0B1QRQYK2', grade: 'probable', alternatives: [], decidedBy: 'auto', updatedAt: 1, waitingSince: null,
      catalogChecks: [{ asin: 'B0B1QRQYK2', status: 'unknown', reason: "Amazon's catalog lists no part number that is PCG002", at: 1, ladder: 1 }],
    });
    await applyCatalogCheck({ store, catalog: new Map(), now: () => 5 }, live('PCG002'));
    expect(await store.getMatch('RYOBI:PCG002')).toMatchObject({
      grade: 'strong', verifiedBy: 'listing_fields',
      verifyEvidence: "Amazon lists it under ONEAND, Amazon's spelling of RYOBI ONE+; its title names PCG002: https://www.amazon.com/dp/B0B1QRQYK2",
    });
  });
});
