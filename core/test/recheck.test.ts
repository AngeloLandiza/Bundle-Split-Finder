// The app replaces a wrong listing itself (core/src/scan/recheck.ts; docs/decisions.md, Nov 25), on the owner's records
// after his sixth scan (fixtures/e2e-2026-11-23/after-scan6). Free: the Keepa pull is a fake, no network. Where a pull the
// app would make next is not recorded, a stand-in of Keepa's shape is used and the test says so; every other figure is
// the recorded one.

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadScanFolder } from '../../scripts/data-folder';
import { sanityFindings } from '../src/audit/sanity';
import { certainWithdrawals } from '../src/audit/withdraw';
import type { ListingIdentity } from '../src/keepa/verify';
import { matchState } from '../src/scan/matchState';
import {
  heldQuestionOf, recheckHeldQuestions, recheckSentence, runRechecks, withdrawCertain, withdrawListing, type PullResult,
} from '../src/scan/recheck';
import { buildReport } from '../src/scan/report';
import { rejudgePackQuestions } from '../src/scan/runner';
import { knownModels } from '../src/scan/split';
import { DEFAULT_SCAN_SETTINGS, type ScanStore } from '../src/scan/types';

const AFTER_SCAN6 = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan6');
const NOW = 1795600000000;
const DWST = 'DEWALT:DWST08017';
const SET = 'homedepot:339422000';
const store6 = () => loadScanFolder(AFTER_SCAN6);

/** A stand-in Keepa record of the shape identityFromKeepa gives (not recorded: what the pull would return is unknown). */
const standIn = (asin: string, title: string, partNumber: string | null): ListingIdentity => ({
  asin, title, brand: 'DEWALT', manufacturer: 'DEWALT', partNumber, model: partNumber, numberOfItems: 1, packageQuantity: 1, source: 'keepa_catalog',
});

/** A fake pull: the stand-ins given, their price saved as the agent's pull saves it; any other listing waits for tokens. */
function fakePull(store: ScanStore, records: Record<string, { id: ListingIdentity | null; price?: number }>, pulled: string[] = []): (asin: string) => Promise<PullResult> {
  return async (asin) => {
    const r = records[asin];
    if (!r) return { wait: 'Keepa tokens' };
    pulled.push(asin);
    if (r.price !== undefined) await store.putPrice({ asin, price: r.price, reviews: null, seenAt: NOW, checkedAt: NOW });
    return r.id;
  };
}

const deps = async (store: ScanStore, pull?: (asin: string) => Promise<PullResult>) => ({
  store, catalog: (await knownModels(store)).catalog, now: () => NOW, ...(pull ? { pull } : {}),
});

