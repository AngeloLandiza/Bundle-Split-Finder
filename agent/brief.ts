// The brief pass (step 16): after a suggestion is made (the scan's AI pass, Ask AI, Ask about all) and, lazily, for stored
// suggestions that have none (a batch at agent start, at most BACKFILL_LIMIT), one small model call per question writes the
// three plain lines above it (core/src/brief). The call explains a suggestion and changes nothing: the answer, its status
// and what Autopilot may apply are not read from it. Its cost is kept on the suggestion (briefMeta) and counts in the month's
// AI cap (views.ts aiSpentThisMonth); with the cap reached, no key, no known price or no found quote, the owner keeps the
// rules brief, which needs none of them. Every sentence the model writes is checked by code (core/src/brief/ground.ts).

import { pipelinesFrom } from '../core/src/ai/factory';
import { gatherEvidence } from '../core/src/assist/evidence';
import { liveSuggestion, type StoredBriefMeta, type StoredSuggestion } from '../core/src/assist/stored';
import { briefInputOf, linksOfEvidence, poolOfEvidence } from '../core/src/brief/input';
import { BRIEF_PROMPT_VERSION } from '../core/src/brief/prompt';
import { type BriefModel, estimatedBriefCost, worthABrief, writeBrief } from '../core/src/brief/pipeline';
import type { ReviewItem, ScanStore } from '../core/src/scan/types';
import type { AiPassResult } from './aiPass';
import type { Store } from './store';
import { aiSpentThisMonth } from './views';

/** Stored suggestions given a brief when the agent starts, at most. */
export const BACKFILL_LIMIT = 20;
/** One brief call may take this long. */
export const BRIEF_TIMEOUT_MS = 60_000;
/** A suggestion whose brief attempt gave nothing is not tried again for this long. */
export const RETRY_AFTER_MS = 24 * 60 * 60_000;
/** This many failed calls in a row (the provider, not the question) end the pass. */
export const MAX_BRIEF_FAILURES = 3;

export interface BriefCtx {
  store: Store;
  scanStore: ScanStore;
  keyFor(ref: string): string | undefined;
  fetchFn: typeof fetch;
  now(): number;
  signal: AbortSignal;
}

export interface BriefPassResult {
  /** Briefs a model wrote and the checks passed. */
  written: number;
  /** Calls made. */
  asked: number;
  costUsd: number;
  /** Why the pass stopped before the end, in one sentence, or null. */
  problem: string | null;
}

const inFlight = new WeakMap<object, Set<string>>();

/** A suggestion that has a brief, or was tried lately, is left alone. */
const needsBrief = (s: StoredSuggestion, now: number): boolean => s.brief === undefined && (s.briefMeta === undefined || now - s.briefMeta.at >= RETRY_AFTER_MS);

/**
 * Writes the briefs that are missing for live suggestions: `only` limits it to those questions, `limit` to that many calls.
 * Never throws; a problem is a sentence.
 */
