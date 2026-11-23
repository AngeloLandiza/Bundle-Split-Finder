// npx tsx scripts/measure-reverify.ts [--verbose]. Free, no network, no key: measures step 16's levers before they are
// adopted (docs/decisions.md, "Step 16"). Nothing is written.
//
//   (a) The four recorded research runs (fixtures/research/runs-*.json, the 19 split questions with the answer key),
//       replayed through today's loop and verifier: verified right and wrong, and each unverified answer that the key
//       says is right (the pool a lever may release). Then lever 1, the same answers checked again (reverifyResearch)
//       with the readings the scan would store: Home Depot's part prices of Nov 18 (fixtures/validation) and, so a
//       wrong answer gets its chance too, a found reading for every product the recorded sources show (the agent asks
//       the part-price reader for every model an unverified answer names, so a real model would have one).
//   (b) The owner's real data (fixtures/e2e-2026-11-23): the 21 suggestions of scan 2. Their ledgers were kept slimmed
//       (names and links, no text), so each is rebuilt: the stored evidence from scan 2's store, every Home Depot page
//       and search the research named, answered from the recorded files (scripts/research-tools.ts; a page or search
//       with no recording stays empty, so quotes from it fail), the catalog from scan 2. Then lever 1 with what the
//       scan stored by scan 3 (after-scan3: part prices, matches, kit pages). There is no answer key for these: every
//       newly verified answer is printed with its parts for a person to check against the page.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { gatherEvidence } from '../core/src/assist/evidence';
import type { Suggestion } from '../core/src/assist/types';
import { kitKey } from '../core/src/match';
import { researchOutcome, type ResearchOutcome, type ResearchTruth } from '../core/src/research/eval';
import { bundleIdentity, catalogLedgerEntry, ledgerFromEvidence, pageEntry, searchEntry } from '../core/src/research/ledger';
import { researchQuestion } from '../core/src/research/loop';
import { reverifyResearch, type StoredFacts } from '../core/src/research/reverify';
import type { CatalogEntry, ResearchAnswer, ResearchLedgerEntry, ResearchModel, ResearchTurn } from '../core/src/research/types';
import { verifyResearch } from '../core/src/research/verify';
import { choicesOf } from '../core/src/scan/answers';
import { MemoryScanStore } from '../core/src/scan/memoryStore';
import type { BundleRecord, CatalogRecord, MatchRecord, PartPriceRecord, ReviewItem } from '../core/src/scan/types';
import { partKey } from '../core/src/scan/types';
import { ROOT } from './node-store';
import { loadResearchQuestions, type ResearchRunsFile } from './research-eval-cli';
import { loadRecordedSources, recordedTools, replayedTools } from './research-tools';
import { loadInputs } from './validate-cli';

const verbose = process.argv.includes('--verbose');
const FIX = join(ROOT, 'fixtures');
const REAL = join(FIX, 'e2e-2026-11-23');
const read = <T>(f: string): T => JSON.parse(readFileSync(f, 'utf8')) as T;
const pairs = <T>(f: string): [string, T][] => read<[string, T][]>(f);
const RUNS = ['runs-claude-opus-5-5-prompt1.json', 'runs-claude-opus-5-5-prompt2.json', 'runs-claude-opus-5-5-prompt3.json', 'runs-claude-opus-5-5.json'];

const bag = (brand: string, parts: string[]): string => parts.map((p) => kitKey(brand, p)).sort().join(',');
/** The parts an answer proposes (a choose answer: the reading it chose). */
function claimed(a: ResearchAnswer | null, item: ReviewItem): string[] {
  if (!a) return [];
  if (a.decision === 'parts') return a.parts.flatMap((p) => Array<string>(Math.max(0, p.qty)).fill(p.model.trim().toUpperCase()));
  if (a.decision === 'choose' && a.choiceIndex !== null) return choicesOf(item)[a.choiceIndex] ?? [];
  return [];
}
const rightClaim = (a: ResearchAnswer | null, item: ReviewItem, truth: ResearchTruth): boolean =>
  truth.kind === 'parts' && claimed(a, item).length > 0 && bag(item.brand, claimed(a, item)) === bag(item.brand, truth.parts);

const asSuggestion = (s: Suggestion, checked: ReturnType<typeof verifyResearch>): Suggestion => ({ questionId: s.questionId, seen: s.seen, provider: s.provider, model: s.model, promptVersion: s.promptVersion, ...checked }) as Suggestion;