describe('DWST08017: the price guard\'s question becomes a re-check of its candidates', () => {
  it('the held question is recognised and withdrawn; the part is being re-checked, not asked; the set has no estimate', async () => {
    const store = await store6();
    const q = (await store.getReview(`match:${DWST}`))!;
    expect(heldQuestionOf(q)).toEqual({ asin: 'B0DGLWKS9S', reason: "Amazon's price is 9.7× Home Depot's price for this part: check the listing", by: 'price_guard' });
    expect(await recheckHeldQuestions(store, NOW)).toEqual([DWST]);
    expect((await store.getReview(`match:${DWST}`))!.answer).toBe('resolved by a later scan');
    const r = (await store.getRecheck(DWST))!;
    expect(r.stage).toBe('trying');
    expect(r.withdrawn).toEqual([{ asin: 'B0DGLWKS9S', reason: "Amazon's price is 9.7× Home Depot's price for this part: check the listing", by: 'price_guard', at: NOW }]);
    // The question's listings first, in its order, then the stored rows that name DWST08017 under DEWALT.
    expect(r.pending).toEqual(['B0C3TN1Z7P', 'B0HMV5V9L7', 'B0HQQZWYTX', 'B0CHWF4JM9', 'B0DR93VQBD']);
    expect((await store.getMatch(DWST))!.rejectedAsins).toEqual(['B0DGLWKS9S']);
    // Judged again: nothing new.
    expect(await recheckHeldQuestions(store, NOW + 1)).toEqual([]);
  });

  it('with no Keepa tokens: B0C3TN1Z7P is tried from its recorded catalog check, the next waits; nothing is asked', async () => {
    const store = await store6();
    await recheckHeldQuestions(store, NOW);
    const done = await runRechecks(await deps(store, fakePull(store, {})));
    expect(done).toMatchObject({ tried: 1, pulls: 0, replaced: [], lookups: [], asked: [] });
    const r = (await store.getRecheck(DWST))!;
    expect(r.tried).toEqual([{ asin: 'B0C3TN1Z7P', passed: false, reason: "Amazon's catalog lists no part number that is DWST08017", at: NOW }]);
    expect(r).toMatchObject({ stage: 'trying', waitingFor: 'Keepa tokens', pending: ['B0HMV5V9L7', 'B0HQQZWYTX', 'B0CHWF4JM9', 'B0DR93VQBD'] });
    expect(recheckSentence(r)).toBe(
      "Being re-checked: B0DGLWKS9S was withdrawn (Amazon's price is 9.7× Home Depot's price for this part: check the listing); tried B0C3TN1Z7P (Amazon's catalog lists no part number that is DWST08017); 4 more listings to try, waiting for Keepa tokens.",
    );
    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.key === SET)!;
    expect(row.estimate).toBeNull();
    expect(row.parts.find((p) => p.model === 'DWST08017')!.recheck).toEqual({ stage: 'trying', sentence: recheckSentence(r) });
    expect(matchState(row)).toBe('1 listing being re-checked');
    expect((await store.listReview()).some((x) => x.subject === DWST && x.answer === null)).toBe(false);
  });

  it('exactly one candidate passes (stand-in: B0HQQZWYTX\'s record lists part number DWST08017, $45): it is chosen, confirmed', async () => {
    const store = await store6();
    await recheckHeldQuestions(store, NOW);
    const none = (asin: string, title: string) => ({ id: standIn(asin, title, null) });
    const records = {
      B0HMV5V9L7: none('B0HMV5V9L7', 'DEWALT DWST08017 ToughSystem 2.0 Deep Compact Organizer'),
      B0HQQZWYTX: { id: standIn('B0HQQZWYTX', 'DEWALT ToughSystem 2.0 DWST08017 Adapter Plate, Metal/Plastic, Black', 'DWST08017'), price: 45 },
      B0CHWF4JM9: none('B0CHWF4JM9', 'Dewalt DWST08017 Tough System 2.0 Adapter, Toolbox'),
      B0DR93VQBD: { id: standIn('B0DR93VQBD', 'DEWALT ToughSystem to TSTAK Adaptor Bundle, DWST08017-9', 'DWST08017-9') },
    };
    const pulled: string[] = [];
    const done = await runRechecks(await deps(store, fakePull(store, records, pulled)));
    expect(pulled).toEqual(['B0HMV5V9L7', 'B0HQQZWYTX', 'B0CHWF4JM9', 'B0DR93VQBD']);
    expect(done.replaced.map((x) => [x.key, x.from, x.to])).toEqual([[DWST, 'B0DGLWKS9S', 'B0HQQZWYTX']]);
    const m = (await store.getMatch(DWST))!;
    expect(m).toMatchObject({ status: 'matched', asin: 'B0HQQZWYTX', grade: 'strong', verifiedBy: 'keepa_catalog', decidedBy: 'auto' });
    expect(m.verifyEvidence).toBe(
      "replaced B0DGLWKS9S (Amazon's price is 9.7× Home Depot's price for this part: check the listing) with B0HQQZWYTX: Amazon's catalog lists brand DEWALT, part number DWST08017: https://www.amazon.com/dp/B0HQQZWYTX",
    );
    expect((await store.getRecheck(DWST))!.stage).toBe('done');
    // The set's estimate is back, on the confirmed listing ($45 against Home Depot's $39.99: within the guard).
    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.key === SET)!;
    expect(row.parts.find((p) => p.model === 'DWST08017')).toMatchObject({ asin: 'B0HQQZWYTX', price: 45, verifiedBy: 'keepa_catalog' });
  });

  it('two candidates pass (stand-ins: both records list DWST08017): the app cannot tell, so it asks, saying what it tried', async () => {
    const store = await store6();
    await recheckHeldQuestions(store, NOW);
    const records = {
      B0HMV5V9L7: { id: standIn('B0HMV5V9L7', 'DEWALT DWST08017 ToughSystem 2.0 Deep Compact Organizer', 'DWST08017'), price: 49.98 },
      B0HQQZWYTX: { id: standIn('B0HQQZWYTX', 'DEWALT ToughSystem 2.0 DWST08017 Adapter Plate', 'DWST08017'), price: 45 },
      B0CHWF4JM9: { id: null },
      B0DR93VQBD: { id: null },
    };
    const done = await runRechecks(await deps(store, fakePull(store, records)));
    expect(done.asked).toEqual([DWST]);
    const q = (await store.getReview(`match:${DWST}`))!;
    expect(q.answer).toBeNull();
    expect(q.reason).toBe('The app tried the part\'s other listings: 2 pass its checks, and it cannot tell which is the part');
    expect(q.candidates.map((c) => [c.asin, c.reasons[0]])).toEqual([
      ['B0DGLWKS9S', "withdrawn: Amazon's price is 9.7× Home Depot's price for this part: check the listing"],
      ['B0C3TN1Z7P', "Amazon's catalog lists no part number that is DWST08017"],
      ['B0HMV5V9L7', "passes the app's checks (Amazon's catalog lists brand DEWALT, part number DWST08017)"],
      ['B0HQQZWYTX', "passes the app's checks (Amazon's catalog lists brand DEWALT, part number DWST08017)"],
      ['B0CHWF4JM9', 'Keepa has no record of the listing'],
      ['B0DR93VQBD', 'Keepa has no record of the listing'],
    ]);
    expect(q.tried!.map((t) => t.asin)).toEqual(['B0C3TN1Z7P', 'B0HMV5V9L7', 'B0HQQZWYTX', 'B0CHWF4JM9', 'B0DR93VQBD']);
    expect((await store.getMatch(DWST))!.status).toBe('review');
  });

  it('the price guard on a candidate: a $389 listing confirmed by part number is not taken (stand-in record)', async () => {
    const store = await store6();
    await recheckHeldQuestions(store, NOW);
    const records = {
      B0HMV5V9L7: { id: null }, B0CHWF4JM9: { id: null }, B0DR93VQBD: { id: null },
      B0HQQZWYTX: { id: standIn('B0HQQZWYTX', 'DEWALT ToughSystem 2.0 DWST08017 Adapter Plate', 'DWST08017'), price: 389 },
    };
    await runRechecks(await deps(store, fakePull(store, records)));
    const r = (await store.getRecheck(DWST))!;
    expect(r.tried.find((t) => t.asin === 'B0HQQZWYTX')).toMatchObject({ passed: false, reason: "Amazon's price is 9.7× Home Depot's price for this part: check the listing" });
    // None passed: the part joins the lookup queue (status waiting), still not a question.
    expect(r.stage).toBe('lookup');
    expect((await store.getMatch(DWST))!).toMatchObject({ status: 'waiting', asin: null, waitingSince: NOW });
    expect(recheckSentence(r)).toContain('no other stored listing passed, so it waits for a fresh lookup');
  });

  it('after the lookup: no listing found opens the question with each try; a withdrawn listing chosen again is never kept', async () => {
    for (const lookup of ['none', 'B0DGLWKS9S'] as const) {
      const store = await store6();
      await recheckHeldQuestions(store, NOW);
      await runRechecks(await deps(store, fakePull(store, { B0HMV5V9L7: { id: null }, B0HQQZWYTX: { id: null }, B0CHWF4JM9: { id: null }, B0DR93VQBD: { id: null } })));
      const m = (await store.getMatch(DWST))!;
      // What a lookup writes (runner.ts applyLookup rewrites the record whole, without rejectedAsins).
      const { rejectedAsins: _r, ...fresh } = m;
      await store.putMatch(lookup === 'none'
        ? { ...fresh, status: 'none', waitingSince: null }
        : { ...fresh, status: 'matched', asin: 'B0DGLWKS9S', grade: 'probable', alternatives: [], waitingSince: null });
      const done = await runRechecks(await deps(store));
      expect(done.asked).toEqual([DWST]);
      const after = (await store.getMatch(DWST))!;
      expect(after).toMatchObject({ status: 'review', asin: null, rejectedAsins: ['B0DGLWKS9S'] });
      const q = (await store.getReview(`match:${DWST}`))!;
      expect(q.reason).toBe('The listing was withdrawn; the app tried 5 other listings and none could be confirmed');
      expect(q.tried).toHaveLength(5);
      expect((await store.getRecheck(DWST))!.stage).toBe('asked');
    }
  });
});

