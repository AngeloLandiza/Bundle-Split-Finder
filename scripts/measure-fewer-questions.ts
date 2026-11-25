// npx tsx scripts/measure-fewer-questions.ts. Free, no network: measures the Nov 24 settle rules (core/src/scan/settle.ts,
// "Fewer questions" in docs/decisions.md) the way step 15's rules were measured (scripts/measure-splits.ts), before they
// are adopted. For each rule, alone on top of the rules already adopted:
//   (a) the validation set (fixtures/validation, replayed): every bundle's split against the answer key, with Home Depot's
//       Nov 18 part prices as the readings; changed / right / wrong / still open;
//   (b) the owner's real stores (fixtures/e2e-2026-11-23/after-scan3, after-scan5, after-scan6): every bundle the rule
//       changes, with what it became; a resolved change is scored against the owner's own answer when he gave one, and is
//       otherwise listed for a check by hand against its pages (the list is in docs/decisions.md); and the probe: the rule
//       run on every bundle that is settled today, as if it were open, must give the split that stands or nothing;
//   (c) rule C's count (kitPageTools): on every stored kit page, the tools its Includes lists hold against the count the
//       kit's own Home Depot title states.
// Nothing is written.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Decomposition } from '../core/src/decompose';
import { kitIndex, kitRecords } from '../core/src/kitContents';
import { toolCounts } from '../core/src/research/verify';
import { NONE, ownerSplit } from '../core/src/scan/answers';
import { catalogConfirmed, homeDepotSplit, kitPageTools, type Nov24Rule, pageHalvesSplit, type SettleData, settleSplit } from '../core/src/scan/settle';
import { knownModels, readSplit } from '../core/src/scan/split';
import { looksLikeBundle, wantedFor } from '../core/src/scan/classify';
import { candidatesFor } from '../core/src/scan/listings';
import { grade } from '../core/src/match';
import type { PageReading, PartPriceRecord, ReviewItem, ScanStore } from '../core/src/scan/types';
import { loadScanFolder } from './data-folder';
import { ROOT } from './node-store';
import { CacheOnlyClient, loadInputs, ResponsesCache, runValidationPipeline, validationFiles } from './validate-cli';

const RULES: Nov24Rule[] = ['page_halves', 'accessory', 'part_page'];
const NAMES: Record<Nov24Rule, string> = { page_halves: 'A, the page names the two halves', accessory: 'B, a part Home Depot does not sell alone', part_page: "C, a part's own page" };
const allOff: Nov24Rule[] = [...RULES];
const only = (r: Nov24Rule): Nov24Rule[] => RULES.filter((x) => x !== r);

const same = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].map((m) => m.toUpperCase()).sort();
  const y = [...b].map((m) => m.toUpperCase()).sort();
  return x.length === y.length && x.every((m, i) => m === y[i]);
};
const show = (s: Decomposition): string => {
  if (s.status === 'resolved') return `resolved [${s.components.join(', ')}]`;
  if (s.waitingFor?.length) return `waits for ${s.waitingFor.join(', ')}`;
  return `question (${s.notes.slice(-1)[0] ?? ''})`;
};
const key = (s: Decomposition): string => JSON.stringify([s.status, s.status === 'resolved' ? [...s.components].sort() : [], s.waitingFor ?? [], s.notes.slice(-1)]);
const asOpen = (s: Decomposition): Decomposition => ({ components: s.components, status: 'needs_review', notes: ['hyphen split, but a part is not in the catalog'], alternatives: [[...s.components]] });

type Reading = { brand: string; model: string; itemId: string | null; matchedModel: string | null; price: number | null; title: string | null; link: string | null };
const reading = (k: string, r: Reading): PartPriceRecord => ({
  key: k, brand: r.brand.toUpperCase(), model: r.model.toUpperCase(), itemId: r.itemId, matchedModel: r.matchedModel?.toUpperCase() ?? null,
  price: r.price, title: r.title, link: r.link, seenAt: r.price === null ? null : 1, checkedAt: 1,
});

interface Tally { changed: number; right: number; wrong: number; open: number; byHand: number }
const tally = (): Tally => ({ changed: 0, right: 0, wrong: 0, open: 0, byHand: 0 });

// ---------------------------------------------------------------- (a) the validation set

