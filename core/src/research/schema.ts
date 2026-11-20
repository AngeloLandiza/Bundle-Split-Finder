// The shape of the research answer, given to the model as the input schema of its submit_answer tool,
// and a reader that checks an answer against it without trusting the provider to have done so.
//
// Why a tool and not output_config.format: web search citations are always on, and the
// structured-outputs page says the API refuses citations together with output_config.format (400).
// A strict tool's input is held to its schema the same way, and the answer comes back as the input of
// one tool_use block. A plain-text JSON answer is read too (validated here), never trusted more.
//
// Inside what strict schemas accept: every object closed and every property required, a nullable field
// as anyOf with null, no numeric bounds (qty is checked by verify.ts). The quotes come first, then the
// parts and the reason, and the decision last, so the model quotes before it decides.

import type { ResearchAnswer, ResearchDecision, ResearchPart, ResearchQuote } from './types';

export const RESEARCH_DECISIONS: readonly ResearchDecision[] = ['parts', 'choose', 'none', 'cannot_tell'];

const QUOTE = {
  type: 'object',
  properties: { quote: { type: 'string' }, sourceId: { type: 'string' } },
  required: ['quote', 'sourceId'],
  additionalProperties: false,
} as const;

export const RESEARCH_ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    quotes: { type: 'array', items: QUOTE },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { model: { type: 'string' }, qty: { type: 'integer' }, quotes: { type: 'array', items: QUOTE } },
        required: ['model', 'qty', 'quotes'],
        additionalProperties: false,
      },
    },
    reason: { type: 'string' },
    decision: { type: 'string', enum: [...RESEARCH_DECISIONS] },
    choiceIndex: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
  },
  required: ['quotes', 'parts', 'reason', 'decision', 'choiceIndex'],
  additionalProperties: false,
} as const;

export type ParsedResearchAnswer = { ok: true; answer: ResearchAnswer } | { ok: false; problem: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readQuotes(v: unknown): ResearchQuote[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: ResearchQuote[] = [];
  for (const q of v) {
    if (!isRecord(q) || typeof q.quote !== 'string' || typeof q.sourceId !== 'string') return null;
    out.push({ quote: q.quote, sourceId: q.sourceId });
  }
  return out;
}

/**
 * Reads an answer (the submit_answer input, JSON text, or parsed JSON) as a ResearchAnswer. Anything
 * off the schema is a problem, named in a sentence. `parts` and `quotes` may be missing (read as
 * empty) and `choiceIndex` missing (read as null), as a plain-text answer may leave them out.
 */
export function parseResearchAnswer(answer: unknown): ParsedResearchAnswer {
  let value = answer;
  if (typeof answer === 'string') {
    // A text answer may wrap its JSON in a code fence; nothing else is stripped.
    const text = answer.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, problem: 'The answer is not valid JSON.' };
    }
  }
  if (!isRecord(value)) return { ok: false, problem: 'The answer is not a JSON object.' };
  const decision = typeof value.decision === 'string' ? value.decision.toLowerCase() : value.decision;
  if (!RESEARCH_DECISIONS.includes(decision as ResearchDecision)) return { ok: false, problem: 'The answer has no known decision.' };
  const quotes = readQuotes(value.quotes);
  if (quotes === null) return { ok: false, problem: 'The answer has quotes that are not a quote with its source.' };
  if (typeof value.reason !== 'string') return { ok: false, problem: 'The answer has no reason.' };
  const choiceIndex = value.choiceIndex ?? null;
  if (choiceIndex !== null && !(typeof choiceIndex === 'number' && Number.isInteger(choiceIndex))) {
    return { ok: false, problem: 'choiceIndex is not a whole number or null.' };
  }
  const rawParts = value.parts ?? [];
  if (!Array.isArray(rawParts)) return { ok: false, problem: 'parts is not a list.' };
  const parts: ResearchPart[] = [];
  for (const p of rawParts) {
    if (!isRecord(p) || typeof p.model !== 'string' || !(typeof p.qty === 'number' && Number.isInteger(p.qty))) {
      return { ok: false, problem: 'The answer has a part that is not a model with a whole-number quantity.' };
    }
    const pq = readQuotes(p.quotes);
    if (pq === null) return { ok: false, problem: `Part ${p.model.slice(0, 40)} has quotes that are not a quote with its source.` };
    parts.push({ model: p.model, qty: p.qty, quotes: pq });
  }
  return { ok: true, answer: { quotes, parts, reason: value.reason, decision: decision as ResearchDecision, choiceIndex } };
}
