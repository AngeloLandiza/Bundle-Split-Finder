// npx tsx scripts/measure-wrong-confirm.ts [--rows]. Free, no network, writes nothing.
// The wrong confirmation the owner caught (fixtures/keepa/catalog-wrong-part-number-B0DGLWKS9S.json: Amazon's record for a
// DWST60122-1 backpack carries part number DWST08017) and the two rules that answer it, each measured on every answer key
// the repo has before it is adopted (docs/decisions.md, "A title that names another model; a price far above Home Depot's"):
//
//   1. the family rule   a title that names another model of the brand's wider family (match.ts FAMILY_PATTERNS), and
//                        not the part's, holds a confirmation by structured fields (rungs 0, 1 and 3, the part number grade)
//   2. the price guard   a counted Amazon price far above Home Depot's price for the part sold alone holds the listing
//                        for the owner (core/src/scan/priceGuard.ts); measured as the ratio's distribution
//
// "Zero wrong" holds only for the populations measured here: the recorded Keepa search and pulls, two SerpApi pages, the
// validation search rows, the audit corpus and the owner's stored scans. A new population (Home Depot's sets, Nov 23)
// is how the example got through.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkListingFields } from '../core/src/keepa/listingFields';
import { identityFromKeepa, type ListingIdentity } from '../core/src/keepa/verify';
import { checkListingJudge, type ListingJudgeRaw } from '../core/src/listingJudge';
import { FAMILY_PATTERNS, MODEL_PATTERNS, otherModelNamed, sameModel, type Wanted } from '../core/src/match';
import type { KeepaProduct } from '../core/src/keepa/types';
import { parseSearchResponse } from '../core/src/keepa/parse';
import { wantedFor } from '../core/src/scan/classify';
import { applyPriceGuard, priceCheckOf, PRICE_RATIO_LIMIT } from '../core/src/scan/priceGuard';
import { buildReport } from '../core/src/scan/report';
import { DEFAULT_SCAN_SETTINGS, type ScanReport } from '../core/src/scan/types';
import { loadScanFolder } from './data-folder';
import { answerKeys, LIVE_HELD, scan5MakerRows } from './measure-autoconfirm';
import { measureIdentity } from './measure-identity';
import { ROOT } from './node-store';

type Key = 'is' | 'not' | 'uncertain' | 'no key';
const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const noCatalog = new Map();

/** The recorded example: the part, its Home Depot price sold alone, the listing and its counted price. */
export interface WrongExample {
  want: Wanted;
  homeDepotPrice: number;
  amazonPrice: number;
  listing: ListingIdentity;
  match: { key: string; asin: string; alternatives: string[]; verifyEvidence: string };
}

export function wrongExample(root = ROOT): WrongExample {
  const f = read(join(root, 'fixtures/keepa/catalog-wrong-part-number-B0DGLWKS9S.json')) as {
    wanted: { brand: string; model: string; homeDepotPriceSoldAlone: number };
    product: KeepaProduct; amazonPrice: number;
    match: { key: string; asin: string; alternatives: string[]; verifyEvidence: string };
  };
  return {
    want: wantedFor(f.wanted.brand, f.wanted.model, noCatalog),
    homeDepotPrice: f.wanted.homeDepotPriceSoldAlone,
    amazonPrice: f.amazonPrice,
    listing: identityFromKeepa(f.product),
    match: f.match,
  };
}

// ---------------------------------------------------------------- rule 1: the family rule

export interface FamilyRow { label: string; key: Key; before: string; after: string; reason: string }
export interface FamilyScore {
  /** Rows read with and without the rule. */
  rows: number;
  changed: FamilyRow[];
  /** Changed rows the key says are not the part (a confirmation rightly held), are the part (a right one lost), or unknown. */
  right: number;
  lost: number;
  unknown: number;
  /** Confirmations of a listing the key says is not the part, with the rule on: must be 0. */
  wrong: number;
}

const verdict = (key: Key): 'right' | 'lost' | 'unknown' => (key === 'not' ? 'right' : key === 'is' ? 'lost' : 'unknown');

