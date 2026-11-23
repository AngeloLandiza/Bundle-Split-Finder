// npx tsx scripts/measure-splits.ts. Free, no network: measures step 15's settle rules (core/src/scan/settle.ts) before
// they are adopted (docs/superpowers/plans/2026-11-23-step-15-real-run-fixes.md, decision 4). For each rule:
//   (a) the validation set: every bundle's split with and without the rule, against the answer key (the owner's split
//       answers, else the split the tool resolved), with Home Depot's part prices of Nov 18 as the readings;
//   (b) the owner's real data (fixtures/e2e-2026-11-23): which of the open "Which parts" questions each rule settles,
//       makes wait for Home Depot's part pages, or leaves; and that no rule changes an already-settled split (each rule
//       is also run on every settled bundle as if it were open: its answer must be the split that stands, or none);
//   (c) rule 3 (the "<N>-Tool Combo Kit … and <extra>" count): every recorded research run replayed through today's
//       verifier, verified right and wrong against the key.
// Nothing is written.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Decomposition } from '../core/src/decompose';
import { kitIndex, kitRecords } from '../core/src/kitContents';
import { researchOutcome } from '../core/src/research/eval';
import { researchQuestion } from '../core/src/research/loop';
import type { ResearchModel, ResearchTurn } from '../core/src/research/types';
import { MemoryScanStore } from '../core/src/scan/memoryStore';
import { bogoSplit, homeDepotSplit, type SettleData } from '../core/src/scan/settle';
import { knownModels, readSplit } from '../core/src/scan/split';
import type { BundleRecord, CatalogRecord, ListingRecord, PartPriceRecord, ReviewItem, ScanStore } from '../core/src/scan/types';
import { CacheOnlyClient, loadInputs, ResponsesCache, runValidationPipeline, validationFiles } from './validate-cli';
import { loadResearchQuestions, type ResearchRunsFile } from './research-eval-cli';
import { loadRecordedSources, recordedTools, replayedTools } from './research-tools';
import { ROOT } from './node-store';

const FIX = join(ROOT, 'fixtures', 'e2e-2026-11-23');
const read = <T>(f: string): T => JSON.parse(readFileSync(f, 'utf8')) as T;
const pairs = <T>(f: string): [string, T][] => read<[string, T][]>(f);
const same = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].map((m) => m.toUpperCase()).sort();
  const y = [...b].map((m) => m.toUpperCase()).sort();
  return x.length === y.length && x.every((m, i) => m === y[i]);
};
const show = (s: Decomposition | null): string => {
  if (!s) return 'no rule';
  if (s.status === 'resolved') return `resolved [${s.components.join(', ')}]`;
  if (s.waitingFor?.length) return `waits for ${s.waitingFor.join(', ')}`;
  return `question (${s.notes.slice(-1)[0] ?? ''})`;
};

async function settleData(store: ScanStore): Promise<SettleData> {
  const partPrices = new Map((await store.listPartPrices()).map((r) => [r.key, r] as const));
  return { partPrices, kitsOf: kitIndex(kitRecords(await store.listBundles(), await store.listCatalog())) };
}

/** A settled split as an open one, for the "would the rule change it?" probe: the reading it holds is the one offered. */
const asOpen = (s: Decomposition): Decomposition => ({ components: s.components, status: 'needs_review', notes: ['hyphen split, but a part is not in the catalog'], alternatives: [[...s.components]] });

type Reading = { brand: string; model: string; itemId: string | null; matchedModel: string | null; price: number | null; title: string | null; link: string | null };
const reading = (key: string, r: Reading): PartPriceRecord => ({
  key, brand: r.brand.toUpperCase(), model: r.model.toUpperCase(), itemId: r.itemId, matchedModel: r.matchedModel?.toUpperCase() ?? null,
  price: r.price, title: r.title, link: r.link, seenAt: r.price === null ? null : 1, checkedAt: 1,
});

// ---------------------------------------------------------------- (b) the owner's real data

