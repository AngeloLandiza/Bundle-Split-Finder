// npx tsx scripts/replay-suggestions.ts [data folder]. Free, no network, writes nothing.
// Suggested prices and "answer once" (Nov 23), replayed on a copy of the app's data folder (default: the owner's scan-3
// store, fixtures/e2e-2026-11-23/after-scan3) with today's code:
//   1. the bundles missing a price, and how many of them get a suggestion of each kind from what is stored now; what the
//      drip's 1-token average pulls would add (inactive listings with no stored average); and, as a what-if, the eBay
//      listings recorded for the validation set on Nov 19 (fixtures/ebay, with their labels) standing in for the eBay pass.
//   2. the open questions, and how many one answer per distinct part would settle.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildReport } from '../core/src/scan/report';
import { withdrawUnreadSplitQuestions } from '../core/src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type BundleRow, type EbayJudgedListing, type ScanStore } from '../core/src/scan/types';
import { loadScanFolder } from './data-folder';
import { ROOT } from './node-store';

interface RecordedItem { itemId: string; title: string; price: number | null; currency: string; url: string; soldQuantity: number | null }

/** The eBay listings recorded on Nov 19 for `model`, each with its labelled verdict, as the eBay pass would store them. */
function recordedEbay(model: string): EbayJudgedListing[] {
  const rec = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'ebay', 'validation-2026-11-19.json'), 'utf8')) as { parts: Record<string, { items: Record<string, RecordedItem> }> };
  const labels = (JSON.parse(readFileSync(join(ROOT, 'fixtures', 'ebay', 'labels.json'), 'utf8')) as { labels: { itemId: string; model: string; verdict: 'match' | 'not_match' | 'unsure' }[] }).labels;
  return labels.filter((l) => l.model === model && rec.parts[model]?.items[l.itemId]).map((l) => {
    const it = rec.parts[model]!.items[l.itemId]!;
    return { itemId: it.itemId, title: it.title, price: it.price, currency: it.currency, soldQuantity: it.soldQuantity, url: it.url, verdict: l.verdict, reasons: [] };
  });
}

function tally(rows: BundleRow[]): { missing: number; amazon: number; ebay: number; any: number; all: number } {
  const missing = rows.filter((b) => b.incomplete !== undefined);
  const has = (b: BundleRow, kind: string) => b.parts.some((p) => p.priceSuggestion?.kind === kind);
  return {
    missing: missing.length,
    amazon: missing.filter((b) => has(b, 'amazon_average')).length,
    ebay: missing.filter((b) => has(b, 'ebay_median')).length,
    any: missing.filter((b) => b.parts.some((p) => p.priceSuggestion)).length,
    all: missing.filter((b) => b.incomplete!.ifAccepted !== undefined).length,
  };
}

const line = (t: ReturnType<typeof tally>): string =>
  `${t.missing} missing a price: ${t.amazon} with a Keepa-average suggestion, ${t.ebay} with an eBay-middle suggestion (${t.any} with any); ${t.all} where every unpriced part has one (the "if accepted" line).`;

