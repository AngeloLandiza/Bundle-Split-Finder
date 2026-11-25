// candidatesFor builds each model form's whole-token test once per call and upper-cases each title once (perf,
// Nov 25). This keeps a copy of the implementation before that change and checks the new one returns exactly the same
// arrays: every real part model and every model a real title names, of both brands, against every real listing (the
// owner's stored listings after scan 6 and the recorded Amazon search rows), and adversarial models and titles.
// Reads committed fixtures only; no network.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type Candidate, hasModelToken, modelForms, titleHasModel } from '../src/match';
import { candidatesFor, listingFrom } from '../src/scan/listings';
import type { ListingRecord } from '../src/scan/types';
import { parseAmazonSearch } from '../src/serpapi/parsers';

// ---- the implementation before the change, copied as it was (match.ts and listings.ts)
const oldEscapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oldHasModelToken = (text: string, model: string): boolean =>
  new RegExp(`(?<![A-Z0-9])${oldEscapeRe(model.toUpperCase())}(?![A-Z0-9])`).test(text.toUpperCase());
const oldNorm = (s: string): string => s.toUpperCase().trim();
const oldRyobiBase = (m: string): string => (m.endsWith('B') ? m.slice(0, -1) : m);
const oldSameModel = (brand: string, a: string, b: string): boolean => {
  const x = oldNorm(a);
  const y = oldNorm(b);
  return x === y || (oldNorm(brand) === 'RYOBI' && oldRyobiBase(x) === oldRyobiBase(y));
};
const oldModelForms = (brand: string, model: string): string[] => {
  const m = oldNorm(model);
  if (oldNorm(brand) !== 'RYOBI') return [m];
  const base = oldRyobiBase(m);
  return [...new Set([m, base, `${base}B`])].filter((f) => oldSameModel(brand, f, m));
};
const oldTitleHasModel = (brand: string, title: string, model: string): boolean => oldModelForms(brand, model).some((f) => oldHasModelToken(title, f));
const oldUpper = (s: string): string => s.trim().toUpperCase();
function oldCandidatesFor(brand: string, model: string, listings: ListingRecord[]): Candidate[] {
  const want = oldUpper(brand);
  return listings
    .filter((l) => oldUpper(l.brand) === want && oldTitleHasModel(want, l.title, model))
    .map((l) => ({ asin: l.asin, title: l.title, brand: l.brand, price: l.price, reviews: l.reviews, image: l.image }));
}

// ---- real records
const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures');
const SCAN = join(FIXTURES, 'e2e-2026-11-23', 'after-scan6', 'scan');
const pairs = <T>(file: string): T[] => (JSON.parse(readFileSync(join(SCAN, file), 'utf8')) as [string, T][]).map(([, r]) => r);

function realListings(): ListingRecord[] {
  const out = new Map<string, ListingRecord>();
  for (const l of pairs<ListingRecord>('listings.json')) out.set(l.asin, l);
  const dir = join(FIXTURES, 'recorded');
  for (const f of readdirSync(dir).sort()) {
    if (!/^amazon-(search-.*|brand-.*-p1)\.json$/.test(f)) continue;
    for (const c of parseAmazonSearch(JSON.parse(readFileSync(join(dir, f), 'utf8')))) {
      const l = listingFrom(c, ['RYOBI', 'DEWALT'], 0);
      if (l && !out.has(l.asin)) out.set(l.asin, l);
    }
  }
  return [...out.values()];
}

function realModels(listings: ListingRecord[]): string[] {
  const models = new Set<string>();
  const add = (m: string | null | undefined) => { if (m) models.add(m); };
  for (const m of pairs<{ model: string }>('matches.json')) add(m.model);
  for (const b of pairs<{ model: string; split?: { components?: string[]; alternatives?: string[][] } }>('bundles.json')) {
    add(b.model);
    for (const c of b.split?.components ?? []) add(c);
    for (const alt of b.split?.alternatives ?? []) for (const c of alt) add(c);
  }
  for (const c of pairs<{ model: string }>('catalog.json')) add(c.model);
  for (const p of pairs<{ model: string }>('partPrices.json')) add(p.model);
  for (const l of listings) for (const m of l.models) add(m);
  return [...models].sort();
}

const asins = (cs: Candidate[]) => cs.map((c) => c.asin);