const readingOf = (brand: string, model: string, r: { itemId: string | null; matchedModel: string | null; price: number | null; title: string | null; link: string | null }): PartPriceRecord => ({
  key: partKey(brand, model), brand: brand.toUpperCase(), model: model.toUpperCase(), itemId: r.itemId, matchedModel: r.matchedModel?.toUpperCase() ?? null,
  price: r.price, title: r.title, link: r.link, seenAt: r.price === null ? null : 1, checkedAt: 1,
});

// ---------------------------------------------------------------- (a) the recorded runs

async function recordedRuns(): Promise<void> {
  console.log('=== (a) the recorded research runs (19 questions, answer key) ===');
  const { questions, catalog } = await loadResearchQuestions(FIX);
  const sources = loadRecordedSources(FIX);
  // The readings: Nov 18's part prices, then one found reading for every product the recorded sources show.
  const prices = new Map<string, PartPriceRecord>();
  for (const [k, r] of loadInputs(join(FIX, 'validation')).partPrices) prices.set(k, readingOf(r.brand, r.model, r));
  for (const p of loadRecordedSources(FIX, { partPrices: true }).products) {
    const k = partKey(p.brand, p.model);
    if (p.brand && p.model && !prices.has(k)) prices.set(k, readingOf(p.brand, p.model, { itemId: p.itemId, matchedModel: p.model, price: 1, title: p.title, link: p.url }));
  }
  const facts: StoredFacts = { partPrices: [...prices.values()] };
  for (const file of RUNS) {
    const doc = read<ResearchRunsFile>(join(FIX, 'research', file));
    const before: Record<string, number> = { right: 0, wrong: 0, unverifiedRight: 0, unverifiedWrong: 0, other: 0 };
    const after: Record<string, number> = { right: 0, wrong: 0, unverifiedRight: 0, unverifiedWrong: 0, other: 0 };
    const lines: string[] = [];
    const tally = (t: Record<string, number>, o: ResearchOutcome, right: boolean) => {
      if (o === 'verified_correct') t.right!++;
      else if (o === 'verified_wrong') t.wrong!++;
      else if (o === 'unverified') t[right ? 'unverifiedRight' : 'unverifiedWrong']!++;
      else t.other!++;
    };
    for (const q of questions) {
      const stored = doc.results.find((r) => r.questionId === q.item.id);
      if (!stored) continue;
      let i = 0;
      const model: ResearchModel = { provider: 'replay', model: doc.model, send: async () => (stored.turns[i++] as ResearchTurn | undefined) ?? { ok: false, notJudged: { reason: 'no_answer', message: 'no more turns' } } };
      const kept = stored.tools.every((x) => x.result !== undefined);
      const s = await researchQuestion(q.item, q.evidence, kept ? replayedTools(stored.tools) : recordedTools(sources, catalog, []), model, { catalog });
      const answer = s.research.answer;
      const right = rightClaim(answer, q.item, q.truth);
      const o0 = researchOutcome(s, q.truth, q.item);
      tally(before, o0, right);
      // Lever 1 re-checks every unverified answer (the agent re-checks only those); the verified ones stand as they are.
      let o1 = o0;
      let note = '';
      if (s.status === 'unverified' && answer) {
        const r = reverifyResearch({ item: q.item, answer, ledger: s.research.ledger, catalog, evidence: q.evidence, facts });
        if (r) {
          o1 = researchOutcome(asSuggestion(s, r.checked), q.truth, q.item);
          note = r.checked.status === 'unverified' ? r.checked.reasons.join(' ') : '';
          if (o1 !== o0) lines.push(`    ${q.item.model}: ${o0} -> ${o1} (added ${r.added.join(', ')})`);
          else if (verbose) lines.push(`    ${q.item.model}: stays ${o0}${right ? ' (right per key)' : ''}: ${note}`);
        }
      }
      tally(after, o1, right);
    }
    const fmt = (t: Record<string, number>) => `${t.right} right, ${t.wrong} wrong verified; unverified ${t.unverifiedRight} right per key + ${t.unverifiedWrong} not; ${t.other} other`;
    console.log(`  ${file}`);
    console.log(`    today:            ${fmt(before)}`);
    console.log(`    lever 1 (re-check): ${fmt(after)}`);
    for (const l of lines) console.log(l);
  }
}

// ---------------------------------------------------------------- (b) the owner's real data

interface StoredSuggestionFile {
  questionId: string;
  askedAt: number;
  suggestion: Suggestion & { research?: { ledger: ResearchLedgerEntry[]; answer: ResearchAnswer | null } };
}

async function storeOf(dir: string): Promise<MemoryScanStore> {
  const store = new MemoryScanStore();
  for (const [, b] of pairs<BundleRecord>(join(dir, 'bundles.json'))) await store.putBundle(b);
  for (const [, c] of pairs<CatalogRecord>(join(dir, 'catalog.json'))) await store.putCatalogEntry(c);
  for (const [, p] of pairs<PartPriceRecord>(join(dir, 'partPrices.json'))) await store.putPartPrice(p);
  for (const [, m] of pairs<MatchRecord>(join(dir, 'matches.json'))) await store.putMatch(m);
  return store;
}

