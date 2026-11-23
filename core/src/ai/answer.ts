// What a provider-neutral response is worth to a one-shot caller (the judge, the assistant): the same reading of the stop reason
// the Claude-only callClaudeMessages has, for any provider.

import type { ModelAnswer, ModelResponse, NotJudged } from './types';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why a stop gives no answer, for the stops every caller reads alike (a refusal, an answer cut off); null for any other. */
export function stopFailureOf(res: Extract<ModelResponse, { ok: true }>, label: string, declined?: string): NotJudged | null {
  if (res.stop === 'refusal') {
    const category = isRecord(res.stopDetails) && typeof res.stopDetails.category === 'string' ? res.stopDetails.category : undefined;
    return { reason: 'refusal', message: declined ?? `${label} declined to answer.`, ...(category ? { refusalCategory: category } : {}) };
  }
  if (res.stop === 'max_tokens') return { reason: 'max_tokens', message: `${label}’s answer was cut off before it finished.` };
  return null;
}

/** The first text block of a finished response; anything else is a typed failure, never a guess. */
export function answerFrom(res: ModelResponse, label: string, declined?: string): ModelAnswer {
  if (!res.ok) return res;
  const fail = (notJudged: NotJudged): ModelAnswer => ({ ok: false, notJudged, usage: res.usage });
  const stopped = stopFailureOf(res, label, declined);
  if (stopped) return fail(stopped);
  if (res.stop !== 'end') return fail({ reason: 'unexpected_stop', message: `${label} stopped for an unexpected reason (${res.rawStop.slice(0, 40)}).` });
  const text = res.content.find((b): b is { type: 'text'; text: string } => b.type === 'text');
  if (!text) return fail({ reason: 'no_answer', message: `${label}’s answer had no text.` });
  return { ok: true, answer: text.text, usage: res.usage };
}