/** The audit corpus (fixtures/audit/corpus.json) as listings: a search row's title and brand, nothing more. */
function corpusRows(root: string): { want: Wanted; listing: ListingIdentity; key: Key; price: number | null }[] {
  const pairs = (read(join(root, 'fixtures/audit/corpus.json')) as {
    pairs: { part: { brand: string; model: string; isKit: boolean }; listing: { asin: string; title: string; brand: string | null; price: number | null }; label: string }[];
  }).pairs;
  return pairs.map((p) => ({
    want: wantedFor(p.part.brand, p.part.model, noCatalog),
    listing: { asin: p.listing.asin, title: p.listing.title, brand: p.listing.brand, manufacturer: null, partNumber: null, model: null, numberOfItems: null, packageQuantity: null, source: 'serpapi_product' },
    key: p.label === 'part' ? 'is' : p.label === 'not-part' ? 'not' : 'uncertain',
    price: p.listing.price,
  }));
}

/**
 * Rungs 0 and 1 (checkListingFields) without and with the family rule, on every listing with fields the repo holds: the
 * measured identity rows, the two live listings, the fifth scan's quoted checks, the audit corpus and the example.
 */
export function measureFamilyRule(root = ROOT): FamilyScore {
  const keys = answerKeys(root);
  const ex = wrongExample(root);
  const rows: { want: Wanted; listing: ListingIdentity; key: Key; label: string }[] = [
    ...measureIdentity(root).rows.map((r) => ({ want: r.want, listing: r.listing, key: r.key as Key, label: `${r.asin} for ${r.model} (${r.set})` })),
    ...LIVE_HELD.map((h) => ({ want: wantedFor('RYOBI', h.model, noCatalog), listing: h.listing, key: h.key as Key, label: `${h.listing.asin} for ${h.model} (live)` })),
    ...scan5MakerRows(root).map((r) => ({ want: wantedFor(r.brand, r.model, noCatalog), listing: r.listing, key: r.key, label: `${r.asin} for ${r.model} (after-scan5)` })),
    ...corpusRows(root).map((r) => ({ ...r, label: `${r.listing.asin} for ${r.want.model} (audit corpus)` })),
    { want: ex.want, listing: ex.listing, key: 'not', label: `${ex.listing.asin} for ${ex.want.model} (the owner's example)` },
  ];
  const out: FamilyScore = { rows: rows.length, changed: [], right: 0, lost: 0, unknown: 0, wrong: 0 };
  for (const r of rows) {
    const key = r.key === 'no key' ? (keys.get(`${r.want.model}|${r.listing.asin}`) ?? 'no key') : r.key;
    const off = checkListingFields(r.want, r.listing, { family: false });
    const on = checkListingFields(r.want, r.listing);
    if (on.status === 'confirmed' && key === 'not') out.wrong += 1;
    if (off.status === on.status) continue;
    out.changed.push({ label: r.label, key, before: off.status, after: on.status, reason: on.reason });
    out[verdict(key)] += 1;
  }
  return out;
}

/**
 * The grader's part number match (match.ts grade: strong) with the family rule: the recorded Keepa products whose part
 * number is the part's, against the models the labels give them. A changed row goes from strong to review.
 */
