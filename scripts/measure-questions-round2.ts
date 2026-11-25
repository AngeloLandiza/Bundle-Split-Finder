// npx tsx scripts/measure-questions-round2.ts. Free, no network: measures the Nov 25 settle rules (core/src/scan/settle.ts,
// "Questions, round 2" in docs/decisions.md) the way the Nov 24 rules were measured (scripts/measure-fewer-questions.ts),
// before they are adopted. For each rule, alone, on top of every rule already adopted:
//   (a) the validation set (fixtures/validation, replayed): every bundle's split against the answer key, with Home Depot's
//       Nov 18 part prices as the readings; changed / right / wrong / still open;
//   (b) the owner's real stores (fixtures/e2e-2026-11-23/after-scan3, after-scan5, after-scan6): every bundle the rule
//       changes (each read from its model number and page, the owner's answer set aside), scored against his own answer
//       when he gave one, otherwise listed for a check by hand against its pages;
//   (c) rule F's model-number convention on every special buy any recording holds: every other Home Depot row of exactly
//       its title, and whether that row's model number spells the tools the convention reads (rule F adopts only if all do);
//   (d) rule G on every DEWALT "<kit>W<two digits>" any store holds, with what the rule reads.
// Nothing is written.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { type Decomposition } from '../core/src/decompose';
import { kitIndex, kitRecords } from '../core/src/kitContents';
import { sameModel } from '../core/src/match';
import { NONE, ownerSplit } from '../core/src/scan/answers';
import { catalogConfirmed, pageCode, sameTitleKey, type SettleData, type SettleRule, settleSplit } from '../core/src/scan/settle';
import { knownModels, readSplit, titleIndex } from '../core/src/scan/split';
import type { PartPriceRecord, ReviewItem } from '../core/src/scan/types';
import { loadScanFolder } from './data-folder';
import { ROOT } from './node-store';
import { CacheOnlyClient, loadInputs, ResponsesCache, runValidationPipeline, validationFiles } from './validate-cli';

const RULES: SettleRule[] = ['special_buy_twin', 'page_code'];
const NAMES: Record<string, string> = { special_buy_twin: 'F, a special buy Home Depot also sells as its tools', page_code: 'G, a short code the page spells out' };
const allOff: SettleRule[] = [...RULES];
const only = (r: SettleRule): SettleRule[] => RULES.filter((x) => x !== r);

const same = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].map((m) => m.toUpperCase()).sort();
  const y = [...b].map((m) => m.toUpperCase()).sort();
  return x.length === y.length && x.every((m, i) => m === y[i]);
};
const show = (s: Decomposition): string => {
  if (s.status === 'resolved') return `resolved [${s.components.join(', ')}]`;
  if (s.waitingFor?.length) return `waits for ${s.waitingFor.join(', ')}`;
  return `question (${s.notes.join('; ')})${s.alternatives?.length ? ` offering [${s.alternatives.map((a) => a.join(' + ')).join('], [')}]` : ''}`;
};
const key = (s: Decomposition): string => JSON.stringify([s.status, s.status === 'resolved' ? [...s.components].sort() : [], s.waitingFor ?? [], s.notes, s.alternatives ?? []]);

type Reading = { brand: string; model: string; itemId: string | null; matchedModel: string | null; price: number | null; title: string | null; link: string | null };
const reading = (k: string, r: Reading): PartPriceRecord => ({
  key: k, brand: r.brand.toUpperCase(), model: r.model.toUpperCase(), itemId: r.itemId, matchedModel: r.matchedModel?.toUpperCase() ?? null,
  price: r.price, title: r.title, link: r.link, seenAt: r.price === null ? null : 1, checkedAt: 1,
});

interface Tally { changed: number; right: number; wrong: number; open: number; byHand: number }
const tally = (): Tally => ({ changed: 0, right: 0, wrong: 0, open: 0, byHand: 0 });

// ---------------------------------------------------------------- (a) the validation set