describe('B0FD253MKS: one listing counted for PCL700B (three sets) and PCL702B (one bundle)', () => {
  const withdrawBoth = async (store: ScanStore) => {
    const deals = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles;
    return withdrawCertain(store, certainWithdrawals(sanityFindings(deals), deals), NOW);
  };

  it('withdrawn for both without asking; each part keeps its own candidates', async () => {
    const store = await store6();
    expect(await withdrawBoth(store)).toEqual(['RYOBI:PCL700B', 'RYOBI:PCL702B']);
    expect((await store.getRecheck('RYOBI:PCL700B'))!).toMatchObject({ stage: 'trying', pending: ['B0FD55VL1Z'] });
    expect((await store.getRecheck('RYOBI:PCL702B'))!).toMatchObject({ stage: 'trying', pending: ['B0BH6Q31MZ'] });
    for (const k of ['RYOBI:PCL700B', 'RYOBI:PCL702B']) {
      expect((await store.getMatch(k))!).toMatchObject({ status: 'review', asin: null, rejectedAsins: ['B0FD253MKS'] });
      expect((await store.getRecheck(k))!.withdrawn[0]).toMatchObject({ asin: 'B0FD253MKS', by: 'audit_two_models' });
    }
    // The four deals: no estimate, no question, "being re-checked"; the audit's hold on the listing is gone with it.
    const deals = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles;
    for (const id of ['homedepot:339349594', 'homedepot:339349600', 'homedepot:339349659', 'homedepot:344284497']) {
      const row = deals.find((b) => b.key === id)!;
      expect(row.estimate).toBeNull();
      expect(matchState(row)).toBe('1 listing being re-checked');
    }
    expect(sanityFindings(deals).filter((f) => f.asin === 'B0FD253MKS')).toEqual([]);
    expect(await withdrawBoth(store)).toEqual([]);
  });

  it('with no Keepa at all (the stored row read by rung 1): PCL702B takes B0BH6Q31MZ; PCL700B\'s kit listing is not taken and it joins the lookup queue', async () => {
    const store = await store6();
    await withdrawBoth(store);
    const done = await runRechecks(await deps(store));
    expect(done.replaced.map((x) => [x.key, x.to])).toEqual([['RYOBI:PCL702B', 'B0BH6Q31MZ']]);
    expect((await store.getMatch('RYOBI:PCL702B'))!).toMatchObject({ status: 'matched', asin: 'B0BH6Q31MZ', grade: 'strong', verifiedBy: 'listing_fields' });
    expect(done.lookups).toEqual(['RYOBI:PCL700B']);
    expect((await store.getRecheck('RYOBI:PCL700B'))!.tried).toEqual([
      { asin: 'B0FD55VL1Z', passed: false, at: NOW, reason: "Amazon's product page lists no part number that is PCL700B; its title names PCL700B, but title says kit, and the part is one tool" },
    ]);
    expect((await store.getMatch('RYOBI:PCL700B'))!.status).toBe('waiting');
  });

  it('with Keepa but no tokens: both wait, being re-checked', async () => {
    const store = await store6();
    await withdrawBoth(store);
    const done = await runRechecks(await deps(store, fakePull(store, {})));
    expect(done).toMatchObject({ tried: 0, replaced: [], lookups: [], asked: [] });
    for (const k of ['RYOBI:PCL700B', 'RYOBI:PCL702B']) expect((await store.getRecheck(k))!).toMatchObject({ stage: 'trying', waitingFor: 'Keepa tokens' });
  });

  it('a candidate counted for another model is not taken: B0FD253MKS is never chosen again for either part', async () => {
    const store = await store6();
    await withdrawBoth(store);
    // As if PCL700B's only other candidate were the two-vacuum listing: it is withdrawn and rejected, so it is not even tried.
    const r = (await store.getRecheck('RYOBI:PCL700B'))!;
    expect(r.pending).not.toContain('B0FD253MKS');
    await store.putRecheck({ ...r, pending: ['B0BH6Q31MZ'] });
    await store.putMatch({ ...(await store.getMatch('RYOBI:PCL702B'))!, status: 'matched', asin: 'B0BH6Q31MZ', grade: 'strong' });
    await runRechecks(await deps(store));
    expect((await store.getRecheck('RYOBI:PCL700B'))!.tried[0]).toMatchObject({ asin: 'B0BH6Q31MZ', passed: false, reason: 'it is already counted for PCL702B' });
  });
});

