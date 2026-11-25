// Nov 25: a part's Home Depot barcode in its Amazon lookup, as a way to find candidates and never as proof.
//
// The lookup (keepa/fetchStep.ts keepaPartLookup) asks Keepa by the part's barcode before any term search; its products
// are candidates exactly as search rows are (applyLookup grades them, unchanged). Here, after that:
//   1. the ladder, unchanged and free: each product the code returned is read against every automatic title match or
//      question that holds it (catalogCheck.ts applyCatalogCheck), as any Keepa product a scan pulls is. A confirmation
//      whose listing also holds Home Depot's barcode says both in its evidence. A barcode alone confirms nothing.
//   2. the record (MatchRecord.barcodeLookup): each product, whether its catalog barcodes hold the part's, the matcher's
//      grade, the ladder's verdict on its fields, and whether the match ended on it confirmed, in words ("same barcode as
//      Home Depot's page; not confirmed because ..."). A later script counts how often "same barcode" agreed with the
//      ladder and with the owner's answers; until that is measured at zero wrong, the barcode decides nothing.

import type { Catalog } from '../decompose';
import { toUpc12 } from '../identifiers';
import type { KeepaLookupAsk } from '../keepa/fetchStep';
import { checkListingFields } from '../keepa/listingFields';
import { identityFromKeepa } from '../keepa/verify';
import { grade, modelForms } from '../match';
import type { SearchResult } from '../serpapi/client';
import { parseAmazonSearch } from '../serpapi/parsers';
import { serpApiSearchBodyFromKeepa } from '../keepa/amazon';
import { amazonListingLink, applyCatalogCheck, LADDER_VERSION } from './catalogCheck';
import { wantedFor } from './classify';
import { type BarcodeLookupRecord, type BarcodeProductRecord, type MatchRecord, partKey, type ScanJob, type ScanStore, type VerifiedBy } from './types';

/** What confirms a listing for a buy (tracking/signals.ts CONFIRMING_SOURCES, less the owner: an automatic lookup's record). */
const LADDER_SOURCES: readonly VerifiedBy[] = ['keepa_catalog', 'serpapi_product', 'listing_fields'];

/**
 * The barcode Home Depot's page states for the part: on its part price record or its catalog entry, for the model or (RYOBI)
 * its other written form (match.ts modelForms). Null when none is stored, or when two stored barcodes disagree (no guess).
 */
export async function partBarcode(store: ScanStore, brand: string, model: string): Promise<string | null> {
  const codes = new Set<string>();
  for (const form of modelForms(brand, model)) {
    const key = partKey(brand, form);
    for (const raw of [(await store.getPartPrice(key))?.upc, (await store.getCatalogEntry(key))?.upc]) {
      const code = toUpc12(raw ?? null);
      if (code !== null) codes.add(code);
    }
  }
  return codes.size === 1 ? [...codes][0]! : null;
}

/** What a part's Keepa lookup is asked with: its barcode when one is stored, and the part as the matcher wants it. */
export async function lookupAsk(ctx: { store: ScanStore; catalog: Catalog }, part: { brand: string; model: string }): Promise<KeepaLookupAsk> {
  const barcode = await partBarcode(ctx.store, part.brand, part.model);
  return { ...(barcode !== null ? { barcode } : {}), want: wantedFor(part.brand, part.model, ctx.catalog) };
}

const SAME = (code: string) => `same barcode as Home Depot's page (${code})`;

/** A confirmation's evidence with the barcode said too, before its link: "…, part number DCF850B; same barcode as …: <link>". */
function withBarcode(evidence: string | undefined, asin: string, code: string): string | undefined {
  if (evidence === undefined || evidence.includes(SAME(code))) return evidence;
  const tail = `: ${amazonListingLink(asin)}`;
  return evidence.endsWith(tail) ? `${evidence.slice(0, -tail.length)}; ${SAME(code)}${tail}` : `${evidence}; ${SAME(code)}`;
}

/**
 * After applyLookup: the ladder on the code's products (free), then the record. Counts what the catalog check verified or
 * removed on `tally`, as the scan's noteCatalog does. Nothing when the lookup asked by no barcode. Returns the record.
 */
