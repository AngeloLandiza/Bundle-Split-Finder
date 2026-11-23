// Step 16, the follow-up loop's agent side (core/src/research/followUp.ts is the loop). The owner, Nov 23: "if I'm told to
// do this… why can't an AI pipeline do it for me". Small hooks for work.ts:
//   - followUpPass: every open split question whose live AI answer is unverified or "cannot tell" (or, with `only`, the one
//     the owner pressed Ask AI on) gets the loop: the free Chrome reads its structured record calls for, the code's check
//     again, and, when asks are allowed, at most two follow-up asks on new evidence under the monthly cap. Its state is kept
//     on the live suggestion (StoredSuggestion.followUp), so the card says what the app is doing, and "Needs you" does not
//     count the question while it runs (views.ts).
//   - askPlan: what POST /api/review/:id/ask does for a question that already has an answer, so a press is never silently
//     nothing: the loop when something is missing, a fresh ask when forced, or the reason in plain words.
// Nothing here answers a question (rule 4): a follow-up's answer is a suggestion that passed the same verifier, and
// Autopilot leaves follow-up answers to the owner until the loop is measured (autopilot.ts).

import { estimatedQuestionCost, questionCostLabel } from '../core/src/assist/cost';
import { gatherEvidence } from '../core/src/assist/evidence';
import { liveSuggestion, type StoredSuggestion } from '../core/src/assist/stored';
import type { Suggestion } from '../core/src/assist/types';
import {
  deriveTasks, followUpKey, freshFollowUp, MAX_FOLLOW_UP_ROUNDS, runFollowUp, type FollowUpAsk, type FollowUpState,
} from '../core/src/research/followUp';
import { researchQuestion, type ResearchTrace } from '../core/src/research/loop';
import type { CatalogEntry, ResearchAnswer, ResearchModel, ResearchTools } from '../core/src/research/types';
import { reviewSignature } from '../core/src/scan/answers';
import type { ReviewItem, ScanStore } from '../core/src/scan/types';
import { researchRecord } from './aiPass';

type WithTrace = Suggestion & { research?: ResearchTrace };
const traceOf = (r: StoredSuggestion): ResearchTrace | undefined => (r.suggestion as WithTrace).research;
const unsettled = (r: StoredSuggestion): boolean => r.suggestion.status === 'unverified' || r.suggestion.status === 'cannot_tell';
const working = (r: StoredSuggestion | undefined): boolean => r?.followUp !== undefined && (r.followUp.state === 'queued' || r.followUp.state === 'running');

function answerOf(r: StoredSuggestion): ResearchAnswer | null {
  const s = r.suggestion;
  return traceOf(r)?.answer ?? (s.status === 'unverified' ? s.researchClaim ?? null : null);
}

async function catalogOf(store: ScanStore): Promise<{ catalog: CatalogEntry[]; kitItemIds: Map<string, string> }> {
  const rows = await store.listCatalog();
  const kitItemIds = new Map<string, string>();
  for (const c of rows) if (c.isKit && c.itemId) kitItemIds.set(c.model.toUpperCase(), c.itemId);
  return { catalog: rows.map((c): CatalogEntry => ({ brand: c.brand, model: c.model, title: c.title, kind: c.isKit ? 'kit' : 'part' })), kitItemIds };
}

/** Whether the loop has anything to do for this live suggestion: a task its record calls for, or reads no ask has seen. */
function hasWork(item: ReviewItem, live: StoredSuggestion, catalog: CatalogEntry[], kitItemIds: Map<string, string>): boolean {
  const s = live.suggestion;
  const f = live.followUp;
  const tasks = deriveTasks({
    item, checked: { status: s.status, ...(s.status === 'unverified' && s.gaps ? { gaps: s.gaps } : {}) }, answer: answerOf(live), trace: traceOf(live) ?? null,
    ...(live.lacks ? { lacks: live.lacks } : {}), fetched: f?.entries ?? [], catalog, kitItemIds, done: new Set(f?.done ?? []),
  });
  const unasked = f !== undefined && f.entries.length > 0 && !f.askedKeys.includes(followUpKey(f.entries)) && f.rounds < MAX_FOLLOW_UP_ROUNDS;
  return tasks.length > 0 || unasked;
}

