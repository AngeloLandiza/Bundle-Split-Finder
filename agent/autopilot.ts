// Autopilot (step 13, Decision 5): the agent applies an AI suggestion to a Review question without the owner, but
// only when code has verified it (rule 4: evidence checked by code, never a model's word). Every application goes
// through the owner's own path (core/src/scan/answers.ts applyReviewAnswer), is recorded with what changed, and can be
// undone (reopenReviewAnswer). Pure decisions here; the agent's store is written by the caller.
//
// The rules, in order:
//   1. The question is open, and a split question: Undo can reopen only a split answer (match answers decide a
//      listing for the part and its twins, which no code path takes back), so match questions stay with the owner.
//   2. The owner has not undone Autopilot on this question before.
//   3. The suggestion is the latest made for the question as it reads now (liveSuggestion's signature).
//   4. Its status is `verified`: every quote found word for word in the source it names, and the answer one the
//      question offers (assist) or parts the pages read name (research). Never unverified, cannot_tell,
//      none_suggested or not_suggested.
//   5. The model that made it is the pipeline's model in Settings and marked `trusted` (measured by the evals).
//   6. approvalOf gives an answer the question takes (the same check Approve uses).
//   7. Step 16: it is not the answer of a follow-up ask (agent/followUp.ts) while FOLLOW_UP_ASKS_MEASURED is false: the
//      loop's asks pass the same verifier, and they wait for the owner until research:eval --follow-up measures them.

import type { AiAgentSettings, AiPipelineSetting } from '../core/src/api/contract';
import { OPENAI_COMPATIBLE_PRESETS } from '../core/src/ai/openai';
import { approvalOf } from '../core/src/assist/approve';
import type { StoredSuggestion } from '../core/src/assist/stored';
import { AnswerRefused, applyReviewAnswer, reopenReviewAnswer, reviewSignature } from '../core/src/scan/answers';
import type { ReviewAnswer, ReviewItem, ScanStore } from '../core/src/scan/types';

/**
 * The one list of models Autopilot trusts without the owner saying so: the exact Anthropic models a real eval run
 * measured for that pipeline (docs/decisions.md, step 10 to 12). Research and assist: only Opus 5.5 (Haiku 5.5 gave
 * verified "none" answers the key disagrees with on the assist runs; research was only run on Opus). The judge's flag
 * is not read by Autopilot; both judge models were measured on the 217 labelled listings. Add a model here only after
 * `assist:eval` / `research:eval` were run against it.
 */
export const MEASURED_MODELS: Readonly<Record<'judge' | 'assist' | 'research', readonly string[]>> = {
  judge: ['claude-haiku-5-5', 'claude-opus-5-5'],
  assist: ['claude-opus-5-5'],
  research: ['claude-opus-5-5'],
};

/** Whether a pipeline's model is trusted by default: Anthropic's own API and a model on the measured list. */
export function measuredByDefault(pipeline: 'judge' | 'assist' | 'research', s: Pick<AiPipelineSetting, 'provider' | 'model' | 'baseUrl'>): boolean {
  return s.provider === 'anthropic' && !s.baseUrl && MEASURED_MODELS[pipeline].includes(s.model);
}

/** What identifies the model a pipeline runs: when any of it changes, trust goes back to the default. */
export function modelIdentity(s: AiPipelineSetting): string {
  return JSON.stringify([s.provider, s.model, s.baseUrl ?? null, s.preset ?? null, s.id ?? null]);
}

/** Step 16: whether follow-up asks were measured at zero wrong on the answer key (docs/decisions.md). Not yet. */
export const FOLLOW_UP_ASKS_MEASURED = false;

export type AutopilotDecision =
  | { apply: true; answer: ReviewAnswer; applied: string; verifiedBy: string[]; pipeline: 'assist' | 'research' }
  | { apply: false; reason: string };

/** The provider id a pipeline's setting gives its suggestions (ClaudeProvider 'claude'; a preset's id; the setting's own). */
export function providerIdOf(s: AiPipelineSetting): string {
  if (s.provider === 'anthropic') return 'claude';
  return s.id ?? OPENAI_COMPATIBLE_PRESETS[s.preset ?? 'generic'].id;
}

export function autopilotDecision(item: ReviewItem, stored: StoredSuggestion | undefined, ai: AiAgentSettings, undoneBefore: boolean): AutopilotDecision {
  const no = (reason: string): AutopilotDecision => ({ apply: false, reason });
  if (item.answer !== null) return no('The question is answered.');
  if (item.kind !== 'split') return no('Autopilot answers split questions only; a match answer stays with you.');
  if (undoneBefore) return no('You undid Autopilot on this question, so it stays with you.');
  if (!stored) return no('No AI suggestion yet.');
  const s = stored.suggestion;
  if (stored.seen !== reviewSignature(item) || s.seen !== stored.seen) return no('The question changed since the AI was asked.');
  if (stored.outcome !== undefined) return no('The suggestion was used already.');
  if (s.status !== 'verified') return no(`The suggestion is ${s.status.replace('_', ' ')}, not verified.`);
  const pipeline = 'research' in s ? 'research' : 'assist';
  const setting = ai[pipeline];
  if (providerIdOf(setting) !== s.provider || setting.model !== s.model) return no(`The suggestion came from ${s.model}, which is not the ${pipeline} model in Settings.`);
  if (!setting.trusted) return no(`${s.model} is not measured yet, so its suggestions wait for you.`);
  if (stored.followUpOf !== undefined && !FOLLOW_UP_ASKS_MEASURED) return no('It came from asking the AI again with what the app read, which is not measured yet, so it waits for you.');
  const answer = approvalOf(s, item);
  if (!answer) return no('The suggestion is not an answer this question takes.');
  const parts = s.answer.decision === 'none' ? [] : s.answer.kind === 'split' ? s.answer.parts : [];
  const sources = [...new Set(s.quotes.map((q) => `"${q.quote}" in ${q.label}${q.url ? ` (${q.url})` : ''}`))].slice(0, 4);
  return {
    apply: true,
    answer,
    pipeline,
    applied: `${item.model} contains ${parts.join(', ')}`,
    verifiedBy: [
      `Every quote was found word for word in the source it names (${s.quotes.length})`,
      s.answer.decision === 'parts' ? 'Every part is named on a page the research read' : 'The reading is one the question offered',
      `${s.model} is marked measured in Settings`,
      ...sources,
    ],
  };
}

/** Applies the decision as the owner's answer would be; returns what Undo needs. Throws AnswerRefused as an answer would. */
export async function applyAutopilot(store: ScanStore, item: ReviewItem, d: Extract<AutopilotDecision, { apply: true }>, now: number): Promise<{ answer: string; answeredAt: number }> {
  await applyReviewAnswer(store, item.id, d.answer, now);
  const after = await store.getReview(item.id);
  return { answer: after?.answer ?? '', answeredAt: after?.answeredAt ?? now };
}

/** Reopens the question Autopilot answered. Refused when the owner (or a later scan) changed the answer since. */
export async function undoAutopilot(store: ScanStore, entry: { questionId: string; answer: string; answeredAt: number }, now: number): Promise<void> {
  const item = await store.getReview(entry.questionId);
  if (!item) throw new AnswerRefused('That question was not found.');
  if (item.answer !== entry.answer || item.answeredAt !== entry.answeredAt) {
    throw new AnswerRefused('The answer changed since Autopilot applied it; change it in Review instead.');
  }
  await reopenReviewAnswer(store, entry.questionId, now);
}
