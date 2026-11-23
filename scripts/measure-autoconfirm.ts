// npm run measure:autoconfirm. Free, no network, writes nothing.
// Measures rung 1 of the listing ladder (core/src/keepa/listingFields.ts) on every recorded row with a known answer
// (scripts/measure-identity.ts measureIdentity: the Keepa search, its labels, the three pulls, the two SerpApi pages and
// the validation search rows), one sub-rule at a time, on the rows the catalog check left unknown: right, wrong, unknown.
// A sub-rule is adopted only at zero wrong (docs/decisions.md). Then the replay on the owner's third scan
// (fixtures/e2e-2026-11-23/after-scan3): how many of its title matches each rung would settle offline. First, the
// manufacturer rule (core/src/keepa/brandAliases.ts makerAgrees): every manufacturer value recorded with brand RYOBI or
// DEWALT, the rows it changes against every answer key, and the fifth scan's three held deals replayed with it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { makerReading, MANUFACTURER_ALIASES } from '../core/src/keepa/brandAliases';
import { ADOPTED_RULES, checkListingFields, type FieldRule } from '../core/src/keepa/listingFields';
import { identityFromKeepa, identityFromSerpProduct, narrowBrandContradiction, type ListingIdentity } from '../core/src/keepa/verify';
import { parseProductResponse, parseSearchResponse } from '../core/src/keepa/parse';
import { wantedFor } from '../core/src/scan/classify';
import type { BundleRow } from '../core/src/scan/types';
import { DEFAULT_SETTINGS } from '../core/src/settings';
import type { PartTrend } from '../core/src/keepa/trends';
import { bundleSignals, isConfirmedListing, type HistoryPoint, type TrendLookup } from '../core/src/tracking/signals';
import { measureIdentity, verdictOf, type MeasuredRow, type Verdict } from './measure-identity';
import { ROOT } from './node-store';

const RULES: readonly FieldRule[] = ['id_field', 'features', 'title', 'gtin'];

export interface RuleScore {
  rule: FieldRule | 'adopted';
  /** Rows the catalog check left unknown with a key that is not uncertain. */
  rows: number;
  right: number;
  wrong: number;
  unknown: number;
  wrongRows: MeasuredRow[];
}

/** Rung 1 per sub-rule, on the rows rung 0 (the catalog check) left unknown. */
export function measureRung1(root = ROOT): { scores: RuleScore[]; rung0: { right: number; wrong: number; unknown: number } } {
  const { rows } = measureIdentity(root);
  const known = rows.filter((r) => r.key !== 'uncertain');
  const open = known.filter((r) => r.check.status === 'unknown');
  const count = (v: Verdict) => known.filter((r) => r.verdict === v).length;
  const score = (rule: RuleScore['rule'], rules: readonly FieldRule[]): RuleScore => {
    const s: RuleScore = { rule, rows: open.length, right: 0, wrong: 0, unknown: 0, wrongRows: [] };
    for (const r of open) {
      const v = verdictOf(r.key, checkListingFields(r.want, r.listing, { rules }));
      if (v === 'right') s.right += 1;
      else if (v === 'wrong') { s.wrong += 1; s.wrongRows.push(r); }
      else s.unknown += 1;
    }
    return s;
  };
  return {
    scores: [...RULES.map((rule) => score(rule, [rule])), score('adopted', ADOPTED_RULES)],
    rung0: { right: count('right'), wrong: count('wrong'), unknown: count('unknown') },
  };
}

const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

export interface ReplayRow {
  key: string;
  asin: string;
  /** What settles it offline: the catalog check or rung 1 on a recorded pull or page, or a live read it needs. */
  settledBy: 'catalog' | 'listing_fields' | 'needs a live read' | 'recorded, still unknown';
  reason: string;
  /**
   * For a listing with no recording: rung 1's adopted rules on the search row the scan stored (its title and brand only),
   * the most a Keepa pull could settle. A pull adds fields that may still stop it (a part number, a count, a maker).
   */
  fromSearchRow?: 'would pass' | 'stopped';
}