export interface FollowUpPassDeps {
  store: ScanStore;
  suggestions: () => StoredSuggestion[];
  /** Keeps a record in place of the one with the same key, or adds it. */
  put: (record: StoredSuggestion) => void;
  /**
   * Step 16 (round 2): the loop's state for a split question the AI has not answered (no live suggestion), kept in the agent's
   * review collection with the question's signature. Absent: such questions are left to the AI pass, as before.
   */
  questionState?: { get: (id: string) => { seen: string; state: FollowUpState } | undefined; put: (id: string, seen: string, state: FollowUpState) => void };
  /** A question's research tools (the Home Depot ones are Chrome jobs). */
  tools: () => ResearchTools;
  research: ResearchModel | null;
  /** Follow-up asks allowed: the owner's press, or `ai.reaskOnNewEvidence`. Otherwise only the free reads and the code's check. */
  allowAsk: boolean;
  chromeConnected: () => boolean;
  spentUsd: number;
  capUsd: number;
  signal: AbortSignal;
  now: () => number;
  /** Only these questions (the owner's press); default every open one the loop has not run for. */
  only?: readonly string[];
  /** Nov 23: counted for the scan's "Review cards" step (each question the loop runs for is one more item). */
  progress?: { add(n: number): void; item(ms: number | null): void };
  /** The brief of a follow-up answer, as the AI pass writes one (agent/brief.ts). */
  afterKeep?: (record: StoredSuggestion) => Promise<{ costUsd: number; problem: string | null }>;
}

export interface FollowUpPassResult {
  /** Questions the loop ran for. */
  ran: number;
  /** Questions verified by it (by the code's check again, or a follow-up answer). */
  verified: number;
  /** Follow-up asks made. */
  asked: number;
  costUsd: number;
  problem: string | null;
}

/** The doing line of a question queued while Chrome is closed (the loop runs for it in the next pass with Chrome open). */
export const WAITING_FOR_CHROME = 'Waiting for Chrome to read the Home Depot pages this needs';

/** One question the loop runs for, with where its state is kept: its live suggestion, or (none yet) the review collection. */
interface Due {
  item: ReviewItem;
  live: StoredSuggestion | null;
}

/**
 * The open split questions the loop runs for: unsettled live answers whose loop has not finished, and (round 2) questions the
 * AI has not answered whose free reads have not been made (or the ones asked for).
 */
async function due(d: FollowUpPassDeps): Promise<Due[]> {
  const out: Due[] = [];
  const records = d.suggestions();
  for (const item of (await d.store.listReview()).sort((a, b) => a.openedAt - b.openedAt)) {
    if (item.answer !== null || item.kind !== 'split') continue;
    if (d.only && !d.only.includes(item.id)) continue;
    const live = liveSuggestion(records, item) ?? null;
    let f: FollowUpState | undefined;
    if (live) {
      if (!unsettled(live) || !traceOf(live)) continue;
      f = live.followUp;
    } else {
      if (!d.questionState) continue;
      const q = d.questionState.get(item.id);
      f = q && q.seen === reviewSignature(item) ? q.state : undefined;
    }
    if (!d.only && f && (f.state === 'done' || f.state === 'gave_up')) continue;
    out.push({ item, live });
  }
  return out;
}

