// Step 16: an answer the code could not verify is checked again when new evidence exists, with no new model call.
// The answer is the model's own, as it gave it; only the sources change, and every source added is one the scan
// stored by itself, free: a Home Depot part-price reading (the owner's Chrome searched Home Depot for brand + model
// and read the product page it found), an Amazon match graded exact, or a kit's Home Depot page read since. The
// verifier (verify.ts) is the same and only lowers; a stored reading counts exactly as a Home Depot page in the
// ledger counts (its model field, its title), and is never quotable: the model never saw it.
//
// Lever 2 (re-ask) lives here too, as pure rules: a question is asked again only when what its answer lacked now
// exists (evidenceKey changed), never twice on the same evidence. Off unless the owner's setting turns it on.
//
// Pure: no store, no clock, no network (CLAUDE.md layout). The agent (agent/reverify.ts) feeds it the store.

import type { AssistEvidence, CheckedSuggestion } from '../assist/types';
import { findModel, normaliseText } from '../judge/verify';
import { modelForms, sameModel } from '../match';
import { twinKeys } from '../scan/twins';
import { type MatchRecord, partKey, type PartPriceRecord, type ReviewItem } from '../scan/types';
import { ledgerFromEvidence, safeUrl } from './ledger';
import type { CatalogEntry, ResearchAnswer, ResearchLedgerEntry } from './types';
import { verifyResearch } from './verify';

const up = (s: string): string => s.trim().toUpperCase();

/** What the scan stored by itself that may confirm a model: Home Depot's part-price readings and the Amazon matches. */
export interface StoredFacts {
  partPrices: readonly PartPriceRecord[];
  matches?: readonly MatchRecord[];
}

/** A reading whose page was found: a price and the page's own model number. */
const found = (r: PartPriceRecord): boolean => r.price !== null && r.matchedModel !== null && r.matchedModel.trim() !== '';

/** The part models a research answer names, each once, upper case. */
export function answerModels(answer: ResearchAnswer | null): string[] {
  if (!answer || answer.decision !== 'parts') return [];
  return [...new Set(answer.parts.map((p) => up(p.model)).filter((m) => m !== ''))];
}

/** The stored part-price records of a model and its twins (PCL500 for PCL500B). */
function recordsOf(brand: string, model: string, facts: StoredFacts): PartPriceRecord[] {
  const keys = new Set([partKey(brand, model), ...twinKeys(brand, model)]);
  return facts.partPrices.filter((r) => keys.has(r.key));
}

/**
 * Ledger entries for what the scan stored of these models: each found Home Depot part-price reading whose page's
 * model is the part's (sameModel, as for any Home Depot page in the ledger) is a product with its title and link;
 * each Amazon match graded exact for the model is a product with no title (existence only: an Amazon title is a
 * seller's words). No lines: the model never saw them, so nothing can be quoted from them. A reading of the bundle
 * itself is never one.
 */
export function storedReadingEntries(brand: string, bundleModel: string, models: readonly string[], facts: StoredFacts): ResearchLedgerEntry[] {
  const b = up(brand);
  const out: ResearchLedgerEntry[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    for (const r of recordsOf(b, m, facts)) {
      if (!found(r) || !sameModel(b, r.matchedModel!, m) || sameModel(b, r.matchedModel!, bundleModel)) continue;
      const model = up(r.matchedModel!);
      const id = `hd-reading:${model}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const url = safeUrl(r.link) ?? (r.itemId && /^\d+$/.test(r.itemId) ? `https://www.homedepot.com/p/${r.itemId}` : null);
      out.push({ id, kind: 'reading', label: 'Home Depot page (part price read)', url, lines: [], products: [{ brand: b, model, title: (r.title ?? '').trim(), kit: null }], isBundle: false });
    }
    for (const x of facts.matches ?? []) {
      if (up(x.brand) !== b || x.status !== 'matched' || x.grade !== 'exact' || !x.asin || !sameModel(b, x.model, m) || sameModel(b, x.model, bundleModel)) continue;
      const id = `amazon-match:${up(x.model)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, kind: 'reading', label: 'Amazon listing (exact match)', url: `https://www.amazon.com/dp/${x.asin}`, lines: [], products: [{ brand: b, model: up(x.model), title: '', kit: null }], isBundle: false });
    }
  }
  return out;
}

/**
 * The answer's part models that nothing shows to be real (verify.ts's rule 3): no product of the brand in the ledger,
 * no catalog entry, and no brand-site passage quoted under the part that names it.
 */
export function unconfirmedModels(brand: string, answer: ResearchAnswer | null, ledger: readonly ResearchLedgerEntry[], catalog: readonly CatalogEntry[]): string[] {
  const b = up(brand);
  if (!answer || answer.decision !== 'parts') return [];
  const products = ledger.flatMap((e) => e.products).filter((x) => x.brand === null || up(x.brand) === b);
  const out: string[] = [];
  for (const p of answer.parts) {
    const m = up(p.model);
    if (m === '' || out.includes(m)) continue;
    if (products.some((x) => sameModel(b, x.model, m)) || catalog.some((c) => up(c.brand) === b && sameModel(b, c.model, m))) continue;
    const site = p.quotes.some((q) => {
      const e = ledger.find((x) => x.kind === 'brand_site' && x.id === q.sourceId.trim());
      const norm = normaliseText(q.quote);
      return e !== undefined && e.lines.some((l) => normaliseText(l.text).includes(norm)) && modelForms(b, m).some((f) => findModel(norm, f) >= 0);
    });
    if (!site) out.push(m);
  }
  return out;
}