/**
 * The owner's third scan: each title match (grade probable) against every recording of its listing: the recorded Keepa
 * pulls and search products, and the recorded SerpApi product pages. Without one, rungs 1 and 2 need a live read.
 */
export function replayScan3(root = ROOT): ReplayRow[] {
  const matches = read(join(root, 'fixtures/e2e-2026-11-23/after-scan3/scan/matches.json')) as [string, { key: string; brand: string; model: string; asin: string | null; grade: string | null; status: string }][];
  const catalog = new Map(
    (read(join(root, 'fixtures/e2e-2026-11-23/after-scan3/scan/catalog.json')) as [string, { model: string; isKit?: boolean; upc?: string | null }][]).map(([, c]) => [c.model, c]),
  );
  const keepa = [
    ...parseProductResponse(read(join(root, 'fixtures/keepa/product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB.json')) as Record<string, unknown>).products,
    ...(parseSearchResponse(read(join(root, 'fixtures/keepa/search-RYOBI-PCL235B.json')) as Record<string, unknown>).products ?? []),
  ];
  const recorded = new Map(keepa.map((p) => [p.asin, identityFromKeepa(p)]));
  for (const asin of ['B0B3JWF5ZV', 'B0B6Z2ZGVK']) {
    const l = identityFromSerpProduct(read(join(root, `fixtures/recorded/amazon-product-${asin}.json`)), asin);
    if (l && !recorded.has(asin)) recorded.set(asin, l);
  }
  const listings = new Map((read(join(root, 'fixtures/e2e-2026-11-23/after-scan3/scan/listings.json')) as [string, { asin: string; brand: string | null; title: string }][]));
  const out: ReplayRow[] = [];
  for (const [, m] of matches) {
    if (m.status !== 'matched' || m.grade !== 'probable' || m.asin === null) continue;
    const want = wantedFor(m.brand, m.model, catalog as never);
    const l = recorded.get(m.asin);
    if (!l) {
      const row = listings.get(m.asin);
      const fromRow = row
        ? checkListingFields(want, { asin: m.asin, title: row.title, brand: row.brand, manufacturer: null, partNumber: null, model: null, numberOfItems: null, packageQuantity: null, source: 'serpapi_product' })
        : null;
      out.push({
        key: m.key, asin: m.asin, settledBy: 'needs a live read', reason: fromRow ? `search row: ${fromRow.status}: ${fromRow.reason}` : 'no recorded pull or page of this listing',
        ...(fromRow ? { fromSearchRow: fromRow.status === 'confirmed' ? 'would pass' as const : 'stopped' as const } : {}),
      });
      continue;
    }
    const r = checkListingFields(want, l);
    const settledBy = r.status === 'unknown' ? 'recorded, still unknown' : r.rule === null ? 'catalog' : 'listing_fields';
    out.push({ key: m.key, asin: m.asin, settledBy, reason: `${r.status}: ${r.reason}` });
  }
  return out;
}

/**
 * The two listings the owner's live deals hold (Nov 23, the installed app): each with the brand word the live record shows,
 * no manufacturer, and the answer key's verdict (fixtures/validation/labels-2026-11-18.json: both are the part's).
 */
export const LIVE_HELD: { model: string; listing: ListingIdentity; key: 'is' }[] = [
  {
    model: 'PBP004', key: 'is',
    listing: { asin: 'B09HDZ5MPV', title: 'TTI Ryobi PBP004 ONE+ High Performance 18 Volts Lithium-Ion 4.0 Ah Battery', brand: 'TTI', manufacturer: null, partNumber: null, model: null, numberOfItems: null, packageQuantity: null, source: 'keepa_catalog' },
  },
  {
    model: 'PCG002', key: 'is',
    listing: { asin: 'B0B1QRQYK2', title: 'ONEAND 18V Lithium-ION Charger PCG002', brand: 'ONEAND', manufacturer: null, partNumber: null, model: null, numberOfItems: null, packageQuantity: null, source: 'keepa_catalog' },
  },
];

/**
 * The narrow brand contradiction (verify.ts narrowBrandContradiction) on every row with a known answer, and on the two live
 * listings: right when it removes a listing the key says is not the part, wrong when it removes one the key says is.
 */