export async function applyBarcodeFinding(
  ctx: { store: ScanStore; catalog: Catalog; now: () => number }, part: { brand: string; model: string }, result: SearchResult,
  tally: Pick<ScanJob, 'matchesVerified' | 'matchesRemoved'> = {},
): Promise<BarcodeLookupRecord | null> {
  const b = result.barcode;
  if (!b) return null;
  const products = result.keepaProducts ?? [];
  for (const p of products) {
    const outcomes = await applyCatalogCheck(ctx, identityFromKeepa(p));
    if (outcomes.some((o) => o.change === 'verified')) tally.matchesVerified = (tally.matchesVerified ?? 0) + 1;
    if (outcomes.some((o) => o.change === 'removed')) tally.matchesRemoved = (tally.matchesRemoved ?? 0) + 1;
  }
  const key = partKey(part.brand, part.model);
  const match = await ctx.store.getMatch(key);
  if (!match) return null;
  const want = wantedFor(part.brand, part.model, ctx.catalog);
  const rows = new Map(parseAmazonSearch(serpApiSearchBodyFromKeepa(products)).map((r) => [r.asin, r] as const));
  const confirmedOn = (asin: string): boolean =>
    match.status === 'matched' && match.asin === asin && match.verifiedBy !== undefined && LADDER_SOURCES.includes(match.verifiedBy);
  const records: BarcodeProductRecord[] = products.map((p) => {
    const row = rows.get(p.asin);
    const graded = row ? grade(want, row) : { grade: 'reject' as const, reasons: ['no title'] };
    const check = checkListingFields(want, identityFromKeepa(p));
    const same = b.products.find((x) => x.asin === p.asin)?.sameBarcode ?? false;
    const confirmed = confirmedOn(p.asin);
    return { asin: p.asin, sameBarcode: same, grade: graded.grade, check: check.status, confirmed, note: noteOf(b.code, same, confirmed, graded, check, match, p.asin) };
  });
  const record: BarcodeLookupRecord = {
    code: b.code, at: ctx.now(), via: b.via, codeTokens: b.codeTokens, searchTokens: b.searchTokens, ladder: LADDER_VERSION, products: records,
  };
  const sameConfirmed = records.find((r) => r.sameBarcode && r.confirmed);
  const next: MatchRecord = { ...match, barcodeLookup: record };
  if (sameConfirmed) {
    const evidence = withBarcode(match.verifyEvidence, sameConfirmed.asin, b.code);
    if (evidence !== undefined) next.verifyEvidence = evidence;
  }
  await ctx.store.putMatch(next);
  return record;
}

/**
 * What the stored records say about "same barcode" so far, for the measurement that must come before it decides anything:
 * same-barcode products, how many of them the ladder confirmed and how many it did not, and, on the parts the owner has
 * answered (decidedBy 'user'), how many same-barcode products are the listing he chose and how many are not.
 */
export interface BarcodeTally {
  sameBarcode: number;
  ladderConfirmed: number;
  ladderNotConfirmed: number;
  ownerAgreed: number;
  ownerDisagreed: number;
}

export function barcodeTally(matches: readonly MatchRecord[]): BarcodeTally {
  const t: BarcodeTally = { sameBarcode: 0, ladderConfirmed: 0, ladderNotConfirmed: 0, ownerAgreed: 0, ownerDisagreed: 0 };
  for (const m of matches) {
    for (const p of m.barcodeLookup?.products ?? []) {
      if (!p.sameBarcode) continue;
      t.sameBarcode += 1;
      if (p.confirmed) t.ladderConfirmed += 1;
      else t.ladderNotConfirmed += 1;
      if (m.decidedBy !== 'user') continue;
      if (m.status === 'matched' && m.asin === p.asin) t.ownerAgreed += 1;
      else t.ownerDisagreed += 1;
    }
  }
  return t;
}

/** One product's record in words: whether it has the part's barcode, and what the matcher and the ladder made of it. */
function noteOf(
  code: string, same: boolean, confirmed: boolean, graded: { grade: string; reasons: string[] },
  check: { status: string; reason: string }, match: MatchRecord, asin: string,
): string {
  const head = same ? SAME(code) : `its catalog barcodes do not hold Home Depot's ${code}`;
  if (confirmed) return `${head}; confirmed: ${match.verifyEvidence ?? check.reason}`;
  let why: string;
  if (graded.grade === 'reject') {
    const catalog = check.status === 'confirmed' ? `Amazon's catalog alone would confirm it (${check.reason})` : `Amazon's catalog: ${check.reason}`;
    why = `the matcher rejects its title (${graded.reasons.join('; ')}); ${catalog}`;
  } else if (match.status === 'matched' && match.asin === asin) {
    why = `the ladder left it ${check.status}: ${check.reason}`;
  } else if (match.status === 'matched' && match.asin !== null) {
    why = `the part's listing is ${match.asin}; Amazon's catalog: ${check.reason}`;
  } else if (match.status === 'review') {
    why = `it waits in Review with the other listings; Amazon's catalog: ${check.reason}`;
  } else {
    why = `the ladder did not keep it (${check.status}: ${check.reason})`;
  }
  return `${head}; not confirmed because ${why}`;
}