/** Whether a ledger kept its lines (a slimmed one keeps only each source's name and link, and cannot be checked again). */
export const ledgerHasText = (ledger: readonly ResearchLedgerEntry[]): boolean => ledger.some((e) => e.lines.length > 0);

export interface ReverifyInput {
  item: ReviewItem;
  /** The model's answer as it gave it (trace.answer, or the unverified suggestion's researchClaim). */
  answer: ResearchAnswer;
  /** The ledger the research kept, with its lines. */
  ledger: readonly ResearchLedgerEntry[];
  catalog: readonly CatalogEntry[];
  /** The stored evidence as it reads now (gatherEvidence): a kit page read since the question was asked joins the ledger. */
  evidence?: AssistEvidence;
  facts: StoredFacts;
}

export interface ReverifyResult {
  checked: CheckedSuggestion;
  /** Ids of the sources added that the research had not read. */
  added: string[];
  /** Models still unconfirmed and never read by the part-price reader: a free Home Depot read may confirm them. */
  wanted: string[];
}

/**
 * The answer checked again against the research's ledger plus what the scan stored since: the stored sources the
 * research did not have (a kit page read since; never a replacement of one it read, so every quote keeps its source)
 * and the stored readings of the answer's models. Null when the ledger kept no text. Never raises by itself: the
 * verifier decides, as it decided the first time.
 */
export function reverifyResearch(input: ReverifyInput): ReverifyResult | null {
  if (!ledgerHasText(input.ledger)) return null;
  const { item, answer, catalog, facts } = input;
  const ledger: ResearchLedgerEntry[] = input.ledger.map((e) => ({ ...e, lines: [...e.lines], products: [...e.products] }));
  const added: string[] = [];
  const have = new Set(ledger.map((e) => e.id));
  if (input.evidence && input.evidence.questionId === item.id) {
    for (const e of ledgerFromEvidence(input.evidence)) {
      if (have.has(e.id) || e.isBundle) continue;
      ledger.push(e);
      have.add(e.id);
      added.push(e.id);
    }
  }
  for (const e of storedReadingEntries(item.brand, item.model, answerModels(answer), facts)) {
    if (have.has(e.id)) continue;
    ledger.push(e);
    have.add(e.id);
    added.push(e.id);
  }
  const checked = verifyResearch(answer, item, ledger, [...catalog]);
  const wanted = checked.status === 'verified' ? []
    : unconfirmedModels(item.brand, answer, ledger, catalog).filter((m) => recordsOf(up(item.brand), m, facts).length === 0);
  return { checked, added, wanted };
}

// ---------------------------------------------------------------- lever 2: ask again when the evidence changed

/** The tool a ledger entry's kind came from, so a later ask's ledger shows which tools worked. */
export const TOOL_OF_KIND: Partial<Record<ResearchLedgerEntry['kind'], string>> = {
  homedepot_page: 'read_homedepot_page', homedepot_search: 'search_homedepot', catalog: 'catalog_lookup',
};

/**
 * What an ask lacked that may arrive later, as tags: `tool:<name>` a client tool that failed (a page Home Depot refused,
 * a search a cold tab could not run), `missing:<text>` a stored source the evidence said was missing (the bundle's page
 * not read), `kit:<MODEL>` a kit among the question's readings whose own page was not stored. Only for an answer that is
 * not verified and not "none fits". A model no source confirmed is lever 1's (checked again with no model call), not here.
 */
export function lacksOf(status: string, failedTools: readonly string[] | undefined, evidence: AssistEvidence, kitModels: readonly string[]): string[] {
  if (status !== 'unverified' && status !== 'cannot_tell') return [];
  const have = new Set(evidence.sources.map((s) => s.id));
  return [...new Set([
    ...(failedTools ?? []).map((t) => `tool:${t}`),
    ...evidence.missing.map((m) => `missing:${m}`),
    ...kitModels.map(up).filter((m) => !have.has(`kit:${m}`)).map((m) => `kit:${m}`),
  ])].sort();
}

/** The lacks that exist now: the tool worked in a later ask, the source is no longer missing, the kit's page is stored. */
export function resolvedLacks(lacks: readonly string[], evidence: AssistEvidence, workedSince: ReadonlySet<string>): string[] {
  const have = new Set(evidence.sources.map((s) => s.id));
  return lacks.filter((l) => {
    if (l.startsWith('tool:')) return workedSince.has(l.slice(5));
    if (l.startsWith('missing:')) return !evidence.missing.includes(l.slice(8));
    if (l.startsWith('kit:')) return have.has(l);
    return false;
  });
}

/**
 * The evidence an ask rests on, as one string: the stored sources (with their line counts), what was missing, and which
 * lacks have been resolved since. Two asks on the same key saw the same evidence: asking again needs a new key.
 */
export function evidenceKey(evidence: AssistEvidence, resolved: readonly string[] = []): string {
  return JSON.stringify({
    sources: evidence.sources.map((s) => `${s.id}:${s.lines.length}`).sort(),
    missing: [...evidence.missing].sort(),
    resolved: [...new Set(resolved)].sort(),
  });
}