/** Runs the loop for the questions due, one after another. Never throws for one question's trouble. */
export async function followUpPass(d: FollowUpPassDeps): Promise<FollowUpPassResult> {
  const out: FollowUpPassResult = { ran: 0, verified: 0, asked: 0, costUsd: 0, problem: null };
  const todo = await due(d);
  if (todo.length === 0) return out;
  const current = (key: string): StoredSuggestion | undefined => d.suggestions().find((r) => r.key === key);
  const stateOf = (x: Due): FollowUpState | undefined => {
    if (x.live) return current(x.live.key)?.followUp;
    const q = d.questionState!.get(x.item.id);
    return q && q.seen === reviewSignature(x.item) ? q.state : undefined;
  };
  const setState = (x: Due, state: FollowUpState) => {
    if (x.live) {
      const r = current(x.live.key);
      if (r) d.put({ ...r, followUp: state });
    } else d.questionState!.put(x.item.id, reviewSignature(x.item), state);
  };
  const working = (f: FollowUpState | undefined): boolean => f !== undefined && (f.state === 'running' || f.state === 'queued');
  // Queued first, all of them, so the counts and the cards say at once that the app has them. With Chrome closed nothing can be
  // read: they stay queued, saying so, and the next pass with Chrome open runs them (no question waits on the owner meanwhile).
  const chrome = d.chromeConnected();
  for (const x of todo) {
    const f = stateOf(x);
    if (!chrome) setState(x, { ...(f ?? freshFollowUp(d.now())), state: 'queued', doing: WAITING_FOR_CHROME, updatedAt: d.now() });
    else if (!working(f) || f!.doing === WAITING_FOR_CHROME) {
      const { doing: _d, ...rest } = f ?? freshFollowUp(d.now());
      setState(x, { ...rest, state: 'queued', updatedAt: d.now() });
    }
  }
  if (!chrome) return { ...out, problem: 'Chrome is closed, so the app could not read the pages these questions need.' };
  const { catalog, kitItemIds } = await catalogOf(d.store);
  let spent = d.spentUsd;
  d.progress?.add(todo.length);
  for (const x of todo) {
    if (d.signal.aborted) {
      const f = stateOf(x);
      if (f && working(f)) setState(x, { ...f, state: 'gave_up', reason: 'Stopped before the follow-up began.', updatedAt: d.now() });
      d.progress?.item(null);
      continue;
    }
    // Read again before its turn: the owner may have answered it meanwhile.
    const item = await d.store.getReview(x.item.id);
    const rec = x.live ? current(x.live.key) : undefined;
    if (!item || item.answer !== null || reviewSignature(item) !== reviewSignature(x.item) || (x.live && (!rec || rec.seen !== reviewSignature(item)))) {
      const f = stateOf(x);
      if (f && working(f)) setState(x, { ...f, state: 'gave_up', reason: 'The question changed meanwhile.', updatedAt: d.now() });
      d.progress?.item(null);
      continue;
    }
    const model = d.research;
    const estimate = model ? estimatedQuestionCost('split', model.model) : null;
    // A follow-up ask needs an answer to follow up: a question the AI has not answered is the AI pass's to ask.
    const ask: FollowUpAsk | null = rec && d.allowAsk && model ? async (followUp, signal) => {
      const evidence = await gatherEvidence(d.store, item);
      const suggestion = await researchQuestion(item, evidence, d.tools(), model, { ...(signal ? { signal } : {}), catalog, followUp });
      return { suggestion, costUsd: researchRecord(item, suggestion, model.model, d.now()).costUsd };
    } : null;
    const s = rec?.suggestion;
    const prior = stateOf(x);
    out.ran += 1;
    const startedAt = d.now();
    const r = await runFollowUp({
      item, catalog, kitItemIds,
      start: rec && s
        ? { checked: { status: s.status, ...(s.status === 'unverified' && s.gaps ? { gaps: s.gaps } : {}) }, answer: answerOf(rec), trace: traceOf(rec) ?? null, ...(rec.lacks ? { lacks: rec.lacks } : {}) }
        : { checked: { status: 'not_asked' }, answer: null, trace: null },
      ...(prior ? { prior } : {}),
      tools: d.tools, ask, estimateUsd: estimate, spentUsd: spent, capUsd: d.capUsd, signal: d.signal, now: d.now,
      progress: (state) => setState(x, state),
    });
    spent += r.costUsd;
    out.costUsd += r.costUsd;
    out.asked += r.asks.length;
    d.progress?.item(r.asks.length > 0 ? d.now() - startedAt : null);
    if (!rec || !s) {
      setState(x, r.state);
      continue;
    }
    const base = current(rec.key) ?? rec;
    if (r.rechecked?.status === 'verified') {
      // (i) Verified by the code's check again, with no model call: kept as lever 1 keeps one (agent/reverify.ts).
      const suggestion = { questionId: s.questionId, seen: s.seen, provider: s.provider, model: s.model, promptVersion: s.promptVersion, ...(s.usage ? { usage: s.usage } : {}), ...r.rechecked, research: traceOf(rec) } as Suggestion;
      d.put({ ...base, suggestion, verifiedAfter: 'new_evidence', firstCheck: base.firstCheck ?? { status: 'unverified', reasons: s.status === 'unverified' ? s.reasons : [] }, recheckedAt: d.now(), followUp: r.state });
      out.verified += 1;
      continue;
    }
    d.put({ ...base, followUp: r.state });
    // (ii) Each follow-up ask is a suggestion of its own, the last one live; each names the record it asked again.
    let of = rec.key;
    for (const [i, a] of r.asks.entries()) {
      const record = researchRecord(item, a.suggestion, model!.model, d.now() + i);
      const after = await d.store.getReview(item.id);
      const still = after !== undefined && after.answer === null && reviewSignature(after) === record.seen;
      const kept: StoredSuggestion = {
        ...record, costUsd: a.costUsd, followUpOf: of, evidenceKey: a.evidenceKey, followUp: r.state,
        ...(still ? {} : { outcome: { answeredAt: d.now(), answer: after?.answer ?? '', agreed: null } }),
      };
      d.put(kept);
      of = kept.key;
      if (i === r.asks.length - 1 && still && kept.suggestion.status !== 'not_suggested') {
        if (kept.suggestion.status === 'verified') out.verified += 1;
        if (d.afterKeep) {
          const b = await d.afterKeep(kept);
          spent += b.costUsd;
          out.costUsd += b.costUsd;
          out.problem ??= b.problem;
        }
      }
    }
  }
  return out;
}