const catalogOf = async (store: MemoryScanStore): Promise<CatalogEntry[]> =>
  (await store.listCatalog()).map((c): CatalogEntry => ({ brand: c.brand, model: c.model, title: c.title, kind: c.isKit ? 'kit' : 'part' }));

/** How verify.ts shows a quote in a reason. */
const shown = (q: string): string => {
  const t = q.trim().replace(/\s+/g, ' ');
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
};

/** A quote the first check found in its source: no reason of the stored suggestion says it was not found or not read. */
const wasFound = (quote: string, reasons: readonly string[]): boolean =>
  !reasons.some((r) => r.includes(`"${shown(quote)}"`) && /is not found in|names a source that was not read/.test(r));

/** One search row's line, back from its quoted text ("RYOBI PCL525B (item 318898528): ONE+ 18V Cordless Jig Saw"). */
const ROW = /^(RYOBI|DEWALT)\s+(\S+)\s+\(item\s+(\d+)\):\s+(.+)$/i;

/**
 * A slimmed ledger rebuilt. The stored sources from scan 2's store; the bundle's own Home Depot page from its recording
 * (else the page scan 3 stored), with each line the AI quoted from it that the first check found and the page lacks
 * (its highlights); a search from the rows the AI quoted and the first check found (a row it did not quote is lost); any
 * other page from its recording; the catalog from scan 2's. What cannot be rebuilt stays empty, so quotes of it fail.
 */
async function rebuild(item: ReviewItem, slim: ResearchLedgerEntry[], answer: ResearchAnswer, reasons: readonly string[], store: MemoryScanStore, catalog: CatalogEntry[], sources: ReturnType<typeof loadRecordedSources>): Promise<{ ledger: ResearchLedgerEntry[]; missing: string[] }> {
  const tools = recordedTools(sources, catalog, []);
  const stored = ledgerFromEvidence(await gatherEvidence(store, item));
  const bundle = bundleIdentity(item);
  const quotes = [...answer.quotes, ...answer.parts.flatMap((p) => p.quotes)].filter((q) => wasFound(q.quote, reasons));
  const quotedFrom = (id: string): string[] => [...new Set(quotes.filter((q) => q.sourceId.trim() === id).map((q) => q.quote.trim()))];
  const out: ResearchLedgerEntry[] = [];
  const missing: string[] = [];
  for (const e of slim) {
    if (e.kind === 'stored') {
      const s = stored.find((x) => x.id === e.id);
      if (s) out.push(s);
      else missing.push(e.id);
      continue;
    }
    if (e.kind === 'homedepot_page') {
      const id = /(\d{6,12})/.exec(e.id)?.[1] ?? /\/(\d{6,12})/.exec(e.url ?? '')?.[1] ?? null;
      const recorded = id ? await tools.readHomeDepotPage({ itemId: id }) : { error: 'no id' };
      const own = id !== null && id === bundle.itemId;
      const b = own ? await store.getBundle(item.subject) : undefined;
      const page = !('error' in recorded) ? recorded
        : b ? { sourceId: e.id, label: 'Home Depot page', url: `https://www.homedepot.com/p/${id}`, sections: { title: b.title, model: b.model, bullets: b.page?.bullets ?? [], description: b.page?.description ?? '', specifications: [] } }
        : null;
      if (!page) {
        missing.push(e.id);
        out.push({ ...e, lines: [], products: [] });
        continue;
      }
      const entry = pageEntry(e.id, page, bundle, id);
      if (own) {
        for (const q of quotedFrom(e.id)) {
          if (!entry.lines.some((l) => l.text.toLowerCase().includes(q.toLowerCase()))) entry.lines.push({ field: 'bullet', text: q });
        }
      }
      out.push(entry);
      continue;
    }
    if (e.kind === 'homedepot_search') {
      const rows = quotedFrom(e.id).map((q) => ROW.exec(q)).filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ brand: m[1]!.toUpperCase(), model: m[2]!, itemId: m[3]!, title: m[4]!, url: `https://www.homedepot.com/p/${m[3]}` }));
      if (rows.length === 0) missing.push(e.id);
      out.push(searchEntry(e.id, { sourceId: e.id, label: e.label, url: e.url ?? '', results: rows }));
      continue;
    }
    if (e.kind === 'catalog') {
      const model = e.id.replace(/^catalog:/, '').toUpperCase();
      const res = await tools.catalogLookup({ model });
      out.push('error' in res ? { ...e, lines: [], products: [] } : catalogLedgerEntry(e.id, res));
      continue;
    }
    missing.push(e.id);
    out.push({ ...e, lines: [], products: [] });
  }
  return { ledger: out, missing };
}