export function measureNarrowBrandRule(root = ROOT): { recorded: { right: number; wrong: number; unknown: number; newRight: number }; live: { right: number; wrong: number; unknown: number }; wrongRows: string[] } {
  const known = measureIdentity(root).rows.filter((r) => r.key !== 'uncertain');
  const recorded = { right: 0, wrong: 0, unknown: 0, newRight: 0 };
  const wrongRows: string[] = [];
  for (const r of known) {
    const fired = narrowBrandContradiction(r.want, r.listing) !== null;
    if (!fired) recorded.unknown += 1;
    else if (r.key === 'not') { recorded.right += 1; if (r.check.status !== 'contradicted') recorded.newRight += 1; }
    else { recorded.wrong += 1; wrongRows.push(`${r.asin} for ${r.model}: ${r.listing.title}`); }
  }
  const live = { right: 0, wrong: 0, unknown: 0 };
  for (const h of LIVE_HELD) {
    if (narrowBrandContradiction(wantedFor('RYOBI', h.model, new Map()), h.listing) === null) live.unknown += 1;
    else { live.wrong += 1; wrongRows.push(`${h.listing.asin} for ${h.model} (live): ${h.listing.title}`); }
  }
  return { recorded, live, wrongRows };
}

type Tally = { right: number; wrong: number; unknown: number };

/**
 * Rungs 0 and 1 (checkListingFields) without and with the brand aliases (core/src/keepa/brandAliases.ts), on every
 * recorded row with a known answer and on the two live listings: adopted only when `after` has 0 wrong.
 */
export function measureBrandAliases(root = ROOT): { before: Tally; after: Tally; liveBefore: Tally; liveAfter: Tally; changed: string[] } {
  const known = measureIdentity(root).rows.filter((r) => r.key !== 'uncertain');
  const tally = (): Tally => ({ right: 0, wrong: 0, unknown: 0 });
  const out = { before: tally(), after: tally(), liveBefore: tally(), liveAfter: tally(), changed: [] as string[] };
  const add = (t: Tally, v: Verdict) => { if (v === 'right' || v === 'wrong' || v === 'unknown') t[v] += 1; };
  const rows = [
    ...known.map((r) => ({ live: false, want: r.want, listing: r.listing, key: r.key, label: `${r.asin} for ${r.model}` })),
    ...LIVE_HELD.map((h) => ({ live: true, want: wantedFor('RYOBI', h.model, new Map()), listing: h.listing, key: h.key, label: `${h.listing.asin} for ${h.model} (live)` })),
  ];
  for (const r of rows) {
    const off = checkListingFields(r.want, r.listing, { aliases: false });
    const on = checkListingFields(r.want, r.listing);
    add(r.live ? out.liveBefore : out.before, verdictOf(r.key as 'is' | 'not', off));
    add(r.live ? out.liveAfter : out.after, verdictOf(r.key as 'is' | 'not', on));
    if (off.status !== on.status) out.changed.push(`${r.label}: ${off.status} -> ${on.status} (${on.reason})`);
  }
  return out;
}

type Key = 'is' | 'not' | 'uncertain';

/**
 * Every answer key the measurements use, by `${model}|${asin}`: fixtures/keepa/identity-labels.json, the validation labels
 * (fixtures/validation/labels-2026-11-18.json: correct is, uncertain uncertain) and the audit corpus
 * (fixtures/audit/corpus.json: part is, not-part not, uncertain uncertain). The first key read for a pair stands.
 */
