// The AI pass (step 13, Decision 5): after each run the agent asks the AI about every open Review question that has
// no suggestion yet, one at a time, as Ask AI about all does in the extension (step 12). A split question is
// researched (it reads Home Depot through the paired Chrome, so it waits while Chrome is closed); a match question is
// asked from the evidence the scan stored. Every result is kept as a suggestion, never as an answer (rule 4):
// Autopilot (autopilot.ts) applies only what code verified. The month's AI cap holds: a question is asked only when
// its estimated cost still fits, and a model with no known price is not asked automatically at all (no guessed cost).

import { afterLead } from '../core/src/ai/factory';
import { askQueueOf } from '../core/src/assist/askAll';
import { estimatedQuestionCost } from '../core/src/assist/cost';
import { gatherEvidence } from '../core/src/assist/evidence';
import { liveSuggestion, suggestionCost, suggestionKey, type StoredSuggestion } from '../core/src/assist/stored';
import { suggestAnswer } from '../core/src/assist/suggest';
import type { AssistModel } from '../core/src/assist/types';
import { PRICE_TABLE } from '../core/src/judge/eval';
import { researchCost } from '../core/src/research/eval';
import { researchQuestion, type ResearchSuggestion } from '../core/src/research/loop';
import type { CatalogEntry, ResearchModel, ResearchTools } from '../core/src/research/types';
import { reviewSignature } from '../core/src/scan/answers';
import type { ReviewItem, ScanStore } from '../core/src/scan/types';

export const MAX_FAILURES_IN_A_ROW = 3;
/** Longest one evidence-only call may take. Research has its own limits (core/src/research/prompt.ts). */
export const ASK_TIMEOUT_MS = 60_000;

export type AskRoute = 'assist' | 'research';
export type AskOne = (item: ReviewItem, route: AskRoute, signal: AbortSignal) => Promise<StoredSuggestion>;

export interface AiPassDeps {
  store: ScanStore;
  /** Suggestions kept so far (oldest first) and how to keep one. */
  suggestions: () => StoredSuggestion[];
  keep: (record: StoredSuggestion) => void;
  /**
   * Step 16: called with each suggestion right after it is kept for a question that is still as asked; the brief above the question is
   * written here, so it appears as the suggestion does. Returns the dollars it cost (they count in this pass and its cap) and a
   * sentence when it could not write one (the cap, no price); neither stops the pass.
   */
  afterKeep?: (record: StoredSuggestion) => Promise<{ costUsd: number; problem: string | null }>;
  /** The model each route uses, or why there is none (pipelinesFrom). */
  models: { assist: { ok: true; model: string } | { ok: false; error: string }; research: { ok: true; model: string } | { ok: false; error: string } };
  askOne: AskOne;
  /** Whether the paired Chrome is connected now: research reads Home Depot through it. */
  chromeConnected: () => boolean;
  /** Dollars the AI has cost this calendar month, and the cap. */
  spentUsd: number;
  capUsd: number;
  signal: AbortSignal;
  now: () => number;
  /** Only these questions (Ask AI on one); default every open one. */
  only?: string[];
  /**
   * Step 16, lever 2 (off unless the owner's setting turns it on): open split questions to ask again although a
   * suggestion is on screen, because what that ask lacked exists now (agent/reverify.ts reaskDue). Each is asked once
   * for its evidence key, after the questions with no suggestion, under the same monthly cap.
   */
  reask?: ReadonlyMap<string, { of: string; evidenceKey: string }>;
  /**
   * Step 16: open questions the owner asked about again with Ask anyway (POST /api/review/:id/ask { force }): asked although a
   * suggestion is on screen, once, under the same cap; the record names the one it asked again (`reaskOf`).
   */
  force?: readonly string[];
}

export interface AiPassResult {
  asked: number;
  suggested: number;
  verified: number;
  costUsd: number;
  /** Split questions left for when Chrome is connected. */
  waitingForChrome: number;
  /** Why the pass stopped before the end, in one sentence, or null. */
  problem: string | null;
}

/** A failed call that says the provider, not this question, is the trouble (as the extension's providerTrouble). */
const providerTrouble = (s: StoredSuggestion['suggestion']): boolean =>
  s.status === 'not_suggested' && s.notSuggested !== undefined &&
  !['refusal', 'max_tokens', 'bad_response', 'no_answer', 'unexpected_stop', 'bad_request', 'aborted'].includes(s.notSuggested.reason);