/** The BOGO pass of scan 2 wrote its pairs at this time (pairBundleRecord's seenAt); the starters' prices are their part-price readings. */
const BOGO_PASS_AT = 1795426927803;

async function realData(): Promise<void> {
  console.log("=== (b) fixtures/e2e-2026-11-23: the owner's real data ===");
  const store = new MemoryScanStore();
  for (const [, b] of pairs<BundleRecord>(join(FIX, 'scan', 'bundles.json'))) await store.putBundle(b);
  for (const [, c] of pairs<CatalogRecord>(join(FIX, 'scan', 'catalog.json'))) await store.putCatalogEntry(c);
  for (const [, l] of pairs<ListingRecord>(join(FIX, 'scan', 'listings.json'))) await store.putListing(l);
  for (const [, p] of pairs<PartPriceRecord>(join(FIX, 'scan', 'partPrices.json'))) await store.putPartPrice(p);
  const known = await knownModels(store);
  const data = await settleData(store);
  // The pairs, as the pair rule found them in scan 2: written by the BOGO pass, <starter><joiner><free>, at the starter's price.
  const starters = [...data.partPrices.values()].filter((p) => p.price !== null && ['PCL1201K2', 'DCK200D1P1', 'DCK540D1'].includes(p.model));
  const tagOf = (b: BundleRecord): BundleRecord['bogo'] => {
    if (b.seenAt !== BOGO_PASS_AT) return null;
    for (const s of starters) {
      const joiner = s.brand === 'RYOBI' ? '-' : 'W';
      if (b.brand === s.brand && b.model.startsWith(`${s.model}${joiner}`) && b.price === s.price) {
        return { promotionId: 'scan-2', starterItemId: s.itemId ?? '', starterModel: s.model, freeModel: b.model.slice(s.model.length + 1) };
      }
    }
    return null;
  };
  const questions = read<{ questions: ReviewItem[] }>(join(FIX, 'store', 'review.json')).questions.filter((q) => q.kind === 'split' && q.answer === null);
  const open = new Set(questions.map((q) => q.subject));
  // Nov 18's readings, as a projection of what the part-price read would bring for the parts that wait (same models, five days earlier).
  const nov18 = loadInputs(join(ROOT, 'fixtures', 'validation')).partPrices;
  const projected: SettleData = {
    kitsOf: data.kitsOf,
    partPrices: new Map([...data.partPrices, ...[...nov18].filter(([k]) => !data.partPrices.has(k)).map(([k, r]) => [k, reading(k, r)] as const)]),
  };
  const tally = { r1: 0, r2: 0, r2wait: 0, r2question: 0, left: 0, r2projected: 0 };
  console.log(`Open "Which parts" questions: ${questions.length}`);
  for (const q of questions) {
    const b = (await store.getBundle(q.subject))!;
    const split = readSplit(b, { stored: known.stored, catalog: known.catalog });
    const bogo = tagOf(b);
    const r1 = bogoSplit({ ...b, bogo }, split);
    const r2 = homeDepotSplit(b, split, known.catalog, data);
    const r2p = homeDepotSplit(b, split, known.catalog, projected);
    if (r1?.status === 'resolved') tally.r1++;
    else if (r2?.status === 'resolved') tally.r2++;
    else if (r2?.waitingFor?.length) tally.r2wait++;
    else if (r2) tally.r2question++;
    else tally.left++;
    if (r1?.status !== 'resolved' && r2p?.status === 'resolved') tally.r2projected++;
    console.log(`  ${b.model.padEnd(18)} pair ${bogo ? 'yes' : 'no '}  rule 1: ${show(r1)}  |  rule 2: ${show(r2)}  |  rule 2 with Nov 18 readings: ${show(r2p)}`);
  }
  console.log(`Rule 1 settles ${tally.r1}; of the rest rule 2 settles ${tally.r2}, makes ${tally.r2wait} wait for Home Depot's part pages, keeps ${tally.r2question} with a reason; ${tally.left} no rule touches.`);
  console.log(`Projection: with Nov 18's readings for the waiting parts, rule 2 would settle ${tally.r2projected} of those rule 1 leaves.`);

  // Every settled bundle: each rule run on it as if open must give its split or nothing.
  let probed = 0;
  let agree = 0;
  let settled = 0;
  const changed: string[] = [];
  for (const b of await store.listBundles()) {
    if (open.has(b.key)) continue;
    const now = readSplit(b, { stored: known.stored, catalog: known.catalog });
    if (now.status !== 'resolved') continue;
    settled++;
    const bogo = tagOf(b);
    const outs: [string, Decomposition | null][] = [['rule 1', bogoSplit({ ...b, bogo }, asOpen(now))], ['rule 2', homeDepotSplit(b, asOpen(now), known.catalog, projected)]];
    for (const [name, out] of outs) {
      if (out?.status !== 'resolved') continue;
      probed++;
      if (same(out.components, now.components)) agree++;
      else changed.push(`${b.model} ${name}: ${out.components.join(', ')} for ${now.components.join(', ')}`);
    }
  }
  console.log(`Settled bundles: ${settled}; each rule run on them as if open resolved ${probed} readings: ${agree} the split that stands, ${changed.length} different.`);
  for (const c of changed) console.log(`  DIFFERENT ${c}`);
}