export async function briefPass(ctx: BriefCtx, opts: { only?: string[]; limit?: number } = {}): Promise<BriefPassResult> {
  const out: BriefPassResult = { written: 0, asked: 0, costUsd: 0, problem: null };
  const { store } = ctx;
  const app = store.get('settings');
  const capUsd = app.ai.monthlyCapUsd;
  if (capUsd <= 0) return out;
  // No brief model (no key yet, a model with no address): the rules brief is the owner's, with no sentence about it.
  const pipelines = pipelinesFrom(app.ai, { resolveKey: (ref) => ctx.keyFor(ref), fetchFn: ctx.fetchFn });
  if (!pipelines.brief.ok) return out;
  const model: BriefModel = pipelines.brief.value;
  const estimate = estimatedBriefCost(model.model);

  const busy = inFlight.get(store) ?? new Set<string>();
  inFlight.set(store, busy);
  const open = (await ctx.scanStore.listReview()).filter((q) => q.answer === null && (!opts.only || opts.only.includes(q.id)));
  const queue: { item: ReviewItem; key: string; askedAt: number }[] = [];
  for (const item of open) {
    const live = liveSuggestion(store.get('suggestions'), item);
    if (live && needsBrief(live, ctx.now()) && !busy.has(live.key)) queue.push({ item, key: live.key, askedAt: live.askedAt });
  }
  // The newest suggestions first: the owner just asked about them.
  queue.sort((a, b) => b.askedAt - a.askedAt);

  let failures = 0;
  for (const { item, key } of queue.slice(0, opts.limit ?? queue.length)) {
    if (ctx.signal.aborted) break;
    if (estimate === null) {
      out.problem = `No price is known for ${model.model}, so the monthly AI limit could not hold; the plain summaries use the rules.`;
      break;
    }
    const spent = aiSpentThisMonth({ suggestions: store.get('suggestions'), runs: store.get('activity').runs }, ctx.now());
    if (spent + estimate > capUsd) {
      out.problem = `This month's AI limit of $${capUsd.toFixed(2)} is reached; the plain summaries use the rules until next month or a higher limit.`;
      break;
    }
    const live = liveSuggestion(store.get('suggestions'), item);
    if (!live || live.key !== key || !needsBrief(live, ctx.now()) || busy.has(key)) continue;
    // Read again before its turn: the owner may have answered it meanwhile.
    const now = await ctx.scanStore.getReview(item.id);
    if (!now || now.answer !== null) continue;
    busy.add(key);
    try {
      const evidence = await gatherEvidence(ctx.scanStore, now);
      const input = briefInputOf(now, live.suggestion, poolOfEvidence(evidence), linksOfEvidence(evidence));
      if (!worthABrief(input)) {
        keep(ctx, key, undefined, { at: ctx.now(), provider: model.provider, model: model.model, promptVersion: BRIEF_PROMPT_VERSION, called: false, costUsd: null, fellBack: 'No quote of the suggestion was found on its page.' });
        continue;
      }
      const outcome = await writeBrief(input, model, AbortSignal.any([ctx.signal, AbortSignal.timeout(BRIEF_TIMEOUT_MS)]));
      if (ctx.signal.aborted && outcome.usage === undefined) break;
      out.costUsd += outcome.costUsd ?? 0;
      // A call that gave no answer at all (the network, the provider) leaves no mark: it is tried again next time.
      if (outcome.usage === undefined) {
        failures += 1;
        if (failures >= MAX_BRIEF_FAILURES) {
          out.problem = `${outcome.fellBack ?? 'The AI failed three times in a row.'} The plain summaries use the rules.`;
          break;
        }
        continue;
      }
      failures = 0;
      out.asked += 1;
      keep(ctx, key, outcome.brief.writtenBy === 'ai' ? outcome.brief : undefined, {
        at: ctx.now(), provider: outcome.provider ?? model.provider, model: outcome.model ?? model.model, promptVersion: outcome.promptVersion,
        called: outcome.called, costUsd: outcome.costUsd, usage: outcome.usage, ...(outcome.fellBack ? { fellBack: outcome.fellBack } : {}),
      });
      if (outcome.brief.writtenBy === 'ai') out.written += 1;
    } finally {
      busy.delete(key);
    }
  }
  return out;
}

/** Keeps a brief and the attempt behind it on the suggestion, if it is still there. */
function keep(ctx: BriefCtx, key: string, brief: StoredSuggestion['brief'], meta: StoredBriefMeta): void {
  ctx.store.update('suggestions', (all) => all.map((s) => (s.key === key ? { ...s, ...(brief ? { brief } : {}), briefMeta: meta } : s)));
}

/** The AI pass's result with the briefs it led to: their cost counts in the run's AI cost, a problem is added when the pass had none. */
export async function addBriefs(result: AiPassResult, ctx: BriefCtx, only?: string[]): Promise<AiPassResult> {
  const b = await briefPass(ctx, only ? { only } : {}).catch((): BriefPassResult => ({ written: 0, asked: 0, costUsd: 0, problem: null }));
  return { ...result, costUsd: result.costUsd + b.costUsd, problem: result.problem ?? b.problem };
}

/** The batch at agent start: the stored suggestions that have no brief, at most BACKFILL_LIMIT. */
export const backfillBriefs = (ctx: BriefCtx): Promise<BriefPassResult> => briefPass(ctx, { limit: BACKFILL_LIMIT });