export function answerKeys(root = ROOT): Map<string, Key> {
  const out = new Map<string, Key>();
  const put = (model: string, asin: string, k: Key) => { if (!out.has(`${model}|${asin}`)) out.set(`${model}|${asin}`, k); };
  for (const r of (read(join(root, 'fixtures/keepa/identity-labels.json')) as { rows: { asin: string; model: string; label: Key }[] }).rows) put(r.model, r.asin, r.label);
  const labels = (read(join(root, 'fixtures/validation/labels-2026-11-18.json')) as { labels: Record<string, Record<string, { correct: string[] | 'none'; uncertain?: string[] }>> }).labels;
  for (const bundle of Object.values(labels)) {
    for (const [model, l] of Object.entries(bundle)) {
      for (const a of l.correct === 'none' ? [] : l.correct) put(model, a, 'is');
      for (const a of l.uncertain ?? []) put(model, a, 'uncertain');
    }
  }
  const corpus = (read(join(root, 'fixtures/audit/corpus.json')) as { pairs: { part: { model: string }; listing: { asin: string }; label: string }[] }).pairs;
  for (const p of corpus) put(p.part.model, p.listing.asin, p.label === 'part' ? 'is' : p.label === 'not-part' ? 'not' : 'uncertain');
  return out;
}

/** A catalog check's reason that quotes the listing's fields: "Amazon's catalog lists brand RYOBI but manufacturer TTI; …". */
const QUOTES_MAKER = /^Amazon's (?:catalog|product page) lists brand (.+?) but manufacturer (.+?)(?:;|$)/;

export interface Scan5MakerRow {
  model: string;
  brand: string;
  asin: string;
  key: Key | 'no key';
  listing: ListingIdentity;
}

/**
 * The owner's fifth scan (fixtures/e2e-2026-11-23/after-scan5): every catalog check whose recorded reason quotes the
 * listing's manufacturer, as the listing it read. Only what the fixture holds word for word: the title and brand the
 * scan stored (scan/listings.json) and the brand and manufacturer the reason quotes. The part number and the counts were
 * not stored, so they are left empty: the check reached its manufacturer test only after a part number or model field
 * was the part's, so the real record carries more evidence than this, never less. With no part number, rung 1's title
 * rule is what confirms here.
 */
export function scan5MakerRows(root = ROOT): Scan5MakerRow[] {
  const dir = join(root, 'fixtures/e2e-2026-11-23/after-scan5/scan');
  const matches = read(join(dir, 'matches.json')) as [string, { brand: string; model: string; catalogChecks?: { asin: string; reason: string }[] }][];
  const listings = new Map(read(join(dir, 'listings.json')) as [string, { asin: string; brand: string | null; title: string }][]);
  const keys = answerKeys(root);
  const out: Scan5MakerRow[] = [];
  for (const [, m] of matches) {
    for (const c of m.catalogChecks ?? []) {
      const q = QUOTES_MAKER.exec(c.reason);
      const row = listings.get(c.asin);
      if (!q || !row) continue;
      out.push({
        model: m.model, brand: m.brand, asin: c.asin, key: keys.get(`${m.model}|${c.asin}`) ?? 'no key',
        listing: { asin: c.asin, title: row.title, brand: q[1]!, manufacturer: q[2]!, partNumber: null, model: null, numberOfItems: null, packageQuantity: null, source: 'keepa_catalog' },
      });
    }
  }
  return out;
}

export interface MakerValue {
  brand: 'RYOBI' | 'DEWALT';
  manufacturer: string;
  /** The listings carrying it, `${asin} (${where})`, each once. */
  listings: string[];
  reading: ReturnType<typeof makerReading>['as'];
}

/**
 * Every manufacturer value recorded with brand field RYOBI or DEWALT, per distinct listing: the recorded Keepa products
 * (the search and the product pulls), the two recorded SerpApi product pages, and the catalog checks of the owner's third
 * and fifth scans whose reason quotes it.
 */