async function validation(): Promise<void> {
  console.log('=== (a) the validation set (fixtures/validation, replay) ===');
  const dir = join(ROOT, 'fixtures', 'validation');
  const inputs = loadInputs(dir);
  const cache = new ResponsesCache(validationFiles(dir).responses);
  const run = await runValidationPipeline({ inputs, scanClient: new CacheOnlyClient(cache), lookupClient: new CacheOnlyClient(cache), continuePastMisses: true });
  const store = run.store;
  const known = await knownModels(store);
  const bundles = await store.listBundles();
  const base: SettleData = {
    kitsOf: kitIndex(kitRecords(bundles, await store.listCatalog())),
    partPrices: new Map([...inputs.partPrices].map(([k, r]) => [k, reading(k, r)] as const)),
    amazonCatalog: catalogConfirmed(await store.listMatches()),
    sameTitle: titleIndex(bundles),
  };
  for (const rule of RULES) {
    const t = tally();
    const lines: string[] = [];
    for (const k of run.validation) {
      const b = await store.getBundle(k);
      if (!b || b.set) continue;
      const answer = inputs.answers.get(b.model.toUpperCase());
      const truth = answer ? (answer.parts === 'none' ? null : answer.parts) : (b.split?.status === 'resolved' ? b.split.components : null);
      const split = readSplit(b, { stored: known.stored, catalog: known.catalog });
      const before = settleSplit(b, split, known.catalog, { ...base, off: allOff });
      const after = settleSplit(b, split, known.catalog, { ...base, off: only(rule) });
      if (key(before) === key(after)) continue;
      t.changed++;
      if (after.status !== 'resolved') t.open++;
      else if (truth && same(after.components, truth)) t.right++;
      else t.wrong++;
      lines.push(`  ${b.model.padEnd(22)} key ${truth ? truth.join(', ') : 'none'}: ${show(before)} -> ${show(after)}`);
    }
    console.log(`Rule ${NAMES[rule]}: changed ${t.changed}, right ${t.right}, wrong ${t.wrong}, still open or waiting ${t.open}.`);
    for (const l of lines) console.log(l);
  }
  // Every special buy of the set, with both rules on, against its key (the ones rule F leaves as they were too).
  for (const b of bundles.filter((x) => !x.set && /SB(-|$)/.test(x.model))) {
    const answer = inputs.answers.get(b.model.toUpperCase());
    const s = settleSplit(b, readSplit(b, { stored: known.stored, catalog: known.catalog }), known.catalog, base);
    console.log(`  special buy ${b.model.padEnd(20)} key ${answer ? (answer.parts === 'none' ? 'none' : answer.parts.join(', ')) : 'no key'}: ${show(s)}`);
  }
}

// ---------------------------------------------------------------- (b) the owner's real stores

function ownerAnswer(item: ReviewItem | undefined): string[] | null {
  const s = ownerSplit(item);
  return s === null || s === NONE ? null : s.components;
}

async function realStore(name: string): Promise<void> {
  console.log(`\n=== (b) fixtures/e2e-2026-11-23/${name} ===`);
  const store = await loadScanFolder(join(ROOT, 'fixtures', 'e2e-2026-11-23', name));
  const known = await knownModels(store);
  const reviews = new Map((await store.listReview()).map((r) => [r.id, r] as const));
  for (const rule of RULES) {
    const t = tally();
    const lines: string[] = [];
    for (const b of await store.listBundles()) {
      if (b.set) continue;
      const split = readSplit(b, { stored: known.stored, catalog: known.catalog });
      const before = settleSplit(b, split, known.catalog, { ...known.settle, off: allOff });
      const after = settleSplit(b, split, known.catalog, { ...known.settle, off: only(rule) });
      if (key(before) === key(after)) continue;
      t.changed++;
      const owner = ownerAnswer(reviews.get(`split:${b.key}`));
      if (after.status !== 'resolved') t.open++;
      else if (owner) (same(after.components, owner) ? t.right++ : t.wrong++);
      else t.byHand++;
      const verdict = after.status !== 'resolved' ? '' : owner ? (same(after.components, owner) ? '  (owner: right)' : `  (owner: ${owner.join(', ')}: WRONG)`) : '  (by hand)';
      lines.push(`  ${b.model.padEnd(28)} ${show(before)}\n      -> ${show(after)}${verdict}`);
    }
    console.log(`Rule ${NAMES[rule]}: changed ${t.changed}, resolved and right by the owner's answer ${t.right}, wrong ${t.wrong}, resolved to check by hand ${t.byHand}, waits or still a question ${t.open}.`);
    for (const l of lines) console.log(l);
  }
}

// ---------------------------------------------------------------- (c) rule F's convention on every recorded special buy

interface Row { brand: string; model: string; title: string; file: string }

/** Every object in a recording with a brand of DEWALT or RYOBI, a model (model_number or model) and a title. */
function rowsOf(file: string, node: unknown, out: Row[]): void {
  if (Array.isArray(node)) { for (const x of node) rowsOf(file, x, out); return; }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  const model = typeof o.model_number === 'string' ? o.model_number : typeof o.model === 'string' ? o.model : null;
  const brand = typeof o.brand === 'string' ? o.brand.trim().toUpperCase() : null;
  if (model && brand && typeof o.title === 'string' && (brand === 'RYOBI' || brand === 'DEWALT')) out.push({ brand, model: model.trim().toUpperCase(), title: o.title, file });
  for (const v of Object.values(o)) rowsOf(file, v, out);
}

