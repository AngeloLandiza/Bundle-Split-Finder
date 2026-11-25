// Benchmark: candidatesFor (core/src/scan/listings.ts) on real records, at the scale a store reaches after months.
// Listings: the owner's 962 stored listings (fixtures/e2e-2026-11-23/after-scan6/scan/listings.json) and every row of
// the recorded Amazon searches (fixtures/recorded/amazon-search-*.json, amazon-brand-*-p1.json) saved as listingFrom
// saves them, replicated with distinct ASINs to LISTINGS records. Parts: real models of both brands from the same store
// (matches, split components, catalog, part prices; then the listings' own models), the first PARTS in sorted order.
// Prints one line: ms (measured work), pairs, matches, and a sha256 over every part's ordered result (the ASINs), which
// must not change when candidatesFor is optimized. Reads files only: no network, no store written.
//
//   npx tsx scripts/perf/candidates-for.ts

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { candidatesFor, listingFrom } from '../../core/src/scan/listings';
import type { ListingRecord } from '../../core/src/scan/types';
import { parseAmazonSearch } from '../../core/src/serpapi/parsers';

const LISTINGS = 5000;
const PARTS = 300;
const REPS = 3;

const ROOT = join(import.meta.dirname, '..', '..', 'fixtures');
const SCAN = join(ROOT, 'e2e-2026-11-23', 'after-scan6', 'scan');
const pairs = <T>(file: string): T[] => (JSON.parse(readFileSync(join(SCAN, file), 'utf8')) as [string, T][]).map(([, r]) => r);

// Real listings: the stored ones, then the recorded search rows not already stored.
const real = new Map<string, ListingRecord>();
for (const l of pairs<ListingRecord>('listings.json')) real.set(l.asin, l);
const recorded = join(ROOT, 'recorded');
for (const f of readdirSync(recorded).sort()) {
  if (!/^amazon-(search-.*|brand-.*-p1)\.json$/.test(f)) continue;
  for (const c of parseAmazonSearch(JSON.parse(readFileSync(join(recorded, f), 'utf8')))) {
    const l = listingFrom(c, ['RYOBI', 'DEWALT'], 0);
    if (l && !real.has(l.asin)) real.set(l.asin, l);
  }
}
const base = [...real.values()];
const listings: ListingRecord[] = [];
for (let copy = 0; listings.length < LISTINGS; copy++) {
  for (const l of base) {
    if (listings.length >= LISTINGS) break;
    listings.push(copy === 0 ? l : { ...l, asin: `${l.asin}~${copy}` });
  }
}

// Real part models of both brands.
const models = new Set<string>();
const add = (brand: string | null | undefined, model: string | null | undefined): void => {
  if (brand && model) models.add(`${brand.trim().toUpperCase()}|${model.trim().toUpperCase()}`);
};
for (const m of pairs<{ brand: string; model: string }>('matches.json')) add(m.brand, m.model);
for (const b of pairs<{ brand: string; split?: { components?: string[]; alternatives?: string[][] } }>('bundles.json')) {
  for (const c of b.split?.components ?? []) add(b.brand, c);
  for (const alt of b.split?.alternatives ?? []) for (const c of alt) add(b.brand, c);
}
for (const c of pairs<{ brand: string; model: string }>('catalog.json')) add(c.brand, c.model);
for (const p of pairs<{ brand: string; model: string }>('partPrices.json')) add(p.brand, p.model);
const fromParts = [...models].sort();
models.clear();
for (const l of base) for (const m of l.models) add(l.brand, m);
const fromListings = [...models].filter((k) => !fromParts.includes(k)).sort();
// Half of each brand (RYOBI's forms differ from DEWALT's): the store's part models first, then the listings' models.
const parts = ['DEWALT', 'RYOBI'].flatMap((brand) =>
  [...fromParts, ...fromListings].filter((k) => k.startsWith(`${brand}|`)).slice(0, PARTS / 2).map((k) => {
    const [b, model] = k.split('|') as [string, string];
    return { brand: b, model };
  }));
if (parts.length < PARTS) throw new Error(`only ${parts.length} real models`);

const run = (): string[][] => parts.map((p) => candidatesFor(p.brand, p.model, listings).map((c) => c.asin));

run(); // warm up
let out: string[][] = [];
const t0 = performance.now();
for (let i = 0; i < REPS; i++) out = run();
const ms = performance.now() - t0;

const hash = createHash('sha256');
for (let i = 0; i < parts.length; i++) hash.update(`${parts[i]!.brand}|${parts[i]!.model}:${out[i]!.join(',')}\n`);
const brands = parts.reduce<Record<string, number>>((n, p) => ({ ...n, [p.brand]: (n[p.brand] ?? 0) + 1 }), {});
console.error(`real listings ${base.length}, replicated to ${listings.length}; models from parts ${fromParts.length}, used ${parts.length} ${JSON.stringify(brands)}; reps ${REPS}`);
console.log(`ms=${ms.toFixed(1)} pairs=${parts.length * listings.length * REPS} matches=${out.reduce((n, r) => n + r.length, 0)} sha=${hash.digest('hex')}`);
