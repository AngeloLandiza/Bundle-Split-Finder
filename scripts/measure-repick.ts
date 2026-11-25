// Measures the audit findings the app acts on by itself (core/src/audit/withdraw.ts) on every answer key, before they are
// adopted: how many listings each rule withdraws, and how many of those the key marks right. Adopted only at zero right.
// Free: reads committed fixtures only, no network, no key. `npx tsx scripts/measure-repick.ts` prints the table
// docs/decisions.md gives ("The app replaces a wrong listing itself", Nov 25).
//
// Populations:
//   validation counted   the listing the validation run of Nov 18 counted for each labelled part (results-2026-11-18.json)
//   validation rows      every labelled search row of that run (the title rule fires on any of them, counted or not)
//   corpus               the audit corpus (fixtures/audit/corpus.json), 279 labelled part/listing pairs
//   labels, two models   listings an answer key marks right for two different models: what the two-models rule could cost
//   owner's stores       the deals the app showed after scans 3, 5 and 6 (store/deals.json), through sanity.ts and withdraw.ts
//   Nov 24               the owner's caught case: B0DGLWKS9S, a DWST60122-1 backpack confirmed for DWST08017

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isKitModel, sanityFindings } from '../core/src/audit/sanity';
import { certainWithdrawals, titleNamesAnother, twoModelsWithdraws } from '../core/src/audit/withdraw';
import { sameModel } from '../core/src/match';
import type { BundleRow } from '../core/src/scan/types';

const ROOT = join(import.meta.dirname, '..');
const json = <T>(...p: string[]): T => JSON.parse(readFileSync(join(ROOT, 'fixtures', ...p), 'utf8')) as T;

export interface Row {
  population: string;
  rule: 'title' | 'two models';
  /** Listings (part and listing pairs) the rule was run on. */
  read: number;
  withdrawn: number;
  /** Of those withdrawn, the key marks right (the part). */
  right: number;
  /** Of those withdrawn, the key marks not the part. */
  wrong: number;
  /** Withdrawn with no key, or an uncertain one: named in `notes`. */
  unkeyed: number;
  notes: string[];
}

interface Cand { asin: string; title: string; brand?: string }
interface VPart { model: string; asin: string | null; listingTitle: string | null; candidates?: Cand[] }
interface VBundle { brand: string; model: string; parts: VPart[] }
type Label = { correct: string[] | 'none'; uncertain?: string[] };

function validation(): { counted: { brand: string; model: string; asin: string; title: string; label: 'right' | 'wrong' | 'unkeyed' }[]; rows: { brand: string; model: string; title: string; ok: boolean }[]; twoRight: string[] } {
  const results = json<{ bundles: VBundle[] }>('validation', 'results-2026-11-18.json').bundles;
  const labels = json<{ labels: Record<string, Record<string, Label>> }>('validation', 'labels-2026-11-18.json').labels;
  const keyOf = (bundle: string, model: string, asin: string): 'right' | 'wrong' | 'unkeyed' => {
    const lab = labels[bundle]?.[model];
    if (!lab || (lab.uncertain ?? []).includes(asin)) return 'unkeyed';
    return Array.isArray(lab.correct) && lab.correct.includes(asin) ? 'right' : 'wrong';
  };
  const counted: ReturnType<typeof validation>['counted'] = [];
  const seenCounted = new Set<string>();
  const rows: ReturnType<typeof validation>['rows'] = [];
  const seenRows = new Set<string>();
  for (const b of results) for (const p of b.parts) {
    if (p.asin && p.listingTitle && !seenCounted.has(`${p.model}|${p.asin}`)) {
      seenCounted.add(`${p.model}|${p.asin}`);
      counted.push({ brand: b.brand, model: p.model, asin: p.asin, title: p.listingTitle, label: keyOf(b.model, p.model, p.asin) });
    }
    const lab = labels[b.model]?.[p.model];
    if (!lab) continue;
    for (const c of p.candidates ?? []) {
      if (seenRows.has(`${p.model}|${c.asin}`) || (lab.uncertain ?? []).includes(c.asin)) continue;
      seenRows.add(`${p.model}|${c.asin}`);
      rows.push({ brand: b.brand, model: p.model, title: c.title, ok: Array.isArray(lab.correct) && lab.correct.includes(c.asin) });
    }
  }
  // Listings an answer key marks right for two models that are not the same model.
  const rightFor = new Map<string, Set<string>>();
  const brandOf = new Map<string, string>();
  for (const b of results) for (const p of b.parts) {
    const lab = labels[b.model]?.[p.model];
    if (!lab || !Array.isArray(lab.correct)) continue;
    for (const a of lab.correct) {
      rightFor.set(a, (rightFor.get(a) ?? new Set()).add(p.model));
      brandOf.set(a, b.brand);
    }
  }
  const twoRight = [...rightFor].filter(([a, ms]) => [...ms].some((x) => [...ms].some((y) => !sameModel(brandOf.get(a)!, x, y)))).map(([a, ms]) => `${a} (${[...ms].join(', ')})`);
  return { counted, rows, twoRight };
}