async function validation(): Promise<ScanStore> {
  console.log('=== (a) the validation set (fixtures/validation, replay) ===');
  const dir = join(ROOT, 'fixtures', 'validation');
  const inputs = loadInputs(dir);
  const cache = new ResponsesCache(validationFiles(dir).responses);
  const run = await runValidationPipeline({ inputs, scanClient: new CacheOnlyClient(cache), lookupClient: new CacheOnlyClient(cache), continuePastMisses: true });
  const store = run.store;
  const known = await knownModels(store);
  const base: SettleData = {
    kitsOf: kitIndex(kitRecords(await store.listBundles(), await store.listCatalog())),
    partPrices: new Map([...inputs.partPrices].map(([k, r]) => [k, reading(k, r)] as const)),
    amazonCatalog: catalogConfirmed(await store.listMatches()),
  };
  for (const rule of RULES) {
    const t = tally();
    const lines: string[] = [];
    let probed = 0;
    let probeWrong = 0;
    for (const k of run.validation) {
      const b = await store.getBundle(k);
      if (!b || b.set) continue;
      const answer = inputs.answers.get(b.model.toUpperCase());
      const truth = answer ? (answer.parts === 'none' ? null : answer.parts) : (b.split?.status === 'resolved' ? b.split.components : null);
      const split = readSplit(b, { stored: known.stored, catalog: known.catalog });
      const before = settleSplit(b, split, known.catalog, { ...base, off: allOff });
      const after = settleSplit(b, split, known.catalog, { ...base, off: only(rule) });
      if (key(before) !== key(after)) {
        t.changed++;
        if (after.status !== 'resolved') t.open++;
        else if (truth && same(after.components, truth)) t.right++;
        else t.wrong++;
        lines.push(`  ${b.model.padEnd(22)} key ${truth ? truth.join(', ') : 'none'}: ${show(before)} -> ${show(after)}`);
      }
      // The probe: the rule on a bundle the tool settled, as if open.
      if (split.status === 'resolved' && truth) {
        const data = { ...base, off: only(rule) };
        for (const p of [homeDepotSplit(b, asOpen(split), known.catalog, data), pageHalvesSplit(b, asOpen(split), known.catalog, data)]) {
          if (p?.status !== 'resolved') continue;
          probed++;
          if (!same(p.components, truth)) {
            probeWrong++;
            lines.push(`  probe ${b.model}: WRONG ${p.components.join(', ')}`);
          }
        }
      }
    }
    console.log(`Rule ${NAMES[rule]}: changed ${t.changed}, right ${t.right}, wrong ${t.wrong}, still open ${t.open}; probe ${probed} resolved, ${probeWrong} wrong.`);
    for (const l of lines) console.log(l);
  }
  return store;
}

// ---------------------------------------------------------------- (b) the owner's real stores

async function realStore(name: string): Promise<void> {
  console.log(`\n=== (b) fixtures/e2e-2026-11-23/${name} ===`);
  const store = await loadScanFolder(join(ROOT, 'fixtures', 'e2e-2026-11-23', name));
  const known = await knownModels(store);
  const reviews = new Map((await store.listReview()).map((r) => [r.id, r] as const));
  for (const rule of RULES) {
    const t = tally();
    const lines: string[] = [];
    let probed = 0;
    let probeWrong = 0;
    for (const b of await store.listBundles()) {
      if (b.set) continue;
      const split = readSplit(b, { stored: known.stored, catalog: known.catalog });
      const before = settleSplit(b, split, known.catalog, { ...known.settle, off: allOff });
      const after = settleSplit(b, split, known.catalog, { ...known.settle, off: only(rule) });
      if (key(before) !== key(after)) {
        t.changed++;
        const owner = ownerAnswer(reviews.get(`split:${b.key}`));
        if (after.status !== 'resolved') t.open++;
        else if (owner) (same(after.components, owner) ? t.right++ : t.wrong++);
        else t.byHand++;
        lines.push(`  ${b.model.padEnd(28)} ${show(before)} -> ${show(after)}${owner ? `  (owner: ${owner.join(', ')})` : after.status === 'resolved' ? '  (by hand)' : ''}`);
      }
      if (before.status === 'resolved') {
        const data = { ...known.settle, off: only(rule) };
        for (const p of [homeDepotSplit(b, asOpen(before), known.catalog, data), pageHalvesSplit(b, asOpen(before), known.catalog, data)]) {
          if (p?.status !== 'resolved') continue;
          probed++;
          if (!same(p.components, before.components)) {
            probeWrong++;
            lines.push(`  probe ${b.model}: DIFFERENT ${p.components.join(', ')} for ${before.components.join(', ')}`);
          }
        }
      }
    }
    console.log(`Rule ${NAMES[rule]}: changed ${t.changed}, resolved and right by the owner's answer ${t.right}, wrong ${t.wrong}, resolved to check by hand ${t.byHand}, waits or still a question ${t.open}; probe ${probed} resolved, ${probeWrong} different.`);
    for (const l of lines) console.log(l);
  }
}