export function manufacturerValues(root = ROOT): MakerValue[] {
  const seen = new Map<string, { brand: string; manufacturer: string; where: string }>();
  const add = (asin: string, brand: string | null, manufacturer: string | null, where: string) => {
    const b = (brand ?? '').replace(/^brand:\s*/i, '').trim().toUpperCase();
    if ((b !== 'RYOBI' && b !== 'DEWALT') || !manufacturer) return;
    const k = `${asin}|${manufacturer}`;
    if (!seen.has(k)) seen.set(k, { brand: b, manufacturer, where });
  };
  for (const f of ['product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB.json', 'product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB-stats.json']) {
    for (const p of parseProductResponse(read(join(root, 'fixtures/keepa', f)) as Record<string, unknown>).products) add(p.asin, p.brand ?? null, p.manufacturer ?? null, 'Keepa pull');
  }
  for (const p of parseSearchResponse(read(join(root, 'fixtures/keepa/search-RYOBI-PCL235B.json')) as Record<string, unknown>).products ?? []) {
    add(p.asin, p.brand ?? null, p.manufacturer ?? null, 'Keepa search');
  }
  for (const asin of ['B0B3JWF5ZV', 'B0B6Z2ZGVK']) {
    const l = identityFromSerpProduct(read(join(root, `fixtures/recorded/amazon-product-${asin}.json`)), asin);
    if (l) add(asin, l.brand, l.manufacturer, 'SerpApi page');
  }
  for (const scan of ['after-scan3', 'after-scan5']) {
    const matches = read(join(root, `fixtures/e2e-2026-11-23/${scan}/scan/matches.json`)) as [string, { catalogChecks?: { asin: string; reason: string }[] }][];
    for (const [, m] of matches) {
      for (const c of m.catalogChecks ?? []) {
        const q = QUOTES_MAKER.exec(c.reason);
        if (q) add(c.asin, q[1]!, q[2]!, `${scan} check`);
      }
    }
  }
  const by = new Map<string, MakerValue>();
  for (const [k, v] of seen) {
    const id = `${v.brand}|${v.manufacturer}`;
    const row = by.get(id) ?? { brand: v.brand as MakerValue['brand'], manufacturer: v.manufacturer, listings: [], reading: makerReading(v.brand, v.manufacturer).as };
    row.listings.push(`${k.split('|')[0]} (${v.where})`);
    by.set(id, row);
  }
  return [...by.values()].sort((a, b) => a.brand.localeCompare(b.brand) || b.listings.length - a.listings.length || a.manufacturer.localeCompare(b.manufacturer));
}

export interface MakerScore {
  rows: number;
  changed: number;
  right: number;
  wrong: number;
  unknown: number;
  lines: string[];
}

/**
 * The manufacturer rule (brandAliases.ts makerAgrees): rungs 0 and 1 without and with it, on every recorded row with an
 * answer key (measureIdentity), the two live listings, and the fifth scan's listings whose manufacturer a check quotes.
 * A changed row is right when the key says it is the part, wrong when it says it is not, unknown when the key is
 * uncertain or there is none. Adopted only at 0 wrong.
 */
export function measureManufacturerRule(root = ROOT): MakerScore {
  const catalog = new Map(
    (read(join(root, 'fixtures/e2e-2026-11-23/after-scan5/scan/catalog.json')) as [string, { model: string; isKit?: boolean; upc?: string | null }][]).map(([, c]) => [c.model, c]),
  );
  const rows: { want: ReturnType<typeof wantedFor>; listing: ListingIdentity; key: Key | 'no key'; label: string }[] = [
    ...measureIdentity(root).rows.map((r) => ({ want: r.want, listing: r.listing, key: r.key, label: `${r.asin} for ${r.model} (${r.set})` })),
    ...LIVE_HELD.map((h) => ({ want: wantedFor('RYOBI', h.model, new Map()), listing: h.listing, key: h.key, label: `${h.listing.asin} for ${h.model} (live)` })),
    ...scan5MakerRows(root).map((r) => ({ want: wantedFor(r.brand, r.model, catalog as never), listing: r.listing, key: r.key, label: `${r.asin} for ${r.model} (after-scan5)` })),
  ];
  const out: MakerScore = { rows: rows.length, changed: 0, right: 0, wrong: 0, unknown: 0, lines: [] };
  for (const r of rows) {
    const off = checkListingFields(r.want, r.listing, { makers: false });
    const on = checkListingFields(r.want, r.listing);
    if (off.status === on.status) continue;
    out.changed += 1;
    const says = on.status === 'confirmed' ? 'is' : on.status === 'contradicted' ? 'not' : null;
    const v = r.key !== 'is' && r.key !== 'not' ? 'unknown' : says === r.key ? 'right' : 'wrong';
    out[v] += 1;
    out.lines.push(`${r.label}, manufacturer ${r.listing.manufacturer}, key ${r.key}: ${off.status} -> ${on.status} (${v})`);
  }
  return out;
}