function twoModelsOver(uses: { brand: string; model: string; asin: string; title: string; label: 'right' | 'wrong' | 'unkeyed' }[], population: string): Row {
  const by = new Map<string, typeof uses>();
  for (const u of uses) by.set(u.asin, [...(by.get(u.asin) ?? []), u]);
  const hit = uses.filter((u) => twoModelsWithdraws(u.brand, u.model, by.get(u.asin)!.map((x) => x.model).filter((m) => !sameModel(u.brand, m, u.model)), u.title));
  return {
    population, rule: 'two models', read: uses.length, withdrawn: hit.length,
    right: hit.filter((u) => u.label === 'right').length, wrong: hit.filter((u) => u.label === 'wrong').length,
    unkeyed: hit.filter((u) => u.label === 'unkeyed').length, notes: hit.map((u) => `${u.model} on ${u.asin} (${u.label})`),
  };
}

/** The deals a data folder's app showed, through the audit and the certain rules. */
function stores(): { name: string; withdrawals: ReturnType<typeof certainWithdrawals>; read: number }[] {
  return ['after-scan3', 'after-scan5', 'after-scan6'].map((name) => {
    const deals = json<{ bundles: BundleRow[] }>('e2e-2026-11-23', name, 'store', 'deals.json').bundles;
    const read = new Set(deals.flatMap((b) => [...b.parts, ...b.options.flatMap((o) => o.parts)].filter((p) => p.status === 'matched' && p.asin).map((p) => `${p.model}|${p.asin}`))).size;
    return { name, read, withdrawals: certainWithdrawals(sanityFindings(deals), deals) };
  });
}

/**
 * The owner's own answer key for his stores' withdrawals: B0FD253MKS "RYOBI 18V Cordless Hand Vacuums PCL700B & PCL702B
 * (Tools Only)" sells two vacuums, neither part alone (docs/decisions.md, the several-parts-in-a-listing case; the
 * after-scan6 README: held by the audit as wrong).
 */
const OWNER_KEY: Record<string, 'right' | 'wrong'> = { 'PCL700B|B0FD253MKS': 'wrong', 'PCL702B|B0FD253MKS': 'wrong' };

