// Builds desktop-ui/src/api/mockReal.json from the owner's real data (fixtures/e2e-2026-11-23): after two scans, the
// open Review questions with their AI suggestions and the 53 bundles as Deals rows (`review`, `rows`); and (Nov 23)
// after the third scan (after-scan3), every deal and its detail as the agent's own views give them from the report
// today's code builds (`scan3`), with that scan's open questions. The desktop UI shows `scan3` with `?mock=real`, so a
// screen is judged on real titles, real figures and real reasons, not on made-up ones.
// Free, offline: it reads files only. Run: npx tsx scripts/mock-real.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { dealDetail, dealsResponse, reviewResponse } from '../agent/views';
import { DEFAULT_FEES } from '../core/src/money';
import { buildReport } from '../core/src/scan/report';
import { bogoGroups } from '../core/src/tracking/bogoPairs';
import { DEFAULT_SCAN_SETTINGS } from '../core/src/scan/types';
import { loadScanFolder, readStoreFile } from './data-folder';

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

// ---------------------------------------------------------------- after the third scan (Nov 23)

const DIR3 = `${dir}/after-scan3`;
const report = await buildReport(await loadScanFolder(DIR3), DEFAULT_SCAN_SETTINGS);
const stored3 = readStoreFile<any>(DIR3, 'deals.json', { at: null, lookups: {} });
const review3 = readStoreFile<any>(DIR3, 'review.json', { at: null, questions: [], ebayQuestions: [], evidence: {} });
// The stored tracking was worked out from the old report (a part with no price at $0): what follows from the report is
// worked out again as the agent does after every report (work.ts), and what cannot be (FBA fees, signals) is kept only
// for a bundle that still has an estimate.
const tracking3 = readStoreFile<any>(DIR3, 'tracking.json', undefined);
if (tracking3) {
  const estimated = new Set(report.bundles.filter((b) => b.estimate !== null).map((b) => b.key));
  const keep = (rec: Record<string, unknown>) => Object.fromEntries(Object.entries(rec ?? {}).filter(([k]) => estimated.has(k)));
  const groups = Object.fromEntries(bogoGroups(Object.values(tracking3.bogoPairs ?? {}) as any, report.bundles).map((g) => [g.id, g]));
  tracking3.derived = { ...tracking3.derived, fba: keep(tracking3.derived?.fba), groups };
  tracking3.signals = keep(tracking3.signals);
}
const data3: any = {
  deals: { at: stored3.at, bundles: report.bundles, auditAt: null, auditBundles: [], lookups: stored3.lookups ?? {} },
  review: { ...review3, ebayQuestions: [] },
  suggestions,
  runtime: { lastJob: null },
  settings: { settings: { fees: DEFAULT_FEES, searchesPerScan: 18 }, alerts: {}, ai: data.settings.ai },
  tracking: tracking3,
};
const deals3 = dealsResponse(data3, { sort: 'profit' }, Date.parse('2026-11-23T14:00:00Z'));
const details3: Record<string, any> = {};
for (const r of deals3.rows) {
  const d: any = dealDetail(data3, r.id);
  if (!d) continue;
  // What the inspector reads of the other ways is their figures and labels, not their parts again; the history is not drawn here.
  d.bundle = { ...d.bundle, options: d.bundle.options.map((o: any, i: number) => (i === 0 ? o : { ...o, parts: [] })) };
  d.history = [];
  // A BOGO group lists every free-tool choice on every one of its pairs: its first five are enough to draw it.
  if (d.bogoGroup) d.bogoGroup = { ...d.bogoGroup, choices: d.bogoGroup.choices.slice(0, 5) };
  details3[r.id] = d;
}
const review3Out = reviewResponse({ ...data3, settings: data.settings });
for (const q of review3Out.questions as any[]) {
  q.item = { kind: q.item.kind, question: { openedAt: q.item.question.openedAt } };
  q.evidence = q.evidence.slice(0, 4);
  q.suggestion = null;
}

writeFileSync('desktop-ui/src/api/mockReal.json', `${JSON.stringify({ review: out, rows, scan3: { deals: deals3, details: details3, review: review3Out } })}\n`);
console.log(`${out.questions.length} questions, ${rows.length} rows; after the third scan: ${deals3.rows.length} deals, ${review3Out.questions.length} questions`);