export interface DealReplay {
  key: string;
  model: string;
  before: string;
  after: string;
  buyNow: boolean;
  /** The parts the bundle counts whose listing is still not confirmed with the rule on, and why. */
  waiting: string[];
}

/**
 * The fifth scan's three RYOBI $99 deals the manufacturer field held (store/deals.json), judged again by the scan's own
 * rule (tracking/signals.ts bundleSignals): each part a catalog check quoting its manufacturer held is read again with the
 * rule on (scan5MakerRows: title, brand, manufacturer) and, when confirmed, marked as applyCatalogCheck marks it (grade
 * strong, verifiedBy). The history is the stored one, the sales figures the stored signal's (Keepa monthlySold per
 * listing), the owner's numbers the app's defaults ($20, 20%, 50 a month: the fixture holds no settings).
 */
export function replayScan5Deals(root = ROOT, keys = ['homedepot:341966856', 'homedepot:344305163', 'homedepot:341965772']): DealReplay[] {
  const dir = join(root, 'fixtures/e2e-2026-11-23/after-scan5');
  const deals = (read(join(dir, 'store/deals.json')) as { bundles: BundleRow[] }).bundles;
  type StoredVelocity = { asin: string | null; monthlySold: number | null; salesRank: number | null; offers: number | null; pulledAt: number | null };
  const tracking = read(join(dir, 'store/tracking.json')) as {
    history: Record<string, HistoryPoint[]>;
    signals: Record<string, { at: number; verdict?: string; options: { velocity: { parts: StoredVelocity[] } }[] }>;
  };
  const catalog = new Map(
    (read(join(dir, 'scan/catalog.json')) as [string, { model: string; isKit?: boolean; upc?: string | null }][]).map(([, c]) => [c.model, c]),
  );
  const reread = new Map(scan5MakerRows(root).map((r) => [`${r.model}|${r.asin}`, r]));
  const out: DealReplay[] = [];
  for (const key of keys) {
    const row = deals.find((b) => b.key === key);
    const stored = tracking.signals[key];
    if (!row || !stored) throw new Error(`after-scan5 holds no deal ${key}`);
    const waiting = new Set<string>();
    const confirm = (p: BundleRow['parts'][number]): BundleRow['parts'][number] => {
      if (p.asin === null || isConfirmedListing(p)) return p;
      const r = reread.get(`${p.model}|${p.asin}`);
      if (!r) { waiting.add(`${p.model} ${p.asin}: no recorded check quotes its fields`); return p; }
      const res = checkListingFields(wantedFor(row.brand, p.model, catalog as never), r.listing);
      if (res.status !== 'confirmed') { waiting.add(`${p.model} ${p.asin}: ${res.reason}`); return p; }
      return { ...p, grade: 'strong', verifiedBy: res.rule !== null ? 'listing_fields' : 'keepa_catalog', verifyEvidence: `${res.reason}: https://www.amazon.com/dp/${p.asin}` };
    };
    const next: BundleRow = { ...row, parts: row.parts.map(confirm), options: row.options.map((o) => ({ ...o, parts: o.parts.map(confirm) })) };
    const trends = new Map<string, PartTrend>();
    for (const o of stored.options) {
      for (const v of o.velocity.parts) {
        if (v.asin && v.pulledAt !== null) {
          trends.set(v.asin, { asin: v.asin, amazonPrice: null, salesRank: v.salesRank, offerCount: null, pulledAt: v.pulledAt, monthlySold: v.monthlySold, buyBoxEligibleOffers: v.offers });
        }
      }
    }
    const trend: TrendLookup = (asin) => trends.get(asin);
    const s = bundleSignals({
      row: next, history: tracking.history[key] ?? [], reviewOpen: false, trend, alerts: DEFAULT_SETTINGS.alerts, now: stored.at + 60_000, keepa: true,
    });
    out.push({ key, model: row.model, before: stored.verdict ?? '', after: s.verdict ?? '', buyNow: s.buyNow !== null, waiting: [...waiting] });
  }
  return out;
}

