// npx tsx scripts/measure-identity.ts. Free, no network, writes nothing.
// Measures the catalog check (core/src/keepa/verify.ts checkIdentity) on every real example recorded, against answer keys
// written without the check: right, wrong, unknown per set. Adopted only at zero wrong (docs/decisions.md).
//
//   keepa-for-PCL235B  the 20 products of the recorded Keepa search for RYOBI PCL235B, each checked against PCL235B:
//                      only B0BGYFTPGK is the part
//   keepa-own-model    the same products, each against the model its title or part number names
//                      (fixtures/keepa/identity-labels.json, labelled by reading the titles)
//   keepa-pulls        the three recorded product pulls against the parts the owner's third scan matched them to
//                      (after-scan3 scan/matches.json: PCL235, DCB606, DCF921B, all title matches)
//   serpapi-pages      the two recorded SerpApi product pages against the parts they were read for
//   validation-rows    every validation search row that names a labelled part, or that the labels list for it
//                      (fixtures/validation/labels-2026-11-18.json): rows carry a brand but no part number, so the
//                      check can contradict a brand and never confirm
//
// A result is wrong when it confirms a listing the key says is not the part, or contradicts one the key says is.
// `uncertain` keys count apart: no answer to them is right or wrong.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkIdentity, dewaltAmpHourConflict, identityFromKeepa, identityFromSerpProduct, type IdentityCheck, type ListingIdentity } from '../core/src/keepa/verify';
import { parseProductResponse, parseSearchResponse } from '../core/src/keepa/parse';
import type { KeepaProduct } from '../core/src/keepa/types';
import { titleHasModel, type Wanted } from '../core/src/match';
import { wantedFor } from '../core/src/scan/classify';
import { parseAmazonSearch } from '../core/src/serpapi/parsers';
import { ROOT } from './node-store';

type Key = 'is' | 'not' | 'uncertain';
export type Verdict = 'right' | 'wrong' | 'unknown' | 'uncertain';

export interface MeasuredRow {
  set: string;
  asin: string;
  model: string;
  key: Key;
  check: IdentityCheck;
  verdict: Verdict;
}

export interface SetScore {
  set: string;
  rows: number;
  right: number;
  wrong: number;
  unknown: number;
  uncertain: number;
  confirmed: number;
  contradicted: number;
}

const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

export function verdictOf(key: Key, check: IdentityCheck): Verdict {
  if (key === 'uncertain') return 'uncertain';
  if (check.status === 'unknown') return 'unknown';
  const says = check.status === 'confirmed' ? 'is' : 'not';
  return says === key ? 'right' : 'wrong';
}

const noCatalog = new Map();
const want = (brand: string, model: string): Wanted => wantedFor(brand, model, noCatalog);

function row(set: string, w: Wanted, l: ListingIdentity, key: Key): MeasuredRow {
  const check = checkIdentity(w, l);
  return { set, asin: l.asin, model: w.model, key, check, verdict: verdictOf(key, check) };
}

function keepaSearchProducts(root: string): KeepaProduct[] {
  return parseSearchResponse(read(join(root, 'fixtures/keepa/search-RYOBI-PCL235B.json')) as Record<string, unknown>).products ?? [];
}

function keepaPulls(root: string): KeepaProduct[] {
  return parseProductResponse(read(join(root, 'fixtures/keepa/product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB-stats.json')) as Record<string, unknown>).products;
}

/** The parts after-scan3 matched to a listing a recorded pull covers: [brand, model, asin]. */
export function scan3Pulled(root: string, pulled: Set<string>): [string, string, string, string][] {
  const matches = read(join(root, 'fixtures/e2e-2026-11-23/after-scan3/scan/matches.json')) as [string, { brand: string; model: string; asin: string | null; grade: string | null }][];
  return matches.filter(([, m]) => m.asin !== null && pulled.has(m.asin)).map(([, m]) => [m.brand, m.model, m.asin!, m.grade ?? '']);
}

export function measureIdentity(root = ROOT): { rows: MeasuredRow[]; scores: SetScore[] } {
  const rows: MeasuredRow[] = [];
  const search = keepaSearchProducts(root);
  for (const p of search) rows.push(row('keepa-for-PCL235B', want('RYOBI', 'PCL235B'), identityFromKeepa(p), p.asin === 'B0BGYFTPGK' ? 'is' : 'not'));

  const labels = (read(join(root, 'fixtures/keepa/identity-labels.json')) as { rows: { asin: string; model: string; brand?: string; label: Key }[] }).rows;
  const byAsin = new Map(search.map((p) => [p.asin, p]));
  for (const l of labels) {
    const p = byAsin.get(l.asin);
    if (!p) throw new Error(`identity-labels.json names ${l.asin}, which the recorded search does not hold`);
    rows.push(row('keepa-own-model', want(l.brand ?? 'RYOBI', l.model), identityFromKeepa(p), l.label));
  }

  const pulls = keepaPulls(root);
  const pulledBy = new Map(pulls.map((p) => [p.asin, p]));
  for (const [brand, model, asin] of scan3Pulled(root, new Set(pulledBy.keys()))) {
    rows.push(row('keepa-pulls', want(brand, model), identityFromKeepa(pulledBy.get(asin)!), 'is'));
  }

  for (const [asin, model] of [['B0B3JWF5ZV', 'PBLRC25B'], ['B0B6Z2ZGVK', 'PBLRC01B']] as const) {
    const l = identityFromSerpProduct(read(join(root, `fixtures/recorded/amazon-product-${asin}.json`)), asin)!;
    rows.push(row('serpapi-pages', want('RYOBI', model), l, 'is'));
  }

  rows.push(...validationRows(root));
  return { rows, scores: scoresOf(rows) };
}

