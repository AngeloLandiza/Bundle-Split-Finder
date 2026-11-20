// The shape of the review assistant's answer, as a JSON schema any provider with structured outputs
// can take, and a reader that checks an answer against it without trusting the provider to have done so.
//
// Kept inside what Claude's structured outputs accept, as the listing judge's schema is: every object
// closed with every property required, nullable fields as anyOf with null, no bounds. One schema for
// both kinds of question (choiceIndex for a split, asin for a match), so it never changes per call.
// The evidence comes first and the decision after it, so the model quotes before it decides.

import type { AssistDecision, AssistRaw } from './types';

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

export const ASSIST_DECISIONS: readonly AssistDecision[] = ['choose', 'none', 'cannot_tell'];

export const ASSIST_SCHEMA = {
  type: 'object',
  properties: {
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string' },
          source: { type: 'string' },
        },
        required: ['quote', 'source'],
        additionalProperties: false,
      },
    },
    reason: { type: 'string' },
    decision: { type: 'string', enum: [...ASSIST_DECISIONS] },
    choiceIndex: nullable({ type: 'integer' }),
    asin: nullable({ type: 'string' }),
  },
  required: ['evidence', 'reason', 'decision', 'choiceIndex', 'asin'],
  additionalProperties: false,
} as const;

export type ParsedAssistRaw = { ok: true; raw: AssistRaw } | { ok: false; problem: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads an answer (its JSON text, or parsed JSON) as an AssistRaw. Anything off the schema is a problem, named in a sentence. */
export function parseAssistRaw(answer: unknown): ParsedAssistRaw {
  let value = answer;
  if (typeof answer === 'string') {
    try {
      value = JSON.parse(answer);
    } catch {
      return { ok: false, problem: 'The answer is not valid JSON.' };
    }
  }
  if (!isRecord(value)) return { ok: false, problem: 'The answer is not a JSON object.' };
  const { evidence, reason, decision, choiceIndex, asin } = value;
  if (!ASSIST_DECISIONS.includes(decision as AssistDecision)) return { ok: false, problem: 'The answer has no known decision.' };
  if (!Array.isArray(evidence)) return { ok: false, problem: 'The answer has no evidence list.' };
  const quotes: AssistRaw['evidence'] = [];
  for (const e of evidence) {
    if (!isRecord(e) || typeof e.quote !== 'string' || typeof e.source !== 'string') {
      return { ok: false, problem: 'The answer has evidence that is not a quote with its source.' };
    }
    quotes.push({ quote: e.quote, source: e.source });
  }
  if (typeof reason !== 'string') return { ok: false, problem: 'The answer has no reason.' };
  if (choiceIndex !== null && !(typeof choiceIndex === 'number' && Number.isInteger(choiceIndex))) {
    return { ok: false, problem: 'choiceIndex is not a whole number or null.' };
  }
  if (asin !== null && typeof asin !== 'string') return { ok: false, problem: 'asin is not text or null.' };
  return { ok: true, raw: { evidence: quotes, reason, decision: decision as AssistDecision, choiceIndex, asin } };
}