export function measureFamilyOnPartNumbers(root = ROOT): { rows: number; changed: FamilyRow[] } {
  const products = parseSearchResponse(read(join(root, 'fixtures/keepa/search-RYOBI-PCL235B.json')) as Record<string, unknown>).products ?? [];
  const labels = (read(join(root, 'fixtures/keepa/identity-labels.json')) as { rows: { asin: string; model: string; brand?: string; label: Key }[] }).rows;
  const ex = wrongExample(root);
  const pairs: { brand: string; model: string; asin: string; title: string; partNumber: string | null; key: Key }[] = [
    ...labels.flatMap((l) => {
      const p = products.find((x) => x.asin === l.asin);
      return p ? [{ brand: l.brand ?? 'RYOBI', model: l.model, asin: l.asin, title: p.title ?? '', partNumber: p.partNumber ?? null, key: l.label }] : [];
    }),
    ...products.map((p) => ({ brand: 'RYOBI', model: 'PCL235B', asin: p.asin, title: p.title ?? '', partNumber: p.partNumber ?? null, key: (p.asin === 'B0BGYFTPGK' ? 'is' : 'not') as Key })),
    { brand: 'DEWALT', model: ex.want.model, asin: ex.listing.asin, title: ex.listing.title ?? '', partNumber: ex.listing.partNumber, key: 'not' },
  ];
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const withPart = pairs.filter((p) => p.partNumber !== null && clean(p.partNumber) === clean(p.model));
  const changed = withPart.flatMap((p) => {
    const other = otherModelNamed(p.brand, p.model, p.title);
    return other ? [{ label: `${p.asin} for ${p.model}`, key: p.key, before: 'strong', after: 'review', reason: `its title names ${other}, not ${p.model}` }] : [];
  });
  return { rows: withPart.length, changed };
}

/** The listing judge's code check (rung 3) without and with the rule, on the recorded judgements and the worst judge. */
export function measureFamilyOnJudge(root = ROOT): { recorded: number; changedRecorded: FamilyRow[]; worstWrongBefore: number; worstWrongAfter: number; worstLost: FamilyRow[] } {
  const rows = measureIdentity(root).rows.filter((m) => m.key !== 'uncertain');
  const doc = read(join(root, 'fixtures/listing-judge/judgements-claude-haiku-5-5.json')) as { results: { set: string; asin: string; model: string; raw?: ListingJudgeRaw }[] };
  const byKey = new Map(doc.results.map((r) => [`${r.set}|${r.asin}|${r.model}`, r]));
  const changedRecorded: FamilyRow[] = [];
  let recorded = 0;
  for (const m of rows) {
    const r = byKey.get(`${m.set}|${m.asin}|${m.model}`);
    if (!r?.raw) continue;
    recorded += 1;
    const off = checkListingJudge(m.want, m.listing, r.raw, { family: false });
    const on = checkListingJudge(m.want, m.listing, r.raw);
    if (off.status !== on.status) changedRecorded.push({ label: `${m.asin} for ${m.model}`, key: m.key as Key, before: off.status, after: on.status, reason: on.reason });
  }
  // The worst judge: "same" on every row, quoting the part's model and brand wherever the title holds them.
  let worstWrongBefore = 0;
  let worstWrongAfter = 0;
  const worstLost: FamilyRow[] = [];
  const ex = wrongExample(root);
  const all = [...rows.map((m) => ({ want: m.want, listing: m.listing, key: m.key as Key })), { want: ex.want, listing: ex.listing, key: 'not' as Key }];
  for (const m of all) {
    const title = m.listing.title ?? '';
    const brandAt = title.toUpperCase().indexOf(m.want.brand.toUpperCase());
    const raw: ListingJudgeRaw = {
      quotes: [
        { about: 'model_number', field: 'part_number', quote: m.listing.partNumber ?? m.want.model },
        ...(brandAt >= 0 ? [{ about: 'brand' as const, field: 'title' as const, quote: title.slice(brandAt, brandAt + m.want.brand.length) }] : []),
      ],
      reason: 'worst case', verdict: 'same',
    };
    const off = checkListingJudge(m.want, m.listing, raw, { family: false });
    const on = checkListingJudge(m.want, m.listing, raw);
    if (off.status === 'ai_checked' && m.key === 'not') worstWrongBefore += 1;
    if (on.status === 'ai_checked' && m.key === 'not') worstWrongAfter += 1;
    if (off.status === 'ai_checked' && on.status !== 'ai_checked') worstLost.push({ label: `${m.listing.asin} for ${m.want.model}`, key: m.key, before: off.status, after: on.status, reason: on.reason });
  }
  return { recorded, changedRecorded, worstWrongBefore, worstWrongAfter, worstLost };
}

