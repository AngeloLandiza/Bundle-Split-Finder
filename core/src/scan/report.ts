// Turn what a scan left in the store into ranked rows. Reads only; never searches.
// Profit figures are estimates from fee settings, not the seller's real fees.

import { evaluateBundle, type PricedListing } from '../scanPlan';
import { choicesOf } from './answers';
import { componentCounts } from './classify';
import {
  type BundleRecord,
  type BundleRow,
  type PartAvailability,
  type PartRow,
  type ReportSection,
  partKey,
  type ScanReport,
  type ScanSettings,
  type ScanStore,
} from './types';

const SECTION_RANK: Record<ReportSection, number> = { confirmed: 0, inactive_listing: 1, missing_listing: 2, split: 3 };

async function partRows(store: ScanStore, brand: string, components: string[]): Promise<PartRow[]> {
  const counts = componentCounts(components);
  const rows: PartRow[] = [];
  for (const model of Object.keys(counts)) {
    const match = await store.getMatch(partKey(brand, model));
    const price = match?.asin ? await store.getPrice(match.asin) : undefined;
    const listing = match?.asin ? await store.getListing(match.asin) : undefined;
    let availability: PartAvailability = 'missing';
    if (match?.status === 'matched' && match.asin !== null) {
      availability = price !== undefined && price.price !== null && price.seenAt === price.checkedAt ? 'active' : 'inactive';
    }
    rows.push({
      model,
      qty: counts[model]!,
      status: match?.status ?? 'unmatched',
      availability,
      asin: match?.asin ?? null,
      grade: match?.grade ?? null,
      price: price?.price ?? null,
      priceSeenAt: price?.seenAt ?? null,
      image: listing?.image ?? null,
    });
  }
  return rows;
}

// A bundle with no parts is never confirmed, and neither is one without its own price.
function sectionOf(parts: PartRow[], bundlePrice: number | null): ReportSection {
  if (parts.length === 0) return 'split';
  if (parts.some((p) => p.availability === 'missing')) return 'missing_listing';
  if (parts.some((p) => p.availability === 'inactive')) return 'inactive_listing';
  return bundlePrice === null ? 'inactive_listing' : 'confirmed';
}

async function bundleRow(store: ScanStore, settings: ScanSettings, b: BundleRecord): Promise<BundleRow> {
  const base = {
    key: b.key, itemId: b.itemId, brand: b.brand, model: b.model, title: b.title, link: b.link,
    price: b.price, regularPrice: b.regularPrice, percentOff: b.percentOff,
  };
  const split = b.split;
  if (!split || split.status !== 'resolved') {
    return { ...base, status: 'needs_review', section: 'split', parts: [], estimate: null, uncovered: [] };
  }
  const parts = await partRows(store, b.brand, split.components);
  if (b.price === null) {
    return { ...base, status: 'partial', section: sectionOf(parts, b.price), parts, estimate: null, uncovered: parts.map((p) => p.model) };
  }
  const priced: PricedListing[] = [];
  for (const p of parts) {
    if (p.availability === 'active' && p.asin !== null && p.price !== null) {
      priced.push({ asin: p.asin, covers: { [p.model]: 1 }, price: p.price });
    }
  }
  const evaluation = evaluateBundle(b.price, componentCounts(split.components), priced, settings.fees, settings.liquidationRate);
  return {
    ...base,
    status: evaluation.uncovered.length === 0 ? 'complete' : 'partial',
    section: sectionOf(parts, b.price),
    parts,
    estimate: evaluation.result,
    uncovered: evaluation.uncovered,
  };
}

export async function buildReport(store: ScanStore, settings: ScanSettings): Promise<ScanReport> {
  const bundles: BundleRow[] = [];
  for (const b of await store.listBundles()) bundles.push(await bundleRow(store, settings, b));
  bundles.sort((a, b) => {
    if (a.section !== b.section) return SECTION_RANK[a.section] - SECTION_RANK[b.section];
    const pa = a.estimate?.profit ?? -Infinity;
    const pb = b.estimate?.profit ?? -Infinity;
    if (pa !== pb) return pb > pa ? 1 : -1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const review = (await store.listReview())
    .filter((r) => r.answer === null)
    // An item saved before step 5 has no choices stored.
    .map((r) => ({ ...r, choices: choicesOf(r) }))
    .sort((a, b) => a.openedAt - b.openedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { bundles, review };
}