/** Validation search rows as listings with only a title and a brand: what a search row can tell the check. */
function validationRows(root: string): MeasuredRow[] {
  const dir = join(root, 'fixtures/validation/responses/amazon');
  const pool = new Map<string, { asin: string; title: string; brand: string | null; brandOfQuery: string }>();
  for (const f of readdirSync(dir)) {
    const body = read(join(dir, f)) as { key: string; data: unknown };
    const brandOfQuery = /k=(RYOBI|DEWALT)/.exec(body.key)?.[1] ?? '';
    for (const c of parseAmazonSearch(body.data)) if (!pool.has(c.asin)) pool.set(c.asin, { asin: c.asin, title: c.title, brand: c.brand ?? null, brandOfQuery });
  }
  const labels = (read(join(root, 'fixtures/validation/labels-2026-11-18.json')) as { labels: Record<string, Record<string, { correct: string[] | 'none'; uncertain?: string[] }>> }).labels;
  const parts = new Map<string, { correct: string[]; uncertain: string[] }>();
  for (const bundle of Object.values(labels)) {
    for (const [model, l] of Object.entries(bundle)) parts.set(model, { correct: l.correct === 'none' ? [] : l.correct, uncertain: l.uncertain ?? [] });
  }
  const out: MeasuredRow[] = [];
  for (const [model, l] of parts) {
    const brand = model.startsWith('DC') ? 'DEWALT' : 'RYOBI';
    for (const r of pool.values()) {
      const listed = l.correct.includes(r.asin) || l.uncertain.includes(r.asin);
      if (!listed && !titleHasModel(brand, r.title, model)) continue;
      const key: Key = l.uncertain.includes(r.asin) ? 'uncertain' : l.correct.includes(r.asin) ? 'is' : 'not';
      const identity: ListingIdentity = {
        asin: r.asin, title: r.title, brand: r.brand, manufacturer: null, partNumber: null, model: null, numberOfItems: null, packageQuantity: null,
        source: 'serpapi_product',
      };
      out.push(row('validation-rows', want(brand, model), identity, key));
    }
  }
  return out;
}

/**
 * The DEWALT amp-hour rule (verify.ts dewaltAmpHourConflict) on every validation row the labels say is a DEWALT kit
 * part: a conflict there stops a confirmation of a listing the key says is right. Never a wrong answer (it only keeps a
 * listing unknown), but each one is a listing the catalog could not settle.
 */
export function ampHourConflicts(root = ROOT): { asin: string; model: string; reason: string }[] {
  return measureIdentity(root).rows
    .filter((r) => r.set === 'validation-rows' && r.key === 'is' && r.model.startsWith('DCK'))
    .flatMap((r) => {
      const title = validationTitle(root, r.asin);
      const reason = title ? dewaltAmpHourConflict(r.model, title) : null;
      return reason ? [{ asin: r.asin, model: r.model, reason }] : [];
    });
}

function validationTitle(root: string, asin: string): string | null {
  const dir = join(root, 'fixtures/validation/responses/amazon');
  for (const f of readdirSync(dir)) {
    const hit = parseAmazonSearch((read(join(dir, f)) as { data: unknown }).data).find((c) => c.asin === asin);
    if (hit) return hit.title;
  }
  return null;
}

export function scoresOf(rows: MeasuredRow[]): SetScore[] {
  const sets = [...new Set(rows.map((r) => r.set))];
  return sets.map((set) => {
    const of = rows.filter((r) => r.set === set);
    const n = (v: Verdict) => of.filter((r) => r.verdict === v).length;
    return {
      set, rows: of.length, right: n('right'), wrong: n('wrong'), unknown: n('unknown'), uncertain: n('uncertain'),
      confirmed: of.filter((r) => r.check.status === 'confirmed').length, contradicted: of.filter((r) => r.check.status === 'contradicted').length,
    };
  });
}

export function scoreLines(scores: SetScore[]): string[] {
  const total = scores.reduce((t, s) => ({ rows: t.rows + s.rows, right: t.right + s.right, wrong: t.wrong + s.wrong, unknown: t.unknown + s.unknown, uncertain: t.uncertain + s.uncertain }), { rows: 0, right: 0, wrong: 0, unknown: 0, uncertain: 0 });
  return [
    ...scores.map((s) => `${s.set.padEnd(18)} ${String(s.rows).padStart(3)} rows: ${s.right} right, ${s.wrong} wrong, ${s.unknown} unknown, ${s.uncertain} uncertain key (${s.confirmed} confirmed, ${s.contradicted} contradicted)`),
    `${'all'.padEnd(18)} ${String(total.rows).padStart(3)} rows: ${total.right} right, ${total.wrong} wrong, ${total.unknown} unknown, ${total.uncertain} uncertain key`,
  ];
}

if (process.argv[1] && /measure-identity\.ts$/.test(process.argv[1])) {
  const { rows, scores } = measureIdentity();
  const verbose = process.argv.includes('--rows');
  for (const r of rows) {
    if (verbose || r.verdict === 'wrong' || r.set !== 'validation-rows') {
      console.log(`${r.verdict.padEnd(9)} ${r.set.padEnd(18)} ${r.asin} ${r.model.padEnd(13)} key ${r.key.padEnd(9)} ${r.check.status}: ${r.check.reason}`);
    }
  }
  console.log('');
  for (const line of scoreLines(scores)) console.log(line);
  const ah = ampHourConflicts();
  console.log(`DEWALT kit rows the key says are right that the amp-hour rule keeps unknown: ${ah.length}`);
  for (const c of ah) console.log(`  ${c.asin} ${c.model}: ${c.reason}`);
}