async function realData(): Promise<void> {
  console.log("\n=== (b) fixtures/e2e-2026-11-23: the owner's 21 suggestions of scan 2, ledgers rebuilt ===");
  const sources = loadRecordedSources(FIX);
  const scan2 = await storeOf(join(REAL, 'scan'));
  const scan3 = await storeOf(join(REAL, 'after-scan3', 'scan'));
  const catalog2 = await catalogOf(scan2);
  const catalog3 = await catalogOf(scan3);
  const facts: StoredFacts = { partPrices: await scan3.listPartPrices(), matches: [] };
  for (const [, m] of pairs<MatchRecord>(join(REAL, 'after-scan3', 'scan', 'matches.json'))) (facts.matches as MatchRecord[]).push(m);
  const items2 = [
    ...read<{ questions: ReviewItem[] }>(join(REAL, 'store', 'review.json')).questions,
    ...pairs<ReviewItem>(join(REAL, 'scan', 'reviews.json')).map(([, q]) => q),
    ...pairs<ReviewItem>(join(REAL, 'after-scan3', 'scan', 'reviews.json')).map(([, q]) => q),
  ];
  const open3 = read<{ questions: ReviewItem[] }>(join(REAL, 'after-scan3', 'store', 'review.json')).questions.filter((q) => q.kind === 'split' && q.answer === null);
  const suggestions = read<StoredSuggestionFile[]>(join(REAL, 'store', 'suggestions.json'));
  const t = { asked: 0, verifiedStored: 0, rebuiltVerified: 0, afterVerified: 0 };
  for (const rec of suggestions) {
    const s = rec.suggestion;
    t.asked++;
    if (s.status === 'verified') t.verifiedStored++;
    const found = items2.find((q) => q.id === rec.questionId) ?? open3.find((q) => q.id === rec.questionId);
    if (!found) {
      console.log(`  ${rec.questionId}: the question is not stored; skipped`);
      continue;
    }
    const item = { ...found, answer: null, answerParts: null, answeredAt: null } as ReviewItem;
    const answer = s.research?.answer ?? null;
    if (!answer || !s.research) continue;
    const { ledger, missing } = await rebuild(item, s.research.ledger, answer, s.status === 'unverified' ? s.reasons : [], scan2, catalog2, sources);
    const base = verifyResearch(answer, item, ledger, catalog2);
    if (base.status === 'verified') t.rebuiltVerified++;
    const now3 = open3.find((q) => q.id === item.id);
    const evidence = await gatherEvidence(scan3, now3 ?? item);
    const r = reverifyResearch({ item: now3 ?? item, answer, ledger, catalog: catalog3, evidence: { ...evidence, questionId: item.id }, facts });
    const after = r?.checked ?? base;
    if (after.status === 'verified') t.afterVerified++;
    const parts = answer.decision === 'parts' ? answer.parts.map((p) => `${p.model}x${p.qty}`).join(' + ') : answer.decision;
    const open = now3 ? 'OPEN after scan 3' : 'settled by scan 3';
    console.log(`  ${item.model.padEnd(24)} ${open.padEnd(18)} stored ${s.status.padEnd(11)} rebuilt ${base.status.padEnd(11)} lever 1 ${after.status.padEnd(11)} ${parts}`);
    if (r && r.added.length > 0) console.log(`      added: ${r.added.join(', ')}${r.wanted.length > 0 ? `; would queue a Home Depot read for ${r.wanted.join(', ')}` : ''}`);
    if (missing.length > 0) console.log(`      not rebuilt (no recording): ${missing.join(', ')}`);
    if (verbose || after.status === 'unverified') {
      const why = after.status === 'unverified' ? after.reasons : [];
      for (const w of why.slice(0, verbose ? 50 : 4)) console.log(`      - ${w}`);
      if (!verbose && why.length > 4) console.log(`      - … ${why.length - 4} more`);
    }
  }
  console.log(`  Suggestions: ${t.asked}; verified when asked: ${t.verifiedStored}; verified on the rebuilt ledgers: ${t.rebuiltVerified}; with lever 1: ${t.afterVerified}.`);
  console.log(`  Open split questions after scan 3: ${open3.length} (${open3.map((q) => q.model).join(', ')}); with a scan-2 suggestion: ${open3.filter((q) => suggestions.some((s) => s.questionId === q.id)).length}.`);
}

await recordedRuns();
await realData();
