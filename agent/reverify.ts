// Step 16: the agent's side of checking an AI answer again when new evidence exists (core/src/research/reverify.ts).
// Small hooks for work.ts, so the rest of the agent stays as it is:
//   - reverifyPass: every open split question whose live suggestion is unverified, with its ledger kept whole, is
//     checked again by code against what the scan stored since (Home Depot part-price readings, exact Amazon matches,
//     kit pages read since). No model call, no cost. Verified now: the record keeps its key and cost, says
//     `verifiedAfter: 'new_evidence'` and keeps what the first check said. Not yet: the models it waits for are kept.
//   - wantedReads: the models those answers name that no source confirms and the part-price reader never read: free
//     Home Depot reads in the owner's Chrome, asked for first (core/src/scan/runner.ts partPricesExtra / extra).
//   - withEvidenceKey and reaskDue (lever 2, off unless `ai.reaskOnNewEvidence`): each research ask is stamped with
//     the evidence it rests on and what it lacked; a question is asked again only when something it lacked now exists,
//     once per evidence key, at most MAX_REASKS times for the question as it reads now, under the monthly AI cap.
// Nothing here answers a question (rule 4): a suggestion stays a suggestion, and Autopilot's own rules decide.

import { gatherEvidence } from '../core/src/assist/evidence';
import { liveSuggestion, type StoredSuggestion } from '../core/src/assist/stored';
import type { Suggestion } from '../core/src/assist/types';
import { evidenceKey, lacksOf, resolvedLacks, reverifyResearch, TOOL_OF_KIND, type StoredFacts } from '../core/src/research/reverify';
import type { ResearchTrace } from '../core/src/research/loop';
import type { CatalogEntry, ResearchAnswer } from '../core/src/research/types';
import { choicesOf } from '../core/src/scan/answers';
import type { ReviewItem, ScanStore } from '../core/src/scan/types';
import type { AskOne } from './aiPass';

/** A question is asked again at most this many times for the question as it reads now (its signature). */
export const MAX_REASKS = 2;

type WithTrace = Suggestion & { research?: ResearchTrace };
const traceOf = (r: StoredSuggestion): ResearchTrace | undefined => (r.suggestion as WithTrace).research;

/** The answer the model gave: the trace's, else an unverified suggestion's research claim. */
function answerOf(r: StoredSuggestion): ResearchAnswer | null {
  const s = r.suggestion;
  return traceOf(r)?.answer ?? (s.status === 'unverified' ? s.researchClaim ?? null : null);
}

const catalogOf = async (store: ScanStore): Promise<CatalogEntry[]> =>
  (await store.listCatalog()).map((c): CatalogEntry => ({ brand: c.brand, model: c.model, title: c.title, kind: c.isKit ? 'kit' : 'part' }));

const factsOf = async (store: ScanStore): Promise<StoredFacts> => ({ partPrices: await store.listPartPrices(), matches: await store.listMatches() });

/** The open split questions whose live suggestion is unverified, with what is needed to check each again. */
async function openUnverified(store: ScanStore, records: readonly StoredSuggestion[]): Promise<{ item: ReviewItem; record: StoredSuggestion; answer: ResearchAnswer }[]> {
  const out: { item: ReviewItem; record: StoredSuggestion; answer: ResearchAnswer }[] = [];
  for (const item of await store.listReview()) {
    if (item.answer !== null || item.kind !== 'split') continue;
    const record = liveSuggestion(records, item);
    if (!record || record.suggestion.status !== 'unverified' || !traceOf(record)) continue;
    const answer = answerOf(record);
    if (answer?.decision === 'parts') out.push({ item, record, answer });
  }
  return out;
}

export interface ReverifyDeps {
  store: ScanStore;
  suggestions: () => StoredSuggestion[];
  /** Keeps a record in place of the one with the same key. */
  replace: (record: StoredSuggestion) => void;
  now: () => number;
}

export interface ReverifyResult {
  /** Suggestions checked again. */
  checked: number;
  /** Questions whose suggestion is verified now. */
  verified: string[];
  /** Suggestions that wait for a Home Depot read of a model they name. */
  waiting: number;
}

/** Every open question's unverified suggestion checked again with what the scan stored since. No model call. */
export async function reverifyPass(d: ReverifyDeps): Promise<ReverifyResult> {
  const out: ReverifyResult = { checked: 0, verified: [], waiting: 0 };
  const todo = await openUnverified(d.store, d.suggestions());
  if (todo.length === 0) return out;
  const [catalog, facts] = await Promise.all([catalogOf(d.store), factsOf(d.store)]);
  for (const { item, record, answer } of todo) {
    const trace = traceOf(record)!;
    const r = reverifyResearch({ item, answer, ledger: trace.ledger, catalog, evidence: await gatherEvidence(d.store, item), facts });
    if (!r) continue;
    out.checked += 1;
    const first = record.suggestion.status === 'unverified' ? record.suggestion.reasons : [];
    const { waitingFor: _w, ...rest } = record;
    if (r.checked.status === 'verified') {
      const s = record.suggestion;
      const suggestion = { questionId: s.questionId, seen: s.seen, provider: s.provider, model: s.model, promptVersion: s.promptVersion, ...(s.usage ? { usage: s.usage } : {}), ...r.checked, research: trace } as Suggestion;
      d.replace({ ...rest, suggestion, verifiedAfter: 'new_evidence', firstCheck: record.firstCheck ?? { status: 'unverified', reasons: first }, recheckedAt: d.now() });
      out.verified.push(item.id);
      continue;
    }
    const reasons = r.checked.status === 'unverified' ? r.checked.reasons : first;
    const waitingFor = r.wanted.length > 0 ? r.wanted : undefined;
    if (waitingFor) out.waiting += 1;
    const same = JSON.stringify(reasons) === JSON.stringify(first) && JSON.stringify(waitingFor ?? null) === JSON.stringify(record.waitingFor ?? null);
    if (same) continue;
    // The reasons shown are the latest check's (fewer, once a reading confirmed a model); the first check's are kept.
    const suggestion = { ...record.suggestion, reasons } as Suggestion;
    d.replace({ ...rest, suggestion, firstCheck: record.firstCheck ?? { status: 'unverified', reasons: first }, recheckedAt: d.now(), ...(waitingFor ? { waitingFor } : {}) });
  }
  return out;
}