/**
 * The family forms the recorded data holds: every model token of FAMILY_PATTERNS, and not of MODEL_PATTERNS, in a recorded
 * title whose brand field is the brand (the owner's stored listings and the audit corpus), with how many listings carry it.
 */
export function familyForms(root = ROOT): Record<string, Map<string, number>> {
  const titles = new Map<string, { brand: string; title: string }>();
  for (const dir of ['scan', 'after-scan3/scan', 'after-scan5/scan']) {
    for (const [asin, l] of read(join(root, 'fixtures/e2e-2026-11-23', dir, 'listings.json')) as [string, { brand: string; title: string }][]) titles.set(asin, l);
  }
  for (const r of corpusRows(root)) if (!titles.has(r.listing.asin)) titles.set(r.listing.asin, { brand: (r.listing.brand ?? '').toUpperCase(), title: r.listing.title ?? '' });
  const out: Record<string, Map<string, number>> = {};
  for (const brand of Object.keys(FAMILY_PATTERNS)) {
    const forms = new Map<string, number>();
    const narrow = new RegExp(MODEL_PATTERNS[brand]!.source);
    for (const t of titles.values()) {
      if (t.brand.toUpperCase() !== brand) continue;
      for (const m of t.title.toUpperCase().matchAll(new RegExp(FAMILY_PATTERNS[brand]!.source, 'g'))) {
        if (new RegExp(`^(?:${narrow.source})$`).test(m[0])) continue;
        forms.set(m[0], (forms.get(m[0]) ?? 0) + 1);
      }
    }
    out[brand] = forms;
  }
  return out;
}

// ---------------------------------------------------------------- rule 2: the price guard

export interface RatioRow {
  model: string;
  asin: string;
  amazon: number;
  homeDepot: number;
  ratio: number;
  key: Key;
  /** Where it came from: a stored scan's match (with its grade), the audit corpus, or the example. */
  from: string;
  /** Home Depot's page was the part itself (matchedModel by sameModel), not its RYOBI twin's. */
  samePage: boolean;
}

type Stored<T> = [string, T][];
interface StoredMatch { key: string; brand: string; model: string; status: string; asin: string | null; grade: string | null; decidedBy: string; verifiedBy?: string }

/**
 * Amazon's counted price over Home Depot's price for the part sold alone: every matched listing of the owner's stored
 * scans (the featured price a report counts, scan/prices.json, against scan/partPrices.json), every audit corpus pair
 * whose part Home Depot priced (the validation's part prices, else a stored scan's), and the example. One row per part
 * and listing, the latest scan's.
 */