if (process.argv[1] && /measure-autoconfirm\.ts$/.test(process.argv[1])) {
  console.log('Manufacturer values recorded with brand RYOBI or DEWALT (distinct listings):');
  for (const v of manufacturerValues()) console.log(`  ${v.brand.padEnd(6)} ${v.manufacturer.padEnd(12)} ${String(v.listings.length).padStart(2)}  ${v.reading.padEnd(7)} ${v.listings.join(', ')}`);
  console.log(`  manufacturer aliases adopted: ${Object.entries(MANUFACTURER_ALIASES).map(([b, a]) => `${b} ${a.map((x) => x.maker).join(', ')}`).join('; ')}`);
  const mr = measureManufacturerRule();
  console.log(`Manufacturer rule, rungs 0 and 1, ${mr.rows} rows: ${mr.changed} changed: ${mr.right} right, ${mr.wrong} wrong, ${mr.unknown} unknown`);
  for (const l of mr.lines) console.log(`  ${l}`);
  for (const d of replayScan5Deals()) {
    console.log(`Replay ${d.key} ${d.model}: ${d.buyNow ? 'buy now' : 'still waits'}`);
    console.log(`  before: ${d.before}`);
    console.log(`  after:  ${d.after}`);
    for (const w of d.waiting) console.log(`  waiting: ${w}`);
  }
  console.log('');
  const a = measureBrandAliases();
  const t = (x: Tally) => `${x.right} right, ${x.wrong} wrong, ${x.unknown} unknown`;
  console.log(`Brand aliases, rungs 0 and 1, recorded rows: before ${t(a.before)}; after ${t(a.after)}. Live listings: before ${t(a.liveBefore)}; after ${t(a.liveAfter)}.`);
  for (const c of a.changed) console.log(`  ${c}`);
  const n = measureNarrowBrandRule();
  console.log(`Narrow brand contradiction, recorded rows: ${n.recorded.right} right (${n.recorded.newRight} not already contradicted), ${n.recorded.wrong} wrong, ${n.recorded.unknown} unknown; the two live listings: ${n.live.wrong} wrong, ${n.live.unknown} unknown`);
  for (const w of n.wrongRows) console.log(`  wrong: ${w}`);
  const { scores, rung0 } = measureRung1();
  console.log(`Rung 0, the catalog check, on rows with a known answer: ${rung0.right} right, ${rung0.wrong} wrong, ${rung0.unknown} unknown`);
  console.log('Rung 1 on the rows rung 0 left unknown, one sub-rule at a time:');
  for (const s of scores) {
    console.log(`  ${s.rule.padEnd(9)} ${s.rows} rows: ${s.right} right, ${s.wrong} wrong, ${s.unknown} unknown${s.rule === 'adopted' ? ` (${ADOPTED_RULES.join(', ')})` : ''}`);
    for (const r of s.wrongRows) console.log(`    wrong: ${r.set} ${r.asin} for ${r.model} (key ${r.key}): ${r.listing.title}`);
  }
  const replay = replayScan3();
  const by = (k: ReplayRow['settledBy']) => replay.filter((r) => r.settledBy === k).length;
  console.log('');
  console.log(`Replay, after-scan3: ${replay.length} title matches: ${by('catalog')} settled by the catalog check, ${by('listing_fields')} by rung 1, ${by('recorded, still unknown')} recorded and still unknown, ${by('needs a live read')} need a live read`);
  const live = replay.filter((r) => r.settledBy === 'needs a live read');
  console.log(`  of the ${live.length} that need a live read (a Keepa pull, 1 token, then rung 1): ${live.filter((r) => r.fromSearchRow === 'would pass').length} pass rung 1 on the stored search row, ${live.filter((r) => r.fromSearchRow === 'stopped').length} are stopped there (rung 2 or 3, or the owner)`);
  if (process.argv.includes('--rows')) for (const r of replay) console.log(`  ${r.key.padEnd(20)} ${r.asin} ${r.settledBy}: ${r.reason}`);
}