/** The parts of the owner's own answer to a split question, or null (no answer, a scan's close, "none"). */
function ownerAnswer(item: ReviewItem | undefined): string[] | null {
  const s = ownerSplit(item);
  return s === null || s === NONE ? null : s.components;
}

// ---------------------------------------------------------------- (c) rule C's count against the kits' own titles

interface PageOf { brand: string; model: string; title: string; page: PageReading }

/** Every stored page of a kit's own model: catalog kits, and bundle records whose model is no bundle form (a plain kit). */
async function kitPages(store: ScanStore): Promise<PageOf[]> {
  const out: PageOf[] = [];
  for (const c of await store.listCatalog()) if (c.isKit && c.page && c.title) out.push({ brand: c.brand, model: c.model, title: c.title, page: c.page });
  for (const b of await store.listBundles()) if (!b.set && b.page && !looksLikeBundle(b.brand, b.model)) out.push({ brand: b.brand, model: b.model, title: b.title, page: b.page });
  return out;
}

/** The pages the follow-up loop read free in the owner's Chrome on Nov 23 (PSBCK102K2's own page among them). */
function recordedPages(): PageOf[] {
  const file = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'research', 'tools', 'followup-chrome.json'), 'utf8')) as { pages: Record<string, { sections: { title: string; model: string; bullets: string[] } }> };
  return Object.values(file.pages).map((p) => ({ brand: 'RYOBI', model: p.sections.model, title: p.sections.title, page: { bullets: p.sections.bullets, readAt: 1 } as PageReading }));
}

async function kitCounts(pages: PageOf[]): Promise<void> {
  console.log("\n=== (c) rule C's kit count (kitPageTools) against each kit's own title ===");
  const seen = new Set<string>();
  const t = { agree: 0, differ: 0, pageUnknown: 0, titleSilent: 0 };
  for (const p of pages) {
    const id = `${p.brand}:${p.model}`.toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const fromPage = kitPageTools(p.brand, p.model, { partPrices: new Map(), kitsOf: () => [{ brand: p.brand, model: p.model, itemId: '1', page: p.page }] });
    const fromTitle = toolCounts(p.title)[0];
    if (fromTitle === undefined) t.titleSilent++;
    else if (fromPage === null) t.pageUnknown++;
    else if (fromPage === fromTitle) t.agree++;
    else {
      t.differ++;
      console.log(`  DIFFER ${p.brand} ${p.model}: page ${fromPage}, title ${fromTitle} (${p.title})`);
    }
    if (fromPage !== null) console.log(`  ${p.brand} ${p.model}: page ${fromPage}, title ${fromTitle ?? 'no count'}`);
  }
  console.log(`Kit pages: ${seen.size}; page and title agree ${t.agree}, differ ${t.differ}; the page's items do not all say ${t.pageUnknown}; the title states no count ${t.titleSilent}.`);
}

// ---------------------------------------------------------------- (d) rule D: Home Depot's own pack size for a RYOBI model

interface Labels { [bundle: string]: { [part: string]: { correct: string[] | 'none'; uncertain?: string[] } } }