export function priceRatios(root = ROOT): RatioRow[] {
  const keys = answerKeys(root);
  const rows = new Map<string, RatioRow>();
  const hdByModel = new Map<string, { price: number; samePage: boolean }>();
  const validation = (read(join(root, 'fixtures/validation/hd-part-prices-2026-11-18.json')) as { prices: Record<string, { brand: string; model: string; matchedModel: string | null; price: number | null }> }).prices;
  for (const p of Object.values(validation)) {
    if (p.price !== null) hdByModel.set(`${p.brand}:${p.model}`, { price: p.price, samePage: sameModel(p.brand, p.matchedModel ?? p.model, p.model) });
  }
  for (const dir of ['scan', 'after-scan3/scan', 'after-scan5/scan']) {
    const base = join(root, 'fixtures/e2e-2026-11-23', dir);
    const prices = new Map(read(join(base, 'prices.json')) as Stored<{ price: number | null; seenAt: number | null }>);
    const hd = new Map(read(join(base, 'partPrices.json')) as Stored<{ brand: string; model: string; matchedModel: string | null; price: number | null; seenAt: number | null }>);
    for (const [k, p] of hd) if (p.price !== null && p.seenAt !== null) hdByModel.set(k, { price: p.price, samePage: sameModel(p.brand, p.matchedModel ?? p.model, p.model) });
    for (const [, m] of read(join(base, 'matches.json')) as Stored<StoredMatch>) {
      if (m.status !== 'matched' || m.asin === null) continue;
      const a = prices.get(m.asin);
      const h = hd.get(m.key);
      if (!a || a.price === null || a.seenAt === null || !h || h.price === null || h.seenAt === null) continue;
      rows.set(`${m.model}|${m.asin}`, {
        model: m.model, asin: m.asin, amazon: a.price, homeDepot: h.price, ratio: a.price / h.price, key: keys.get(`${m.model}|${m.asin}`) ?? 'no key',
        from: `${dir.split('/')[0]} ${m.decidedBy === 'user' ? 'owner' : `${m.grade}${m.verifiedBy ? ` ${m.verifiedBy}` : ''}`}`,
        samePage: sameModel(h.brand, h.matchedModel ?? h.model, h.model),
      });
    }
  }
  for (const r of corpusRows(root)) {
    const h = hdByModel.get(`${r.want.brand}:${r.want.model}`);
    if (!h || r.price === null || rows.has(`${r.want.model}|${r.listing.asin}`)) continue;
    rows.set(`${r.want.model}|${r.listing.asin}`, {
      model: r.want.model, asin: r.listing.asin, amazon: r.price, homeDepot: h.price, ratio: r.price / h.price, key: r.key, from: 'audit corpus', samePage: h.samePage,
    });
  }
  const ex = wrongExample(root);
  rows.set(`${ex.want.model}|${ex.listing.asin}`, {
    model: ex.want.model, asin: ex.listing.asin, amazon: ex.amazonPrice, homeDepot: ex.homeDepotPrice, ratio: ex.amazonPrice / ex.homeDepotPrice, key: 'not', from: "the owner's example", samePage: true,
  });
  return [...rows.values()].sort((a, b) => b.ratio - a.ratio);
}

// ---------------------------------------------------------------- the replay: the owner's fifth scan, and the set

export interface SetReading {
  section: string;
  /** The primary way to sell's estimated profit, or null when it has none. */
  profit: number | null;
  /** Parts priced of the parts the way to sell holds, when the estimate is incomplete. */
  priced: string | null;
  /** DWST08017's row: status, listing, grade and counted price. */
  part: string;
}

export interface Scan5Replay {
  /** Automatic matches of the stored scan. */
  matches: number;
  /** Stored automatic matches whose listing title the family rule reads differently (rule 1). */
  familyChanged: string[];
  /** Matches the price guard holds (rule 2). */
  guardHeld: string[];
  /** The stored ratio closest under the limit, untouched. */
  highestKept: { key: string; asin: string; ratio: number } | null;
  /** The set "Adaptor Plate for TOUGHSYSTEM 2.0 and 10-Compartment …" (homedepot:339422000) with the example's match. */
  set: { before: SetReading; after: SetReading; question: { reason: string; candidates: string[] } | null; evidence: string | null };
  /** The report after both rules: the set's row and its Review question, as the agent publishes them. */
  report: ScanReport;
}

/**
 * The owner's fifth scan (fixtures/e2e-2026-11-23/after-scan5) under both rules, read from what it stored: rule 1 on every
 * automatic match's stored listing title (the fixture holds no pull, so the title is what can change), rule 2 by the guard
 * itself (applyPriceGuard). Then the set the example came from, with only what is recorded: its two items (the set's link
 * and the fixture name DWST08017, item 322961591, the set's unread item; DWST14925 is read), Home Depot's $39.99 for
 * DWST08017 sold alone and the example's match on B0DGLWKS9S at $389 (fixtures/keepa/catalog-wrong-part-number-B0DGLWKS9S.json).
 * DWST14925 is as the fifth scan stored it (B0799RHJ7W, confirmed, $14.88). Read with the app's default fee settings; the
 * owner's own settings read +$259.45.
 */
