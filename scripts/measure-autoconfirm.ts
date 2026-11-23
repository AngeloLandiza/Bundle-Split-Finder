// npm run measure:autoconfirm. Free, no network, writes nothing.
// Measures rung 1 of the listing ladder (core/src/keepa/listingFields.ts) on every recorded row with a known answer
// (scripts/measure-identity.ts measureIdentity: the Keepa search, its labels, the three pulls, the two SerpApi pages and
// the validation search rows), one sub-rule at a time, on the rows the catalog check left unknown: right, wrong, unknown.
// A sub-rule is adopted only at zero wrong (docs/decisions.md). Then the replay on the owner's third scan
// (fixtures/e2e-2026-11-23/after-scan3): how many of its title matches each rung would settle offline.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ADOPTED_RULES, checkListingFields, type FieldRule } from '../core/src/keepa/listingFields';
import { identityFromKeepa, identityFromSerpProduct, narrowBrandContradiction, type ListingIdentity } from '../core/src/keepa/verify';
import { parseProductResponse, parseSearchResponse } from '../core/src/keepa/parse';
import { wantedFor } from '../core/src/scan/classify';
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

if (process.argv[1] && /measure-autoconfirm\.ts$/.test(process.argv[1])) {
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
