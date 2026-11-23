// npx tsx scripts/measure-catalog-step.ts. Free, no network: what the Amazon brand-catalog step (the SerpApi brand pages a
// scan reads first, runner.ts catalogWanted) gives on the owner's real data (fixtures/e2e-2026-11-23/after-scan3), so the
// free scan can decide its fate from numbers (docs/decisions.md, "A scan's discovery is free").
//
// Which listings only a brand page saved: every listing row a response saves carries that response's time as checkedAt,
// and a later response showing the same listing moves it on. The three scans read one brand page each (scan 1 DEWALT
// p1, scan 2 RYOBI p1, scan 3 DEWALT p2: cursors.json) and scans 1 and 2 made no Amazon lookup, so a brand page's rows
// are the listings whose checkedAt is that page's answer time: the first response of each scan (catalog steps are queued
// first). A listing a lookup showed later is not counted: the lookup would have saved it anyway.
//
// It measures (1) the splits: every bundle's split (readSplit, with the settle data) with all listings and without the
// brand-page-only ones; (2) the matches: matched parts whose listing only a brand page saved (each a lookup the brand page
// saved: a search, or 11 Keepa tokens). Nothing is written.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MemoryScanStore } from '../core/src/scan/memoryStore';
import { knownModels, readSplit } from '../core/src/scan/split';
import type { BundleRecord, CatalogRecord, ListingRecord, MatchRecord, PartPriceRecord, ScanJob } from '../core/src/scan/types';
import { ROOT } from './node-store';

const DIR = join(ROOT, 'fixtures', 'e2e-2026-11-23', 'after-scan3', 'scan');
const rows = <T>(f: string): T[] => (JSON.parse(readFileSync(join(DIR, f), 'utf8')) as [string, T][]).map(([, v]) => v);

async function storeWith(listings: ListingRecord[]): Promise<MemoryScanStore> {
  const s = new MemoryScanStore();
  for (const b of rows<BundleRecord>('bundles.json')) await s.putBundle(b);
  for (const c of rows<CatalogRecord>('catalog.json')) await s.putCatalogEntry(c);
  for (const p of rows<PartPriceRecord>('partPrices.json')) await s.putPartPrice(p);
  for (const l of listings) await s.putListing(l);
  return s;
}

const shape = (d: { status: string; components: string[]; alternatives?: string[][]; waitingFor?: string[] }): string =>
  JSON.stringify([d.status, d.components, d.alternatives ?? null, d.waitingFor ?? null]);

async function main(): Promise<void> {
  const listings = rows<ListingRecord>('listings.json');
  const scans = rows<ScanJob>('scans.json').sort((a, b) => a.startedAt - b.startedAt);
  // The first answer time inside each scan is its brand page (queued before every other step).
  const brandTimes = new Set<number>();
  for (const job of scans) {
    const inside = listings.map((l) => l.checkedAt).filter((t) => t >= job.startedAt && t <= (job.finishedAt ?? Infinity));
    if (inside.length > 0 && (job.counts.catalogPages ?? 0) > 0) brandTimes.add(Math.min(...inside));
  }
  const brandOnly = listings.filter((l) => brandTimes.has(l.checkedAt));
  const rest = listings.filter((l) => !brandTimes.has(l.checkedAt));
  console.log(`Listings: ${listings.length}; saved only by a brand page: ${brandOnly.length} (${[...brandTimes].map((t) => listings.filter((l) => l.checkedAt === t).length).join(' + ')})`);

  const all = await storeWith(listings);
  const without = await storeWith(rest);
  const kAll = await knownModels(all);
  const kWithout = await knownModels(without);
  const bundles = rows<BundleRecord>('bundles.json');
  const changed: string[] = [];
  for (const b of bundles) {
    const a = readSplit(b, kAll);
    const w = readSplit(b, kWithout);
    if (shape(a) !== shape(w)) changed.push(`${b.model} (${b.itemId}): ${a.status} ${JSON.stringify(a.components)} -> ${w.status} ${JSON.stringify(w.components)}`);
  }
  console.log(`Bundles: ${bundles.length}; split changes without the brand-page-only listings: ${changed.length}`);
  for (const c of changed) console.log(`  ${c}`);
  // Models the catalog knows only from those listings.
  const onlyThere = [...kAll.catalog.keys()].filter((m) => !kWithout.catalog.has(m));
  console.log(`Models known only from them: ${onlyThere.length}`);

  const brandAsins = new Set(brandOnly.map((l) => l.asin));
  const matches = rows<MatchRecord>('matches.json').filter((m) => m.status === 'matched' && m.asin !== null);
  const fromBrand = matches.filter((m) => brandAsins.has(m.asin!));
  console.log(`Matched parts: ${matches.length}; matched to a listing only a brand page saved: ${fromBrand.length}`);
  for (const m of fromBrand) console.log(`  ${m.model} -> ${m.asin} (${m.grade}${m.source ? `, ${m.source}` : ''})`);
  const spent = scans.reduce((n, j) => n + (j.counts.catalogPages ?? 0), 0);
  console.log(`Brand pages paid in these scans: ${spent} searches`);
}

void main();