export async function replayScan5(root = ROOT): Promise<Scan5Replay> {
  const store = await loadScanFolder(join(root, 'fixtures/e2e-2026-11-23/after-scan5'));
  const now = Date.UTC(2026, 10, 24, 12);
  const matches = (await store.listMatches()).filter((m) => m.decidedBy === 'auto');
  const familyChanged: string[] = [];
  let highestKept: Scan5Replay['highestKept'] = null;
  for (const m of matches) {
    if (m.status !== 'matched' || m.asin === null) continue;
    const title = (await store.getListing(m.asin))?.title ?? '';
    const after = otherModelNamed(m.brand, m.model, title);
    if (otherModelNamed(m.brand, m.model, title, MODEL_PATTERNS) !== after) familyChanged.push(`${m.key} on ${m.asin}: its title names ${after}`);
    const price = await store.getPrice(m.asin);
    const hd = await store.getPartPrice(m.key);
    if (price?.price && hd?.price && sameModel(m.brand, hd.matchedModel ?? hd.model, m.model) && !(await priceCheckOf(store, m))) {
      const ratio = price.price / hd.price;
      if (highestKept === null || ratio > highestKept.ratio) highestKept = { key: m.key, asin: m.asin, ratio };
    }
  }
  const guardHeld = (await applyPriceGuard(store, now)).map((o) => `${o.key} on ${o.asin}: ${o.reason}`);

  // The set, with the example's match as the owner's app stored it.
  const ex = wrongExample(root);
  const SET = 'homedepot:339422000';
  const set = (await store.getBundle(SET))!;
  await store.putBundle({ ...set, split: { components: ['DWST08017', 'DWST14925'], status: 'resolved', notes: [] } });
  await store.putPartPrice({
    key: 'DEWALT:DWST08017', brand: 'DEWALT', model: 'DWST08017', itemId: '322961591', matchedModel: 'DWST08017', price: ex.homeDepotPrice,
    title: 'Adaptor Plate for TOUGHSYSTEM 2.0', link: 'https://www.homedepot.com/p/322961591', seenAt: now - 60_000, checkedAt: now - 60_000,
  });
  await store.putMatch({
    key: ex.match.key, brand: 'DEWALT', model: 'DWST08017', status: 'matched', asin: ex.match.asin, grade: 'strong', alternatives: ex.match.alternatives,
    decidedBy: 'auto', updatedAt: now - 60_000, waitingSince: null, source: 'page', verifiedBy: 'keepa_catalog', verifyEvidence: ex.match.verifyEvidence,
  });
  await store.putPrice({ asin: ex.match.asin, price: ex.amazonPrice, reviews: null, seenAt: now - 60_000, checkedAt: now - 60_000 });
  const reading = async (): Promise<SetReading> => {
    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.key === SET)!;
    const o = row.options[0]!;
    const inc = o.incomplete ?? null;
    return {
      section: row.section, profit: o.estimate?.profit ?? null,
      priced: inc ? `${inc.priced} of ${inc.total} priced: ${inc.unpriced.map((u) => `${u.model} ${u.state}`).join(', ')}` : null,
      part: o.parts.map((p) => `${p.model} ${p.status} ${p.asin ?? 'no listing'} ${p.grade ?? ''}${p.price !== null ? ` $${p.price}` : ''}`.replace(/\s+/g, ' ').trim()).join('; '),
    };
  };
  const before = await reading();
  await applyPriceGuard(store, now);
  const after = await reading();
  const q = await store.getReview('match:DEWALT:DWST08017');
  return {
    report: await buildReport(store, DEFAULT_SCAN_SETTINGS),
    matches: matches.length, familyChanged, guardHeld, highestKept,
    set: { before, after, question: q ? { reason: q.reason, candidates: q.candidates.map((c) => c.asin) } : null, evidence: (await store.getMatch(ex.match.key))?.verifyEvidence ?? null },
  };
}