describe('what the app leaves alone', () => {
  it('an uncertain hold on a right listing (PBP2003\'s 2-pack B0BG5SPWVL, "a pack of 2") is left for the owner; a note too', async () => {
    const store = await store6();
    // At start, rule D (Nov 24) matches PBP2003 to its labelled listing; the audit then holds it (its title sells a 2-pack).
    expect(await rejudgePackQuestions(store, DEFAULT_SCAN_SETTINGS, () => NOW)).toEqual(['RYOBI:PBP2003']);
    const deals = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles;
    const found = sanityFindings(deals);
    const pack = found.filter((f) => f.part === 'PBP2003');
    expect(pack.map((f) => [f.kind, f.severity, f.asin])).toEqual([['pack_counted_as_one', 'hold', 'B0BG5SPWVL']]);
    const acted = certainWithdrawals(found, deals);
    expect(acted.map((w) => w.model)).toEqual(['PCL700B', 'PCL702B']);
    await withdrawCertain(store, acted, NOW);
    expect((await store.getMatch('RYOBI:PBP2003'))!).toMatchObject({ status: 'matched', asin: 'B0BG5SPWVL' });
    // A note (Amazon under a third of Home Depot's price for the part sold alone) lowers an estimate, never a buy: made a
    // note here by quadrupling Home Depot's price on a counted listing, the only change to the records.
    const row = deals.find((b) => b.parts.some((p) => p.status === 'matched' && p.price !== null && p.prices.some((o) => o.kind === 'homedepot')))!;
    const p = row.parts.find((x) => x.status === 'matched' && x.price !== null && x.prices.some((o) => o.kind === 'homedepot'))!;
    const raise = (x: (typeof row.parts)[number]) => (x.model !== p.model ? x : { ...x, prices: x.prices.map((o) => (o.kind === 'homedepot' ? { ...o, price: p.price! * 4 } : o)) });
    const noted = deals.map((b) => (b.key !== row.key ? b : { ...b, parts: b.parts.map(raise), options: b.options.map((o) => ({ ...o, parts: o.parts.map(raise) })) }));
    const notes = sanityFindings(noted).filter((f) => f.severity === 'note');
    expect(notes.map((f) => f.part)).toContain(p.model);
    expect(certainWithdrawals(notes, noted)).toEqual([]);
  });

  it('a store without re-checks (the extension\'s) withdraws nothing and the question stays as it was', async () => {
    const store = await store6();
    const bare = new Proxy(store, { get: (t, k) => (k === 'putRecheck' || k === 'getRecheck' || k === 'listRechecks' ? undefined : Reflect.get(t, k, t)) }) as ScanStore;
    expect(await recheckHeldQuestions(bare, NOW)).toEqual([]);
    expect(await withdrawListing(bare, { key: 'RYOBI:PCL700B', asin: 'B0FD253MKS', reason: 'x', by: 'owner', now: NOW })).toBe(false);
    expect((await store.getReview(`match:${DWST}`))!.answer).toBeNull();
  });
});
