// The red team for the rules: real confirmed records from the owner's fifth scan (fixtures/e2e-2026-11-23/after-scan5),
// each corrupted one thing at a time in the scan store, the report rebuilt by the app's own code (buildReport), and the
// sanity checks run on what it shows. No corrupted record may come out both confirmed and unflagged where a buy could
// rest on it. Free; no network.

import { describe, expect, it } from 'vitest';

import { sanityFindings } from '../src/audit/sanity';
import { sameModel } from '../src/match';
import type { MemoryScanStore } from '../src/scan/memoryStore';
import type { BundleRow, MatchRecord } from '../src/scan/types';
import { loadScanFolder } from '../../scripts/data-folder';
import { AFTER_SCAN5, dealsOf } from './sanity-world';

const CONFIRMED = new Set(['keepa_catalog', 'serpapi_product', 'listing_fields']);

interface Target { match: MatchRecord; title: string; price: number }

/** The confirmed matches the report counts with a title and a price, each listing once, in key order. */
async function targets(store: MemoryScanStore): Promise<Target[]> {
  const deals = await dealsOf(store);
  const counted = new Map<string, { title: string; price: number }>();
  for (const b of deals) for (const o of b.options) for (const p of o.parts) {
    if (p.status === 'matched' && p.asin && p.title && p.price !== null && CONFIRMED.has(p.verifiedBy ?? '')) counted.set(`${b.brand}:${p.model}`.toUpperCase(), { title: p.title, price: p.price });
  }
  const out: Target[] = [];
  for (const m of (await store.listMatches()).sort((a, b) => a.key.localeCompare(b.key))) {
    const c = counted.get(m.key);
    if (c && m.asin && !out.some((t) => t.match.asin === m.asin)) out.push({ match: m, ...c });
  }
  return out;
}

/** Another target of a different model (not the RYOBI twin), the next one in order. */
const otherOf = (all: Target[], t: Target): Target =>
  [...all.slice(all.indexOf(t) + 1), ...all].find((o) => o.match.brand === t.match.brand && !sameModel(t.match.brand, o.match.model, t.match.model) && o.match.asin !== t.match.asin)!;

type Mutation = (store: MemoryScanStore, t: Target, all: Target[]) => Promise<{ asin: string }>;

const MUTATIONS: Record<string, Mutation> = {
  // The Nov 24 case: Amazon's catalog part number names this model on another product's listing, and the rule confirms it.
  'another product confirmed by part number': async (store, t, all) => {
    const o = otherOf(all, t);
    await store.putMatch({ ...t.match, asin: o.match.asin, alternatives: [], verifyEvidence: `Amazon's catalog lists brand ${t.match.brand}, part number ${t.match.model}` });
    return { asin: o.match.asin! };
  },
  // The listing keeps its ASIN; its title is another product's.
  'title swapped': async (store, t, all) => {
    const o = otherOf(all, t);
    const listing = (await store.getListing(t.match.asin!))!;
    await store.putListing({ ...listing, title: o.title });
    return { asin: t.match.asin! };
  },
  'price times ten': async (store, t) => {
    const p = await store.getPrice(t.match.asin!);
    await store.putPrice({ ...(p ?? { asin: t.match.asin!, reviews: null, seenAt: 1, checkedAt: 1 }), price: Math.round(t.price * 1000) / 100 });
    const listing = (await store.getListing(t.match.asin!))!;
    await store.putListing({ ...listing, price: Math.round(t.price * 1000) / 100 });
    return { asin: t.match.asin! };
  },
  // A two-pack listing counted as one unit: the title says so and the price is two units'.
  'quantity doubled (a 2-pack)': async (store, t) => {
    const listing = (await store.getListing(t.match.asin!))!;
    await store.putListing({ ...listing, title: `${t.title} (2-Pack)`, price: t.price * 2 });
    const p = await store.getPrice(t.match.asin!);
    if (p) await store.putPrice({ ...p, price: t.price * 2 });
    return { asin: t.match.asin! };
  },
};

interface Outcome { kind: string; model: string; asin: string; flagged: boolean; buyable: boolean }

/** Whether a buy could rest on the record: a deal counts it in a way to sell with a complete estimate. */
const buyable = (deals: BundleRow[], model: string, asin: string): boolean =>
  deals.some((b) => b.options.some((o) => o.estimate !== null && o.parts.some((p) => p.model === model && p.asin === asin)));

async function runAll(): Promise<Outcome[]> {
  const base = await loadScanFolder(AFTER_SCAN5);
  const all = await targets(base);
  const out: Outcome[] = [];
  for (const [kind, mutate] of Object.entries(MUTATIONS)) {
    for (const t of all) {
      const store = await loadScanFolder(AFTER_SCAN5);
      const { asin } = await mutate(store, t, all);
      const deals = await dealsOf(store);
      const counted = deals.filter((b) => b.options.some((o) => o.parts.some((p) => p.model === t.match.model && p.asin === asin && p.status === 'matched')));
      if (counted.length === 0) continue;
      const findings = sanityFindings(deals).filter((f) => f.severity === 'hold');
      const flagged = counted.every((b) =>
        findings.some((f) => f.bundleId === b.key && ((f.part === t.match.model && f.asin === asin) || f.kind === 'too_good')));
      out.push({ kind, model: t.match.model, asin, flagged, buyable: buyable(deals, t.match.model, asin) });
    }
  }
  return out;
}

describe('mutations of real confirmed records (after-scan5): none comes out confirmed, buyable and unflagged', () => {
  it('41 confirmed records, four mutations each: every one a buy could rest on is held', async () => {
    const outcomes = await runAll();
    const summary = Object.fromEntries(Object.keys(MUTATIONS).map((k) => {
      const of = outcomes.filter((o) => o.kind === k);
      return [k, { tried: of.length, held: of.filter((o) => o.flagged).length }];
    }));
    expect(summary).toEqual({
      'another product confirmed by part number': { tried: 41, held: 41 },
      'title swapped': { tried: 41, held: 41 },
      'price times ten': { tried: 41, held: 39 },
      'quantity doubled (a 2-pack)': { tried: 41, held: 41 },
    });
    expect(outcomes.filter((o) => !o.flagged && o.buyable)).toEqual([]);
    // What gets through (a finding, docs/decisions.md): a price times ten on a part with nothing to compare it with (no
    // Home Depot sold-alone price, no list price, no eBay price), in kits whose other parts have no price yet, so no deal
    // has an estimate a buy could rest on. Once one does, only the estimate check (ROI, parts against the regular price)
    // stands between it and Buy now.
    expect(outcomes.filter((o) => !o.flagged).map((o) => `${o.kind}: ${o.model} ${o.asin}`)).toEqual([
      'price times ten: A10FB1G B00P8HJF5G',
      'price times ten: PBP002 B08L339D94',
    ]);
  }, 120_000);
});