export function measureRepick(): Row[] {
  const v = validation();
  const out: Row[] = [];
  const titleRow = (population: string, uses: { brand: string; model: string; title: string; label: 'right' | 'wrong' | 'unkeyed'; asin?: string }[]): Row => {
    const hit = uses.filter((u) => titleNamesAnother(u.brand, u.model, u.title));
    return {
      population, rule: 'title', read: uses.length, withdrawn: hit.length, right: hit.filter((u) => u.label === 'right').length,
      wrong: hit.filter((u) => u.label === 'wrong').length, unkeyed: hit.filter((u) => u.label === 'unkeyed').length,
      notes: hit.filter((u) => u.label !== 'wrong').map((u) => `${u.model}${u.asin ? ` on ${u.asin}` : ''} (${u.label})`),
    };
  };
  out.push(titleRow('validation counted', v.counted));
  out.push(titleRow('validation rows', v.rows.map((r) => ({ ...r, label: r.ok ? 'right' : 'wrong' }))));
  const corpus = json<{ pairs: { part: { brand: string; model: string }; listing: { asin: string; title: string }; label: string }[] }>('audit', 'corpus.json').pairs;
  const corpusUses = corpus.map((c) => ({ brand: c.part.brand, model: c.part.model, asin: c.listing.asin, title: c.listing.title, label: c.label === 'part' ? 'right' as const : c.label === 'not-part' ? 'wrong' as const : 'unkeyed' as const }));
  out.push(titleRow('corpus', corpusUses));
  out.push(twoModelsOver(v.counted, 'validation counted'));
  // The corpus as if every listing it labels the part were counted for that part: a listing right for two models is the risk.
  out.push(twoModelsOver(corpusUses.filter((u) => u.label === 'right'), 'corpus, every right listing counted'));
  for (const s of stores()) {
    for (const rule of ['title', 'two models'] as const) {
      const w = s.withdrawals.filter((x) => (rule === 'title' ? x.kind === 'title_other_model' : x.kind === 'listing_two_models'));
      const label = (x: (typeof w)[number]) => OWNER_KEY[`${x.model}|${x.asin}`] ?? 'unkeyed';
      out.push({
        population: `owner's ${s.name}`, rule, read: s.read, withdrawn: w.length, right: w.filter((x) => label(x) === 'right').length,
        wrong: w.filter((x) => label(x) === 'wrong').length, unkeyed: w.filter((x) => label(x) === 'unkeyed').length,
        notes: w.map((x) => `${x.model} on ${x.asin} in ${x.bundleId} (${label(x)})`),
      });
    }
  }
  const nov24 = titleNamesAnother('DEWALT', 'DWST08017', 'DWST60122-1 Dewalt Pro Backpack x McLaren F1 Team, Limited Edition');
  out.push({ population: 'Nov 24 (B0DGLWKS9S)', rule: 'title', read: 1, withdrawn: nov24 ? 1 : 0, right: 0, wrong: nov24 ? 1 : 0, unkeyed: 0, notes: [] });
  out.push({ population: 'labels: one listing right for two models', rule: 'two models', read: v.twoRight.length, withdrawn: 0, right: 0, wrong: 0, unkeyed: 0, notes: v.twoRight });
  // The case the rule must not hurt: a right listing counted for its part and, by a mistake elsewhere, for another model too.
  // The rule spares a part whose title names it alone; a right listing whose title does not would be withdrawn with it.
  const rights = [
    ...v.rows.filter((r) => r.ok).map((r) => ({ brand: r.brand, model: r.model, title: r.title })),
    ...corpusUses.filter((u) => u.label === 'right'),
  ].filter((u, i, all) => !isKitModel(u.brand, u.model) && all.findIndex((x) => x.model === u.model && x.title === u.title) === i);
  const exposed = rights.filter((u) => twoModelsWithdraws(u.brand, u.model, ['ANOTHER1'], u.title));
  out.push({
    population: 'right listings, if also counted for another model', rule: 'two models', read: rights.length, withdrawn: exposed.length,
    right: exposed.length, wrong: 0, unkeyed: 0, notes: exposed.map((u) => `${u.model}: "${u.title}"`),
  });
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log('| population | rule | read | withdrawn | key: right | key: not the part | no key |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of measureRepick()) {
    console.log(`| ${r.population} | ${r.rule} | ${r.read} | ${r.withdrawn} | ${r.right} | ${r.wrong} | ${r.unkeyed} |`);
    if (r.notes.length > 0) console.log(`    ${r.notes.join('; ')}`);
  }
}