if (process.argv[1] && /measure-wrong-confirm\.ts$/.test(process.argv[1])) {
  const showRows = process.argv.includes('--rows');
  console.log('Family forms in recorded titles (not of MODEL_PATTERNS), brand field = the brand:');
  for (const [brand, forms] of Object.entries(familyForms())) console.log(`  ${brand} ${forms.size}: ${[...forms].map(([f, n]) => (n > 1 ? `${f}×${n}` : f)).join(' ')}`);
  const f = measureFamilyRule();
  console.log(`\nRule 1, rungs 0 and 1, ${f.rows} rows: ${f.changed.length} changed: ${f.right} right, ${f.lost} lost, ${f.unknown} no key; wrong confirmations with the rule on: ${f.wrong}`);
  for (const c of f.changed) console.log(`  ${c.label}, key ${c.key}: ${c.before} -> ${c.after} (${c.reason})`);
  const g = measureFamilyOnPartNumbers();
  console.log(`Rule 1, the part number grade, ${g.rows} recorded products whose part number is the part's: ${g.changed.length} changed`);
  for (const c of g.changed) console.log(`  ${c.label}, key ${c.key}: ${c.before} -> ${c.after} (${c.reason})`);
  const j = measureFamilyOnJudge();
  console.log(`Rule 1, the listing judge's check: ${j.recorded} recorded judgements, ${j.changedRecorded.length} changed; worst judge wrong ${j.worstWrongBefore} -> ${j.worstWrongAfter}, right ones lost ${j.worstLost.filter((r) => r.key === 'is').length}`);
  for (const c of [...j.changedRecorded, ...j.worstLost]) console.log(`  ${c.label}, key ${c.key}: ${c.before} -> ${c.after} (${c.reason})`);
  const ratios = priceRatios();
  console.log(`\nRule 2, Amazon over Home Depot sold alone, ${ratios.length} listings:`);
  const band = (lo: number, hi: number) => ratios.filter((r) => r.ratio >= lo && r.ratio < hi);
  for (const [lo, hi] of [[0, 0.25], [0.25, 0.5], [0.5, 0.8], [0.8, 1.25], [1.25, 2], [2, 2.5], [2.5, 3], [3, 4], [4, 6], [6, Infinity]] as const) {
    const b = band(lo, hi);
    const k = (x: Key) => b.filter((r) => r.key === x).length;
    console.log(`  ${`${lo}–${hi === Infinity ? '' : hi}×`.padEnd(10)} ${String(b.length).padStart(3)}  is ${k('is')}, not ${k('not')}, uncertain ${k('uncertain')}, no key ${k('no key')}`);
  }
  for (const r of ratios.filter((x) => showRows || x.ratio >= 2 || (x.ratio < 0.45 && x.key === 'is'))) {
    console.log(`  ${r.ratio.toFixed(2).padStart(6)}×  ${r.model.padEnd(12)} ${r.asin} $${r.amazon} / $${r.homeDepot}  key ${r.key}  ${r.from}${r.samePage ? '' : ' (twin page)'}`);
  }
  const is = ratios.filter((r) => r.key === 'is').map((r) => r.ratio);
  console.log(`  right listings: ${Math.min(...is).toFixed(2)}× to ${Math.max(...is).toFixed(2)}×; above the limit (${PRICE_RATIO_LIMIT}×): ${ratios.filter((r) => r.ratio > PRICE_RATIO_LIMIT).map((r) => `${r.asin} for ${r.model} (key ${r.key})`).join(', ')}`);
  const r = await replayScan5();
  console.log(`\nReplay, after-scan5: ${r.matches} automatic matches; rule 1 changes ${r.familyChanged.length}${r.familyChanged.length ? `: ${r.familyChanged.join('; ')}` : ''}; the price guard holds ${r.guardHeld.length}${r.guardHeld.length ? `: ${r.guardHeld.join('; ')}` : ''}; highest kept ${r.highestKept ? `${r.highestKept.key} on ${r.highestKept.asin} at ${r.highestKept.ratio.toFixed(2)}×` : 'none'}`);
  console.log(`  the set, before: ${JSON.stringify(r.set.before)}`);
  console.log(`  the set, after:  ${JSON.stringify(r.set.after)}`);
  console.log(`  its question: ${JSON.stringify(r.set.question)}`);
}