export async function runAiPass(deps: AiPassDeps): Promise<AiPassResult> {
  const out: AiPassResult = { asked: 0, suggested: 0, verified: 0, costUsd: 0, waitingForChrome: 0, problem: null };
  if (deps.capUsd <= 0) return { ...out, problem: 'The AI is off: its monthly limit is $0.' };
  const open = (await deps.store.listReview()).filter((q) => q.answer === null && (!deps.only || deps.only.includes(q.id))).sort((a, b) => a.openedAt - b.openedAt);
  const first = askQueueOf(open, deps.suggestions());
  const forced = new Set(deps.force ?? []);
  const queue = [...first, ...open.filter((q) => ((q.kind === 'split' && deps.reask?.has(q.id)) || forced.has(q.id)) && !first.includes(q))];
  let spent = deps.spentUsd;
  let failures = 0;
  let briefProblem: string | null = null;
  for (const item of queue) {
    if (deps.signal.aborted) break;
    const route: AskRoute = item.kind === 'split' ? 'research' : 'assist';
    const model = deps.models[route];
    if (!model.ok) {
      // Nov 23: the outcome first, then what to do ("AI answers skipped: no Anthropic key yet — add it in Settings › Keys.").
      out.problem ??= `AI answers skipped: ${afterLead(model.error)}`;
      continue;
    }
    if (route === 'research' && !deps.chromeConnected()) {
      out.waitingForChrome += 1;
      continue;
    }
    const estimate = estimatedQuestionCost(item.kind, model.model);
    if (estimate === null) {
      out.problem ??= `No price is known for ${model.model}, so the monthly AI limit could not hold; ask about these by hand.`;
      continue;
    }
    if (spent + estimate > deps.capUsd) {
      out.problem = `This month's AI limit of $${deps.capUsd.toFixed(2)} is reached; the other questions wait for next month or a higher limit.`;
      break;
    }
    // Read again before its turn: the owner may have answered it meanwhile.
    const now = await deps.store.getReview(item.id);
    if (!now || now.answer !== null) continue;
    let record: StoredSuggestion;
    try {
      record = await deps.askOne(now, route, deps.signal);
    } catch {
      continue;
    }
    const again = first.includes(item) ? undefined : deps.reask?.get(item.id);
    if (again) record = { ...record, reaskOf: again.of, evidenceKey: again.evidenceKey };
    else if (!first.includes(item) && forced.has(item.id)) {
      const before = liveSuggestion(deps.suggestions(), now);
      if (before) record = { ...record, reaskOf: before.key };
    }
    if (deps.signal.aborted && record.suggestion.status === 'not_suggested') break;
    const s = record.suggestion;
    const cost = record.costUsd ?? 0;
    spent += cost;
    out.costUsd += cost;
    if (s.status !== 'not_suggested' || s.usage !== undefined) {
      out.asked += 1;
      const after = await deps.store.getReview(item.id);
      const current = after !== undefined && after.answer === null && reviewSignature(after) === record.seen;
      // A suggestion for a question that changed meanwhile is kept closed, so it can never preselect an answer later.
      deps.keep(current ? record : { ...record, outcome: { answeredAt: deps.now(), answer: after?.answer ?? '', agreed: null } });
      if (current && s.status !== 'not_suggested') {
        out.suggested += 1;
        if (s.status === 'verified') out.verified += 1;
        if (deps.afterKeep) {
          const b = await deps.afterKeep(record);
          spent += b.costUsd;
          out.costUsd += b.costUsd;
          briefProblem ??= b.problem;
        }
      }
    }
    if (providerTrouble(s)) {
      failures += 1;
      if (failures >= MAX_FAILURES_IN_A_ROW) {
        out.problem = s.status === 'not_suggested' ? s.reason : 'The AI failed three times in a row.';
        break;
      }
    } else failures = 0;
  }
  out.problem ??= briefProblem;
  return out;
}

/** The default AskOne: research for a split question over the remote tools, the evidence-only call for a match. */
export function askOneWith(deps: {
  store: ScanStore;
  assist: AssistModel | null;
  research: ResearchModel | null;
  tools: () => ResearchTools;
  now: () => number;
}): AskOne {
  return async (item, route, signal) => {
    const evidence = await gatherEvidence(deps.store, item);
    if (route === 'assist') {
      if (!deps.assist) throw new Error('No assist model.');
      const suggestion = await suggestAnswer(item, evidence, deps.assist, AbortSignal.any([signal, AbortSignal.timeout(ASK_TIMEOUT_MS)]));
      const askedAt = deps.now();
      return { key: suggestionKey(item.id, askedAt), questionId: item.id, seen: suggestion.seen, askedAt, suggestion, costUsd: suggestionCost(deps.assist.model, suggestion.usage) };
    }
    if (!deps.research) throw new Error('No research model.');
    const catalog = (await deps.store.listCatalog()).map((c): CatalogEntry => ({ brand: c.brand, model: c.model, title: c.title, kind: c.isKit ? 'kit' : 'part' }));
    const result = await researchQuestion(item, evidence, deps.tools(), deps.research, { signal, catalog });
    return researchRecord(item, result, deps.research.model, deps.now());
  };
}

/**
 * A research result as it is kept. What is kept of the trace is each source's name and link, as the extension keeps it: not the
 * pages' text. Step 16: an answer not verified keeps its ledger whole, so it can be checked again when new evidence arrives
 * (agent/reverify.ts, agent/followUp.ts) with no new model call; the pages' text is the owner's own data, kept in his store.
 */
export function researchRecord(item: ReviewItem, result: ResearchSuggestion, model: string, askedAt: number): StoredSuggestion {
  const { research: trace, ...suggestion } = result;
  const whole = suggestion.status === 'unverified' || suggestion.status === 'cannot_tell';
  const slim = whole ? { ...suggestion, research: trace } : { ...suggestion, research: { ...trace, ledger: trace.ledger.map((e) => ({ id: e.id, kind: e.kind, label: e.label, url: e.url, lines: [], products: [], isBundle: e.isBundle })) } };
  const rates = PRICE_TABLE[model];
  return {
    key: suggestionKey(item.id, askedAt), questionId: item.id, seen: result.seen, askedAt, suggestion: slim as typeof suggestion,
    costUsd: rates && result.usage ? researchCost({ ...result.usage, webSearchRequests: trace.usage.webSearchRequests }, rates) : null,
  };
}