function walk(dir: string, out: string[]): void {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith('.json')) out.push(p);
  }
}

function specialBuys(): void {
  console.log("\n=== (c) rule F's model-number convention: every recorded special buy and every other row of exactly its title ===");
  const files: string[] = [];
  walk(join(ROOT, 'fixtures'), files);
  const rows: Row[] = [];
  for (const f of files) {
    try { rowsOf(f.slice(ROOT.length + 1), JSON.parse(readFileSync(f, 'utf8')), rows); } catch { /* not JSON we read */ }
  }
  const byTitle = new Map<string, Row[]>();
  for (const r of rows) byTitle.set(sameTitleKey(r.brand, r.title), [...(byTitle.get(sameTitleKey(r.brand, r.title)) ?? []), r]);
  const sbs = [...new Set(rows.filter((r) => /^[A-Z0-9]+SB$/.test(r.model)).map((r) => `${r.brand}|${r.model}`))].sort();
  const t = { sbs: 0, sixDigit: 0, withTwin: 0, agree: 0, disagree: 0, twinOther: 0 };
  for (const id of sbs) {
    const [brand, model] = id.split('|') as [string, string];
    t.sbs++;
    const six = /^([A-Z]{2,4})(\d{3})(\d{3})SB$/.exec(model);
    const tools = six && six[2] !== six[3] ? [`${six[1]}${six[2]}B`, `${six[1]}${six[3]}B`] : null;
    if (tools) t.sixDigit++;
    const titles = [...new Set(rows.filter((r) => r.brand === brand && r.model === model).map((r) => sameTitleKey(r.brand, r.title)))];
    const twins = [...new Map(titles.flatMap((k) => byTitle.get(k) ?? []).filter((r) => r.model !== model).map((r) => [r.model, r] as const)).values()];
    if (twins.length > 0) t.withTwin++;
    const verdicts = twins.map((r) => {
      const pieces = r.model.split('-');
      if (!tools) { t.twinOther++; return `${r.model} (the convention reads nothing for ${model})`; }
      const ok = pieces.length === tools.length && tools.every((x) => pieces.some((p) => sameModel(brand, p, x))) && pieces.every((p) => tools.some((x) => sameModel(brand, p, x)));
      if (ok) t.agree++;
      else t.disagree++;
      return `${r.model} ${ok ? 'agrees' : 'DISAGREES'} (${r.file})`;
    });
    console.log(`  ${model.padEnd(16)} convention ${tools ? tools.join(' + ') : 'none (not prefix + two three-digit numbers)'}; same-titled rows: ${verdicts.length ? verdicts.join('; ') : 'none'}`);
  }
  console.log(`Special buys recorded ${t.sbs}; of the six-digit form ${t.sixDigit}; with a same-titled row of another model ${t.withTwin}: that row spells the convention's tools ${t.agree}, disagrees ${t.disagree}, the convention reads nothing ${t.twinOther}.`);
}

// ---------------------------------------------------------------- (d) rule G on every DEWALT "<kit>W<two digits>"

async function shortCodes(): Promise<void> {
  console.log('\n=== (d) rule G: every DEWALT <kit>W<two digits> a store holds ===');
  const seen = new Set<string>();
  for (const name of ['scan', 'after-scan3', 'after-scan5', 'after-scan6']) {
    const store = await loadScanFolder(join(ROOT, 'fixtures', 'e2e-2026-11-23', name));
    const known = await knownModels(store);
    const reviews = new Map((await store.listReview()).map((r) => [r.id, r] as const));
    for (const b of await store.listBundles()) {
      if (b.set || b.brand.toUpperCase() !== 'DEWALT' || !/W\d{2}$/.test(b.model) || seen.has(`${b.model}|${b.page ? 1 : 0}`)) continue;
      seen.add(`${b.model}|${b.page ? 1 : 0}`);
      const split = readSplit(b, { stored: known.stored, catalog: known.catalog });
      const owner = ownerAnswer(reviews.get(`split:${b.key}`));
      const read = pageCode(b, split, known.catalog);
      console.log(`  ${name}: ${b.model} page ${b.page ? 'read' : 'not read'}; rule G reads ${read ? read.join(' + ') : 'nothing'}; owner ${owner ? owner.join(' + ') : 'no answer'}${read && owner ? (same(read, owner) ? ' (agrees)' : ' (DIFFERS)') : ''}`);
    }
  }
}

await validation();
for (const name of ['after-scan3', 'after-scan5', 'after-scan6']) await realStore(name);
specialBuys();
await shortCodes();