/** Every saved listing of a RYOBI part whose Home Depot title states a pack, graded with and without that pack size. */
async function packs(name: string, store: ScanStore, labels: Labels | null): Promise<void> {
  const withPacks = (await knownModels(store)).catalog;
  const without = (await knownModels(store, { noPacks: true })).catalog;
  const listings = await store.listListings();
  const key = (part: string): { correct: Set<string>; uncertain: Set<string> } | null => {
    for (const b of Object.values(labels ?? {})) {
      const l = b[part];
      if (l) return { correct: new Set(l.correct === 'none' ? [] : l.correct), uncertain: new Set(l.uncertain ?? []) };
    }
    return null;
  };
  const t = { parts: 0, graded: 0, changed: 0, right: 0, wrong: 0, byHand: 0 };
  const lines: string[] = [];
  for (const [model, entry] of withPacks) {
    if (entry.packQty === undefined) continue;
    t.parts++;
    const k = key(model);
    for (const c of candidatesFor('RYOBI', model, listings)) {
      t.graded++;
      const before = grade(wantedFor('RYOBI', model, without), c);
      const after = grade(wantedFor('RYOBI', model, withPacks), c);
      if (before.grade === after.grade) continue;
      t.changed++;
      const usable = (g: string): boolean => g === 'exact' || g === 'strong' || g === 'probable';
      let verdict = 'by hand';
      if (k && !k.uncertain.has(c.asin)) {
        const right = k.correct.has(c.asin) ? usable(after.grade) : !usable(after.grade);
        verdict = right ? 'right' : 'WRONG';
        if (right) t.right++;
        else t.wrong++;
      } else t.byHand++;
      lines.push(`  ${model} (Home Depot: pack of ${entry.packQty}) ${c.asin} "${c.title}": ${before.grade} -> ${after.grade} [${after.reasons.join('; ')}] (${verdict})`);
    }
  }
  console.log(`${name}: RYOBI parts with a Home Depot pack size ${t.parts}; listings graded ${t.graded}; changed ${t.changed}: right ${t.right}, wrong ${t.wrong}, by hand ${t.byHand}.`);
  for (const l of lines) console.log(l);
}

// ---------------------------------------------------------------- (e) rule E: sets holding other brands' items

async function sets(name: string, store: ScanStore): Promise<void> {
  const t = { sets: 0, other: 0, notEstimated: 0, stillAsked: 0 };
  const lines: string[] = [];
  for (const b of await store.listBundles()) {
    if (!b.set) continue;
    t.sets++;
    const s = readSplit(b, { stored: new Map(), catalog: new Map() });
    if (s.otherBrands?.length) {
      t.notEstimated++;
      lines.push(`  set ${b.itemId}: ${s.notes[0]}`);
    } else if (s.notes.some((n) => n.startsWith("a set item's own page names another brand"))) {
      t.stillAsked++;
      lines.push(`  set ${b.itemId}: still asked (${s.notes[0]})`);
    }
  }
  t.other = t.notEstimated + t.stillAsked;
  console.log(`${name}: sets ${t.sets}; an item of another brand ${t.other}: not estimated ${t.notEstimated}, still asked (an item of DEWALT or RYOBI in the other's set, or no brand) ${t.stillAsked}.`);
  for (const l of lines) console.log(l);
}

const validationStore = await validation();
console.log("\n=== (e) rule E: Home Depot sets holding other brands' items ===");
for (const name of ['after-scan5', 'after-scan6']) await sets(name, await loadScanFolder(join(ROOT, 'fixtures', 'e2e-2026-11-23', name)));
console.log("\n=== (d) rule D: Home Depot's pack size for a RYOBI model, on every saved listing of that model ===");
{
  // The validation store holds no part-price readings: Nov 18's are put in, as the scan would have stored them.
  const inputs = loadInputs(join(ROOT, 'fixtures', 'validation'));
  for (const [k, r] of inputs.partPrices) await validationStore.putPartPrice(reading(k, r));
  const labels = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'validation', 'labels-2026-11-18.json'), 'utf8')) as { labels: Labels };
  await packs('validation (labels-2026-11-18)', validationStore, labels.labels);
  for (const name of ['after-scan3', 'after-scan5', 'after-scan6']) await packs(name, await loadScanFolder(join(ROOT, 'fixtures', 'e2e-2026-11-23', name)), null);
}
const pages: PageOf[] = [...(await kitPages(validationStore)), ...recordedPages()];
for (const name of ['after-scan3', 'after-scan5', 'after-scan6']) {
  await realStore(name);
  pages.push(...(await kitPages(await loadScanFolder(join(ROOT, 'fixtures', 'e2e-2026-11-23', name)))));
}
await kitCounts(pages);