describe('candidatesFor returns exactly what it returned before (perf, Nov 25)', () => {
  const listings = realListings();
  const models = realModels(listings);

  it('reads enough real data to mean something', () => {
    expect(listings.length).toBeGreaterThanOrEqual(1000);
    expect(models.length).toBeGreaterThanOrEqual(400);
    expect(new Set(listings.map((l) => l.brand))).toEqual(new Set(['DEWALT', 'RYOBI']));
  });

  it('every real model, under each brand and its written variants, against every real listing', () => {
    let found = 0;
    for (const brand of ['DEWALT', 'RYOBI', ' ryobi ', 'Dewalt']) {
      for (const model of models) {
        const now = candidatesFor(brand, model, listings);
        const was = oldCandidatesFor(brand, model, listings);
        if (JSON.stringify(now) !== JSON.stringify(was)) expect({ brand, model, now: asins(now) }).toEqual({ brand, model, now: asins(was) });
        found += now.length;
      }
    }
    // Most parts find their own listings: a check that the comparison is not of empty arrays.
    expect(found).toBeGreaterThan(models.length);
  });

  it('every real model written in lower case, with spaces around it, and as its RYOBI twin', () => {
    for (const model of models) {
      for (const written of [model.toLowerCase(), ` ${model} `, `${model}B`, model.endsWith('B') ? model.slice(0, -1) : `${model}BB`]) {
        for (const brand of ['DEWALT', 'RYOBI']) expect(candidatesFor(brand, written, listings)).toEqual(oldCandidatesFor(brand, written, listings));
      }
    }
  });

  const title = (asin: string, brand: string, t: string): ListingRecord => ({
    asin, brand, title: t, models: [], image: null, price: null, reviews: null, seenAt: null, checkedAt: 0,
  });
  const odd: ListingRecord[] = [
    title('A1', 'RYOBI', 'PCL206B tool only'),
    title('A2', 'RYOBI', 'pcl206 kit'),
    title('A3', 'RYOBI', 'XPCL206 and PCL206BX'),
    title('A4', 'RYOBI', 'P.53 (P*53) [P+53] P?53 ^P53$ {P53} P|53 P\\53'),
    title('A5', 'DEWALT', 'DCB205-2 2-pack, DCB205 single, DCB205-2X'),
    title('A6', 'DEWALT', 'dcb205-2 lower case'),
    title('A7', 'RYOBI', 'Straße ß PCLß ﬁ PCL206 ı i̇'),
    title('A8', 'RYOBI', ''),
    title('A9', 'ryobi ', 'PCL430B'),
    title('A10', 'DEWALT', 'DCK240C2 and DCK240C2DCS380B and DCK240'),
    title('A11', 'RYOBI', 'PCL430BB and PCL430BBB'),
    title('A12', 'RYOBI', 'B'),
    title('A13', 'DEWALT', '  '),
    title('A14', 'DEWALT', 'A_B A B A-B'),
  ];
  const adversarial = [
    'P.53', 'P*53', 'P+53', 'P?53', '^P53$', '{P53}', 'P|53', 'P\\53', '(P*53)', '[P+53]', '.*', '', ' ', 'B', 'BB',
    'PCL206', 'pcl206b', 'PCL206BB', 'PCL20', 'CL206', 'DCB205', 'DCB205-2', 'dcb205-2', 'DCB205-', '-2', 'DCK240C2', 'DCK240',
    'PCL430B', 'PCL430', 'PCL430BB', 'STRASSE', 'STRAßE', 'ß', 'SS', 'PCLSS', 'PCLß', 'FI', 'I', 'A_B', 'A B', 'A-B', '_',
  ];

  it('adversarial models (regex metacharacters, hyphens, case, substrings of other models, empty) against odd titles and real ones', () => {
    const all = [...odd, ...listings];
    for (const model of adversarial) {
      for (const brand of ['DEWALT', 'RYOBI', 'ryobi', ' DEWALT ', 'MILWAUKEE', '']) {
        expect({ brand, model, got: asins(candidatesFor(brand, model, all)) }).toEqual({ brand, model, got: asins(oldCandidatesFor(brand, model, all)) });
      }
    }
  });

  it('hasModelToken, titleHasModel and modelForms keep their meaning', () => {
    const texts = [...odd.map((l) => l.title), ...listings.slice(0, 200).map((l) => l.title)];
    for (const model of [...adversarial, ...models.slice(0, 100)]) {
      expect(modelForms('RYOBI', model)).toEqual(oldModelForms('RYOBI', model));
      for (const text of texts) {
        if (hasModelToken(text, model) !== oldHasModelToken(text, model)) expect({ text, model, has: hasModelToken(text, model) }).toEqual({ text, model, has: oldHasModelToken(text, model) });
        for (const brand of ['RYOBI', 'DEWALT']) {
          if (titleHasModel(brand, text, model) !== oldTitleHasModel(brand, text, model)) {
            expect({ brand, text, model, has: titleHasModel(brand, text, model) }).toEqual({ brand, text, model, has: oldTitleHasModel(brand, text, model) });
          }
        }
      }
    }
  });

  it('a model whose regex test is global would carry lastIndex between titles: two calls in a row agree', () => {
    for (const model of ['PCL206', 'DCB205-2', 'PCL430B']) {
      for (const brand of ['RYOBI', 'DEWALT']) expect(candidatesFor(brand, model, odd)).toEqual(candidatesFor(brand, model, odd));
    }
  });
});