export type AskPlan =
  | { action: 'ask'; force: boolean }
  | { action: 'follow_up' }
  | { action: 'none'; reason: string; canForce?: true; costUsd?: number };

/**
 * What the owner's Ask AI press does for one open question (POST /api/review/:id/ask). Never "nothing" without a reason: no
 * suggestion yet → an ask; the app working on it already → says so; `force` → a fresh ask (its cost was shown), unless no
 * price is known or the cap would be passed; a split answer not settled with something left to read or to ask about → the
 * follow-up loop; otherwise the reason, with what Ask anyway would cost.
 */
export async function askPlan(input: {
  store: ScanStore; suggestions: readonly StoredSuggestion[]; item: ReviewItem; force: boolean;
  model: { ok: true; model: string } | { ok: false; error: string };
  spentUsd: number; capUsd: number; chromeConnected: boolean;
}): Promise<AskPlan> {
  const { item } = input;
  if (!input.model.ok) return { action: 'none', reason: input.model.error };
  if (item.kind === 'split' && !input.chromeConnected) return { action: 'none', reason: 'Chrome is closed: the app reads Home Depot through it. Open Chrome with the Split Finder helper, then ask again.' };
  const live = liveSuggestion(input.suggestions, item);
  if (working(live) && live!.followUp!.doing !== WAITING_FOR_CHROME) return { action: 'none', reason: 'The app is already working on this question.' };
  const estimate = estimatedQuestionCost(item.kind, input.model.model);
  const label = questionCostLabel(item.kind, input.model.model);
  const capped = estimate !== null && input.spentUsd + estimate > input.capUsd;
  const capReason = `This month's AI limit of $${input.capUsd.toFixed(2)} is reached.`;
  if (!live) return capped ? { action: 'none', reason: capReason } : { action: 'ask', force: false };
  if (input.force) {
    if (estimate === null) return { action: 'none', reason: `No price is known for ${input.model.model}, so the monthly AI limit could not hold.` };
    return capped ? { action: 'none', reason: capReason } : { action: 'ask', force: true };
  }
  if (item.kind === 'split' && unsettled(live) && traceOf(live)) {
    const { catalog, kitItemIds } = await catalogOf(input.store);
    if (hasWork(item, live, catalog, kitItemIds)) return { action: 'follow_up' };
  }
  const offer = estimate !== null && !capped ? { canForce: true as const, costUsd: estimate } : {};
  const ask = label !== null && !capped ? `; asking again would cost ${label}` : capped ? `; ${capReason.charAt(0).toLowerCase()}${capReason.slice(1, -1)}` : '';
  const what = live.suggestion.status === 'verified' ? "The AI's answer is already verified, and nothing new was read since" : 'Nothing new to read since the last answer';
  return { action: 'none', reason: `${what}${ask}.`, ...offer };
}
