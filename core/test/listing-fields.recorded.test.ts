import { describe, expect, it } from 'vitest';

import { ADOPTED_RULES, checkListingFields } from '../src/keepa/listingFields';
import { identityFromKeepa } from '../src/keepa/verify';
import { applyCatalogCheck, catalogChecksWanted } from '../src/scan/catalogCheck';
import { wantedFor } from '../src/scan/classify';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { isConfirmedListing } from '../src/tracking/signals';
import { measureIdentity } from '../../scripts/measure-identity';
import { measureRung1, replayScan3 } from '../../scripts/measure-autoconfirm';
import { recordedKeepaProducts } from '../../scripts/replay-catalog';

// Rung 1 of the listing ladder (core/src/keepa/listingFields.ts) on the recorded rows with an answer key. No network.

const rows = measureIdentity().rows;
const row = (asin: string, model: string) => rows.find((r) => r.asin === asin && r.model === model)!;
const keepa = recordedKeepaProducts();
const want = (brand: string, model: string) => wantedFor(brand, model, new Map());

describe('rung 1, the listing fields', () => {
  it('confirms a listing whose brand field is the brand and whose title names the model, nothing contradicting (B07JPFHQKG, DCS334B)', () => {
    const r = row('B07JPFHQKG', 'DCS334B');
    expect(r.key).toBe('is');
    expect(r.check.status).toBe('unknown');
    expect(checkListingFields(r.want, r.listing)).toMatchObject({ status: 'confirmed', rule: 'title', reason: "Amazon's product page lists brand DEWALT, and its title names DCS334B" });
  });

  it('a kit sold with another tool stays unknown (B0722GYTWL: DCK240C2 … with 20V MAX Circular Saw; the key says not the part)', () => {
    const r = row('B0722GYTWL', 'DCK240C2');
    expect(r.key).toBe('not');
    expect(checkListingFields(r.want, r.listing).status).toBe('unknown');
  });

  it('an OEM replacement part naming the model stays unknown (B08TGP8MGR for P553)', () => {
    expect(checkListingFields(row('B08TGP8MGR', 'P553').want, row('B08TGP8MGR', 'P553').listing).status).toBe('unknown');
  });

  it('a part number field naming another form stops it (B0DY31QJ4Q: title PCL001B, part number PCL001K, a kit)', () => {
    const out = checkListingFields(want('RYOBI', 'PCL001B'), identityFromKeepa(keepa.get('B0DY31QJ4Q')!));
    expect(out.status).toBe('unknown');
    expect(out.reason).toContain("the listing's part number is PCL001K");
  });

  it('a feature bullet selling a bare tool with a battery stops it (B0FD1B8BG5: "Comes with a 4Ah battery", part number taken away)', () => {
    const l = { ...identityFromKeepa(keepa.get('B0FD1B8BG5')!), partNumber: null, model: null };
    const out = checkListingFields(want('RYOBI', 'PCL201'), l);
    expect(out.status).toBe('unknown');
    expect(out.reason).toContain('a feature bullet sells it with a battery, a charger or more');
  });

  it('measured: the adopted rules confirm 22 recorded listings and none the key says is another product', () => {
    const { scores, rung0 } = measureRung1();
    expect(ADOPTED_RULES).toEqual(['title']);
    expect(rung0.wrong).toBe(0);
    for (const s of scores) expect(s.wrong).toBe(0);
    expect(scores.find((s) => s.rule === 'adopted')).toMatchObject({ right: 22, wrong: 0 });
  });

  it("replays the owner's third scan: 3 of 30 title matches settled offline by the catalog check, 27 need a live read", () => {
    const replay = replayScan3();
    expect(replay).toHaveLength(30);
    expect(replay.filter((r) => r.settledBy === 'catalog')).toHaveLength(3);
    expect(replay.filter((r) => r.settledBy === 'needs a live read')).toHaveLength(27);
  });

  it('applied to the store: the title match is verified by listing_fields, grade strong, and counts as confirmed', async () => {
    const store = new MemoryScanStore();
    await store.putMatch({ key: 'DEWALT:DCS334B', brand: 'DEWALT', model: 'DCS334B', status: 'matched', asin: 'B07JPFHQKG', grade: 'probable', alternatives: [], decidedBy: 'auto', updatedAt: 1, waitingSince: null });
    const out = await applyCatalogCheck({ store, catalog: new Map(), now: () => 5 }, { ...row('B07JPFHQKG', 'DCS334B').listing, source: 'keepa_catalog' });
    expect(out).toEqual([expect.objectContaining({ status: 'confirmed', change: 'verified', rule: 'title' })]);
    const m = await store.getMatch('DEWALT:DCS334B');
    expect(m).toMatchObject({ grade: 'strong', verifiedBy: 'listing_fields', verifyEvidence: "Amazon's catalog lists brand DEWALT, and its title names DCS334B: https://www.amazon.com/dp/B07JPFHQKG" });
    expect(isConfirmedListing({ grade: 'probable', verifiedBy: 'listing_fields' })).toBe(true);
    expect(isConfirmedListing({ grade: 'probable', verifiedBy: 'ai_checked' })).toBe(false);
  });

  it('an unknown stored before rung 1 is read again once (recheck), then stands', async () => {
    const store = new MemoryScanStore();
    await store.putMatch({
      key: 'DEWALT:DCS334B', brand: 'DEWALT', model: 'DCS334B', status: 'matched', asin: 'B07JPFHQKG', grade: 'probable', alternatives: [], decidedBy: 'auto', updatedAt: 1, waitingSince: null,
      catalogChecks: [{ asin: 'B07JPFHQKG', status: 'unknown', reason: "Amazon's catalog lists no part number that is DCS334B", at: 1 }],
    });
    const parts = new Map([['DEWALT:DCS334B', { saving: 10 }]]);
    expect(await catalogChecksWanted(store, parts)).toEqual([expect.objectContaining({ asin: 'B07JPFHQKG', recheck: true })]);
    await applyCatalogCheck({ store, catalog: new Map(), now: () => 5 }, { ...row('B07JPFHQKG', 'DCS334B').listing, source: 'keepa_catalog' });
    const m = await store.getMatch('DEWALT:DCS334B');
    expect(m?.catalogChecks).toEqual([expect.objectContaining({ asin: 'B07JPFHQKG', status: 'confirmed', ladder: 2 })]);
    expect(await catalogChecksWanted(store, parts)).toEqual([]);
  });
});