/** The models open questions' unverified answers name that no source confirms and Home Depot was never read for. */
export async function wantedReads(store: ScanStore, records: readonly StoredSuggestion[]): Promise<{ brand: string; model: string }[]> {
  const todo = await openUnverified(store, records);
  if (todo.length === 0) return [];
  const [catalog, facts] = await Promise.all([catalogOf(store), factsOf(store)]);
  const out = new Map<string, { brand: string; model: string }>();
  for (const { item, record, answer } of todo) {
    const r = reverifyResearch({ item, answer, ledger: traceOf(record)!.ledger, catalog, facts });
    for (const m of r?.wanted ?? []) out.set(`${item.brand.toUpperCase()}:${m}`, { brand: item.brand.toUpperCase(), model: m });
  }
  return [...out.values()];
}

/** The sentence a question shows while its suggestion waits for Home Depot's page of the models it names. */
export function waitingSentence(models: readonly string[] | undefined): string | null {
  if (!models || models.length === 0) return null;
  const list = models.length === 1 ? models[0]! : `${models.slice(0, -1).join(', ')} and ${models[models.length - 1]}`;
  return `Waiting for Home Depot's page for ${list} to confirm the ${models.length === 1 ? 'model' : 'models'}.`;
}

// ---------------------------------------------------------------- lever 2

/** The kits among a question's readings (the catalog marks them): a kit page read later is new evidence. */
async function kitModelsOf(store: ScanStore, item: ReviewItem): Promise<string[]> {
  const kits = new Set((await store.listCatalog()).filter((c) => c.isKit && c.brand.toUpperCase() === item.brand.toUpperCase()).map((c) => c.model.toUpperCase()));
  return [...new Set(choicesOf(item).flat().map((m) => m.toUpperCase()))].filter((m) => kits.has(m));
}

/** Tool names that gave a result in research asks made after `after` (any question): a failed tool that worked since. */
function workedSince(records: readonly StoredSuggestion[], after: number): Set<string> {
  const out = new Set<string>();
  for (const r of records) {
    if (r.askedAt <= after) continue;
    for (const e of traceOf(r)?.ledger ?? []) {
      const tool = TOOL_OF_KIND[e.kind];
      if (tool) out.add(tool);
    }
  }
  return out;
}

/** An AskOne that stamps each research ask with the evidence it rests on and what it lacked (lever 2). */
export function withEvidenceKey(askOne: AskOne, store: ScanStore): AskOne {
  return async (item, route, signal) => {
    const record = await askOne(item, route, signal);
    if (route !== 'research') return record;
    try {
      const evidence = await gatherEvidence(store, item);
      const lacks = lacksOf(record.suggestion.status, traceOf(record)?.failedTools, evidence, await kitModelsOf(store, item));
      return { ...record, evidenceKey: evidenceKey(evidence), ...(lacks.length > 0 ? { lacks } : {}) };
    } catch {
      return record;
    }
  };
}

/**
 * Lever 2: the open split questions to ask again, each with the record it asks again and the evidence key it would be
 * asked on. Due only when the live suggestion is not verified, something it lacked exists now, no ask of the question
 * was made on that key already, and fewer than MAX_REASKS re-asks were made for the question as it reads now.
 */
export async function reaskDue(store: ScanStore, records: readonly StoredSuggestion[]): Promise<Map<string, { of: string; evidenceKey: string }>> {
  const out = new Map<string, { of: string; evidenceKey: string }>();
  for (const item of await store.listReview()) {
    if (item.answer !== null || item.kind !== 'split') continue;
    const live = liveSuggestion(records, item);
    if (!live || (live.suggestion.status !== 'unverified' && live.suggestion.status !== 'cannot_tell') || !live.lacks?.length) continue;
    const mine = records.filter((r) => r.questionId === item.id && r.seen === live.seen);
    if (mine.filter((r) => r.reaskOf !== undefined).length >= MAX_REASKS) continue;
    const evidence = await gatherEvidence(store, item);
    const resolved = resolvedLacks(live.lacks, evidence, workedSince(records, live.askedAt));
    if (resolved.length === 0) continue;
    const key = evidenceKey(evidence, resolved);
    if (mine.some((r) => r.evidenceKey === key)) continue;
    out.set(item.id, { of: live.key, evidenceKey: key });
  }
  return out;
}
