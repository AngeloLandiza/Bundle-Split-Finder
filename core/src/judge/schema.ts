// The shape of a judge's answer, as a JSON schema any provider with structured outputs can take, and
// a reader that checks an answer against it without trusting the provider to have done so.
//
// Kept inside what Claude's structured outputs accept: every object closed
// (additionalProperties: false) with every property required; no oneOf, not, numeric or string
// bounds. Nullable fields are anyOf with null, never a type array. The evidence comes first and the
// verdict last, so the model quotes before it decides.

import { EVIDENCE_CLAIMS, type JudgeRaw } from './types';

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', enum: [...EVIDENCE_CLAIMS] },
          quote: { type: 'string' },
        },
        required: ['claim', 'quote'],
        additionalProperties: false,
      },
    },
    contentsMatch: nullable({ type: 'boolean' }),
    quantity: nullable({ type: 'integer' }),
    condition: nullable({ type: 'string', enum: ['new', 'other'] }),
    extras: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
    verdict: { type: 'string', enum: ['match', 'not_match', 'unsure'] },
  },
  required: ['evidence', 'contentsMatch', 'quantity', 'condition', 'extras', 'missing', 'reason', 'verdict'],
  additionalProperties: false,
} as const;

export type ParsedJudgeRaw = { ok: true; raw: JudgeRaw } | { ok: false; problem: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/**
 * Reads an answer (parsed JSON) as a JudgeRaw. Anything off the schema is a problem, named in a
 * sentence; keys the schema does not have are ignored.
 */
export function parseJudgeRaw(value: unknown): ParsedJudgeRaw {
  if (!isRecord(value)) return { ok: false, problem: 'The answer is not a JSON object.' };
  const { evidence, contentsMatch, quantity, condition, extras, missing, reason, verdict } = value;
  if (verdict !== 'match' && verdict !== 'not_match' && verdict !== 'unsure') {
    return { ok: false, problem: 'The answer has no known verdict.' };
  }
  if (!Array.isArray(evidence)) return { ok: false, problem: 'The answer has no evidence list.' };
  const quotes: JudgeRaw['evidence'] = [];
  for (const e of evidence) {
    if (!isRecord(e) || typeof e.quote !== 'string' || !EVIDENCE_CLAIMS.includes(e.claim as never)) {
      return { ok: false, problem: 'The answer has evidence that is not a known claim with a quote.' };
    }
    quotes.push({ claim: e.claim as JudgeRaw['evidence'][number]['claim'], quote: e.quote });
  }
  if (contentsMatch !== null && typeof contentsMatch !== 'boolean') {
    return { ok: false, problem: 'contentsMatch is not true, false or null.' };
  }
  if (quantity !== null && !(typeof quantity === 'number' && Number.isInteger(quantity) && quantity >= 0)) {
    return { ok: false, problem: 'quantity is not a whole number or null.' };
  }
  if (condition !== null && condition !== 'new' && condition !== 'other') {
    return { ok: false, problem: 'condition is not "new", "other" or null.' };
  }
  if (!isStringArray(extras)) return { ok: false, problem: 'extras is not a list of words.' };
  if (!isStringArray(missing)) return { ok: false, problem: 'missing is not a list of words.' };
  if (typeof reason !== 'string') return { ok: false, problem: 'The answer has no reason.' };
  return {
    ok: true,
    raw: { evidence: quotes, contentsMatch, quantity, condition, extras: [...extras], missing: [...missing], reason, verdict },
  };
}