// ---------------------------------------------------------------- (a) the validation set

async function validation(): Promise<void> {
  console.log('\n=== (a) the validation set (fixtures/validation, replay) ===');
  const dir = join(ROOT, 'fixtures', 'validation');
  const inputs = loadInputs(dir);
  const cache = new ResponsesCache(validationFiles(dir).responses);
  const run = await runValidationPipeline({ inputs, scanClient: new CacheOnlyClient(cache), lookupClient: new CacheOnlyClient(cache), continuePastMisses: true });
  const store = run.store;
  const known = await knownModels(store);
  const kits = kitIndex(kitRecords(await store.listBundles(), await store.listCatalog()));
  // Every part the file read, as the part-price store holds it (found or not found).
  const data: SettleData = { kitsOf: kits, partPrices: new Map([...inputs.partPrices].map(([k, r]) => [k, reading(k, r)] as const)) };
  // The Nov 23 BOGO recording: pairs whose item ids are validation bundles.
  const bogo = read<{ lists: Record<string, { items: { itemId: string; model: string; brand: string; price: number | null; conditionalPromotions: number | null }[] }> }>(join(ROOT, 'fixtures', 'homedepot-pages', 'bogo-2026-11-23.json'));
  const items = Object.values(bogo.lists).flatMap((l) => l.items);
  const starters = items.filter((i) => i.conditionalPromotions === 1);
  const tagOf = (b: BundleRecord): BundleRecord['bogo'] => {
    const it = items.find((i) => i.itemId === b.itemId);
    if (!it || it.conditionalPromotions) return null;
    const joiner = it.brand.toUpperCase() === 'RYOBI' ? '-' : 'W';
    const fits = starters.filter((s) => it.model.startsWith(`${s.model}${joiner}`) && s.price === it.price);
    return fits.length === 1 ? { promotionId: 'recorded', starterItemId: fits[0]!.itemId, starterModel: fits[0]!.model, freeModel: it.model.slice(fits[0]!.model.length + 1) } : null;
  };
  const before = { right: 0, wrong: 0, open: 0 };
  const after = { right: 0, wrong: 0, open: 0, waiting: 0 };
  const score = (s: Decomposition, truth: string[] | null, t: { right: number; wrong: number; open: number }) => {
    if (s.status !== 'resolved') t.open++;
    else if (truth && same(s.components, truth)) t.right++;
    else t.wrong++;
  };
  const lines: string[] = [];
  for (const key of run.validation) {
    const b = await store.getBundle(key);
    if (!b) continue;
    const answer = inputs.answers.get(b.model.toUpperCase());
    const truth = answer ? (answer.parts === 'none' ? null : answer.parts) : (b.split?.status === 'resolved' ? b.split.components : null);
    const split = readSplit(b, { stored: known.stored, catalog: known.catalog });
    const tag = tagOf(b);
    const r1 = bogoSplit({ ...b, bogo: tag }, split);
    const r2 = homeDepotSplit(b, split, known.catalog, data);
    const out = split.status === 'resolved' ? split : r1?.status === 'resolved' ? r1 : r2 ?? split;
    score(split, truth, before);
    score(out, truth, after);
    if (out.status !== 'resolved' && out.waitingFor?.length) after.waiting++;
    if (split.status !== 'resolved' || tag) lines.push(`  ${b.model.padEnd(20)} key ${truth ? truth.join(', ') : 'none'}  pair ${tag ? 'yes' : 'no '}  rule 1: ${show(r1)}  |  rule 2: ${show(r2)}`);
    // The probe: each rule on a bundle the tool settled, as if open.
    if (split.status === 'resolved' && truth) {
      const outs: [string, Decomposition | null][] = [['rule 1', bogoSplit({ ...b, bogo: tag }, asOpen(split))], ['rule 2', homeDepotSplit(b, asOpen(split), known.catalog, data)]];
      for (const [n, p] of outs) {
        if (p?.status === 'resolved') lines.push(`  probe ${b.model} ${n}: ${same(p.components, truth) ? 'same' : `WRONG ${p.components.join(', ')}`}`);
      }
    }
  }
  for (const l of lines) console.log(l);
  console.log(`Splits without the rules: ${before.right} right, ${before.wrong} wrong, ${before.open} open (to the owner).`);
  console.log(`Splits with rules 1 and 2: ${after.right} right, ${after.wrong} wrong, ${after.open} open, of which ${after.waiting} wait for a reading.`);
}