export async function replay(dir: string): Promise<string[]> {
  const out: string[] = [];
  const store: ScanStore = await loadScanFolder(dir);
  // Today's rules over the stored questions, as the next scan would read them.
  await withdrawUnreadSplitQuestions(store, Date.UTC(2026, 10, 23, 20));
  const rows = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles;
  out.push('== 1. Suggested prices', `From what is stored: ${line(tally(rows))}`);

  const missing = rows.filter((b) => b.incomplete !== undefined);
  const unpriced = missing.flatMap((b) => b.incomplete!.unpriced.map((u) => ({ b, u, p: b.parts.find((p) => p.model === u.model)! })));
  const inactive = new Map<string, string>();
  for (const { u, p } of unpriced) if (u.state === 'inactive' && p.asin && !p.priceSuggestion) inactive.set(p.asin, u.model);
  const byState = (s: string) => new Set(unpriced.filter((x) => x.u.state === s).map((x) => x.u.model));
  out.push(
    `Unpriced parts (distinct): ${byState('inactive').size} inactive listing, ${byState('no_listing').size} no listing, ${byState('review').size} in Review, ${byState('waiting').size} waiting for a lookup.`,
    `Inactive listings with no stored Keepa average: ${inactive.size} (${[...inactive.values()].join(', ')}): the drip pulls each once, ${inactive.size} tokens. The store holds no Keepa trend, so how many have a 90- or 30-day New average is not known from it.`,
    `If each had one, ${missing.filter((b) => b.incomplete!.unpriced.some((u) => u.state === 'inactive')).length} bundles would get a Keepa-average suggestion.`,
  );

  // What-if: the eBay pass's listings for the no-listing parts, from the Nov 19 recordings.
  const noListing = [...byState('no_listing')];
  const recorded = noListing.map((m) => ({ m, listings: recordedEbay(m) }));
  const withEbay: ScanStore = await loadScanFolder(dir);
  await withdrawUnreadSplitQuestions(withEbay, Date.UTC(2026, 10, 23, 20));
  for (const { m, listings } of recorded) {
    if (listings.length === 0) continue;
    const brand = missing.find((b) => b.incomplete!.unpriced.some((u) => u.model === m))!.brand;
    await withEbay.putEbayValue({ key: `${brand}:${m}`, brand, model: m, value: null, listings, notJudged: 0, complete: true, checkedAt: Date.UTC(2026, 10, 19) });
  }
  const what = (await buildReport(withEbay, DEFAULT_SCAN_SETTINGS)).bundles;
  out.push(
    `No-listing parts with eBay listings recorded on Nov 19: ${recorded.filter((r) => r.listings.length > 0).map((r) => `${r.m} (${r.listings.filter((l) => l.verdict === 'match').length} of ${r.listings.length} the same)`).join(', ') || 'none'}; not recorded: ${recorded.filter((r) => r.listings.length === 0).map((r) => r.m).join(', ') || 'none'}.`,
    `With them as the stored eBay listings: ${line(tally(what))}`,
  );
  for (const b of what.filter((x) => x.parts.some((p) => p.priceSuggestion))) {
    const s = b.parts.filter((p) => p.priceSuggestion).map((p) => `${p.model}: ${p.priceSuggestion!.label}`).join('; ');
    const a = b.incomplete?.ifAccepted ? `; if accepted ${a2(b.incomplete.ifAccepted.profit)} est.` : '';
    out.push(`  ${b.model}  ${s}${a}`);
  }

  // 2. Answer once.
  const open = (await store.listReview()).filter((q) => q.answer === null);
  const split = open.filter((q) => q.kind === 'split');
  const narrowed = split.filter((q) => (q.unsettledParts ?? []).length > 0);
  const parts = new Map<string, string[]>();
  for (const q of narrowed) for (const u of q.unsettledParts!) parts.set(u.model, [...(parts.get(u.model) ?? []), q.id]);
  const settledByOne = narrowed.filter((q) => q.unsettledParts!.every((u) => (parts.get(u.model) ?? []).length > 1)).length;
  const matchQs = open.filter((q) => q.kind === 'match');
  const heldBy = (key: string) => rows.filter((b) => b.parts.some((p) => `${b.brand}:${p.model}` === key)).length;
  out.push(
    '', '== 2. Answer once',
    `${open.length} open questions: ${split.length} about what is inside, ${matchQs.length} about an Amazon listing.`,
    `${narrowed.length} of the ${split.length} ask about named parts Home Depot did not confirm: ${[...parts].map(([m, ids]) => `${m} in ${ids.length}`).join(', ')}.`,
    `One answer per distinct part: ${parts.size} answers for ${narrowed.length} questions; ${narrowed.length - parts.size} would be settled without asking (${settledByOne} questions share every part they ask about with another).`,
    `The other ${split.length - narrowed.length} have no single part to remember (no reading, or the page names a model no part explains): they are answered one by one, as before.`,
    `Match questions are kept per model already: ${matchQs.map((q) => `${q.model} (held by ${heldBy(q.subject)} ${heldBy(q.subject) === 1 ? 'bundle' : 'bundles'})`).join(', ')}.`,
  );
  return out;
}

const a2 = (n: number): string => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(2)}`;

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dir = process.argv[2] ?? join(ROOT, 'fixtures', 'e2e-2026-11-23', 'after-scan3');
  for (const l of await replay(dir)) console.log(l);
}
