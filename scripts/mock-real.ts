// Builds desktop-ui/src/api/mockReal.json from the owner's real data after two scans (fixtures/e2e-2026-11-23): the
// open Review questions with their AI suggestions, and the 53 bundles as Deals rows. The desktop UI shows it with
// `?mock=real` so a screen is judged on real titles, real quotes and real reasons, not on made-up ones.
// Free, offline: it reads files only. Run: npx tsx scripts/mock-real.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { reviewResponse } from '../agent/views';

const dir = 'fixtures/e2e-2026-11-23';
const read = (p: string): any => JSON.parse(readFileSync(`${dir}/${p}`, 'utf8'));

const review = read('store/review.json');
const suggestions: any[] = read('store/suggestions.json');
const bundles: [string, any][] = read('scan/bundles.json');
const open = new Set<string>(review.questions.filter((q: any) => q.answer === null).map((q: any) => q.subject));

// Only what the views read of a bundle; the rest of the scan store is not needed to list questions.
const stand = bundles.map(([key, b]) => ({ key, brand: b.brand, model: b.model, link: b.link, parts: [] }));
const data: any = {
  review: { ...review, ebayQuestions: [] },
  suggestions,
  deals: { at: null, bundles: stand, auditAt: null, auditBundles: [] },
  settings: { ai: { assist: { model: 'claude-sonnet-4-5' }, research: { model: 'claude-opus-5-5' } } },
};
const out = reviewResponse(data);
for (const q of out.questions as any[]) {
  // The scan's own page text is large and the UI shows only the first lines; the stored question is not needed.
  q.item = { kind: q.item.kind, question: { openedAt: q.item.question.openedAt } };
  q.evidence = q.evidence.slice(0, 4);
  const rec = q.suggestion;
  if (rec) {
    const s = rec.suggestion;
    const ledger = (s.research?.ledger ?? []).map((l: any) => ({ id: l.id, label: l.label, url: l.url }));
    rec.suggestion = { ...s, usage: undefined, research: ledger.length ? { ledger } : undefined };
  }
}

// One row per bundle, as the agent's rows read before any Amazon lookup: a bundle with an open question is a question,
// the rest wait for a lookup of their parts.
const partPrices = new Map<string, any>(read('scan/partPrices.json'));

/** How the split is known, from what the scan read: a half Home Depot sells under exactly its model, and the page's own Includes line. */
function splitEvidence(b: any): { kind: string; text: string; url?: string }[] {
  const out: { kind: string; text: string; url?: string }[] = [];
  for (const half of String(b.model).split('-')) {
    const p = partPrices.get(`${b.brand}:${half}`);
    if (b.model.includes('-') && p && p.price !== null) out.push({ kind: 'hd_part_page', text: `Home Depot sells ${half} on its own: ${p.title}`, url: p.link });
  }
  const inc = (b.page?.bullets ?? []).find((x: string) => /^Includes?:?\s/i.test(x));
  if (inc) out.push({ kind: 'page_quote', text: inc.slice(0, 220), url: b.link });
  return out;
}

const rows = bundles.map(([key, b]) => {
  const asked = open.has(key);
  const parts = (b.split?.components ?? []).length;
  return {
    _parts: b.split?.components ?? [],
    _evidence: splitEvidence(b),
    id: key,
    bundle: { brand: b.brand, model: b.model, title: b.title, itemId: b.itemId, link: b.link },
    section: asked ? 'split' : 'waiting',
    price: b.price,
    regularPrice: b.regularPrice,
    off: b.percentOff,
    matchState: asked ? null : `${parts} parts to look up`,
    profit: null,
    roi: null,
    roiRange: { low: null, high: null },
    needsAnswer: asked,
    updatedAt: new Date(b.seenAt).toISOString(),
    lookup: asked ? null : { searches: Math.max(1, parts) },
  };
});

writeFileSync('desktop-ui/src/api/mockReal.json', `${JSON.stringify({ review: out, rows }, null, 1)}\n`);
console.log(`${out.questions.length} questions, ${rows.length} rows`);