// ---------------------------------------------------------------- (c) rule 3 on the recorded research runs

async function researchRuns(): Promise<void> {
  console.log("\n=== (c) the recorded research runs, replayed through today's verifier ===");
  const fixtures = join(ROOT, 'fixtures');
  const { questions, catalog } = await loadResearchQuestions(fixtures);
  const sources = loadRecordedSources(fixtures);
  for (const file of ['runs-claude-opus-5-5-prompt1.json', 'runs-claude-opus-5-5-prompt2.json', 'runs-claude-opus-5-5-prompt3.json', 'runs-claude-opus-5-5.json']) {
    const doc = read<ResearchRunsFile>(join(fixtures, 'research', file));
    const t = { right: 0, wrong: 0, other: 0, countRefusals: 0 };
    const changed: string[] = [];
    for (const q of questions) {
      const stored = doc.results.find((r) => r.questionId === q.item.id);
      if (!stored) continue;
      let i = 0;
      const model: ResearchModel = {
        provider: 'replay', model: doc.model,
        send: async () => (stored.turns[i++] as ResearchTurn | undefined) ?? { ok: false, notJudged: { reason: 'no_answer', message: 'no more turns' } },
      };
      const kept = stored.tools.every((x) => x.result !== undefined);
      const s = await researchQuestion(q.item, q.evidence, kept ? replayedTools(stored.tools) : recordedTools(sources, catalog, []), model, { catalog });
      if (s.status === 'unverified' && s.reasons.some((r) => /^The bundle states \d+ tools?; the parts hold \d+\.$/.test(r))) {
        t.countRefusals++;
        changed.push(`${q.item.model}: ${s.reasons.join(' ')}`);
      }
      const o = researchOutcome(s, q.truth, q.item);
      if (o === 'verified_correct') t.right++;
      else if (o === 'verified_wrong') {
        t.wrong++;
        changed.push(`${q.item.model}: VERIFIED WRONG`);
      } else t.other++;
    }
    console.log(`  ${file}: verified ${t.right} right, ${t.wrong} wrong; ${t.other} not verified, ${t.countRefusals} of them refused for a tool count.`);
    for (const c of changed) console.log(`    ${c}`);
  }
}

await realData();
await validation();
await researchRuns();
