// The brief pipeline: one small model call per question that has a suggestion, on any ModelProvider (Opus by default,
// DeepSeek or another later), then the code's check of what came back (ground.ts). One call, no retries. A call that gives
// nothing usable, a model that is not set up, or a brief with no sentence that survives leaves the owner the rules brief:
// the pipeline never throws and never changes the suggestion it explains.

import { answerFrom } from '../ai/answer';
import type { ModelProvider } from '../ai/types';
import { costOf, PRICE_TABLE } from '../judge/eval';
import type { ClaudeEffort } from '../judge/claude';
import type { NotJudged, TokenUsage } from '../judge/types';
import { groundBrief, type RawBrief } from './ground';
import { BRIEF_PROMPT_VERSION, briefRequest, type BriefRequest } from './prompt';
import { rulesBrief } from './rules';
import type { BriefInput, BriefVerdict, ReviewBrief } from './types';

/**
 * The model a fresh install writes briefs with. The card is what the owner reads, so it is the model that wrote it best, measured
 * on his 15 real questions (npm run brief:eval --data scan2, Nov 23 2026), same prompt, no retries:
 *   claude-haiku-5-5  $0.00518 in all; 12 of 15 briefs passed the checks; 17 of 57 sentences dropped; wordy suggestions
 *                     ("PCL1201K2 kit + P20015BTL part, as the two parts that make up this bundle"); one check line invented a
 *                     fact ("confirm P553 is the battery or charger" on a title that says Miter Saw).
 *   claude-opus-5-5   $0.1768 (about 1.2 cents a question); 15 of 15 passed; 3 of 70 sentences dropped; suggestions named each
 *                     part ("PCL1600K2 kit + P553 miter saw"); checks specific and correct.
 * Settings can point the brief at a cheaper model (ai.brief), and the prompt and checks are tightened for it (BRIEF_PROMPT_VERSION).
 */
export const DEFAULT_BRIEF_MODEL = 'claude-opus-5-5';
/** Room for the answer and the model's thinking; running out is "no brief", never a half brief. */
export const BRIEF_MAX_TOKENS = 1500;
export const BRIEF_EFFORT: ClaudeEffort = 'low';
/** What one brief costs, as a typical question: the instructions about 420 tokens, the question and up to six quotes up to 1,100, the answer a few hundred with its thinking. */
export const ESTIMATED_BRIEF_TOKENS = { input: 1500, output: 500 } as const;

export type BriefCallResult = { ok: true; answer: string; usage: TokenUsage } | { ok: false; notJudged: NotJudged; usage?: TokenUsage };

/** A model that writes briefs. One call, no retries; never throws for a provider or network failure. */
export interface BriefModel {
  readonly provider: string;
  readonly model: string;
  ask(request: BriefRequest, signal?: AbortSignal): Promise<BriefCallResult>;
}

export class ProviderBrief implements BriefModel {
  readonly provider: string;
  readonly model: string;
  private readonly backend: ModelProvider;

  constructor(opts: { provider: ModelProvider }) {
    this.backend = opts.provider;
    this.provider = opts.provider.id;
    this.model = opts.provider.model;
  }

  async ask(request: BriefRequest, signal?: AbortSignal): Promise<BriefCallResult> {
    const res = await this.backend.send(
      { system: request.system, messages: [{ role: 'user', content: request.user }], responseSchema: request.schema, maxTokens: BRIEF_MAX_TOKENS, effort: BRIEF_EFFORT },
      signal,
    );
    return answerFrom(res, this.backend.label, `${this.backend.label} declined to write the brief.`);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type ParsedBrief = { ok: true; raw: RawBrief } | { ok: false; problem: string };

/** Reads an answer (JSON text or parsed JSON) as a RawBrief. A sentence off the shape is dropped by the caller; anything else is a problem. */
export function parseBriefRaw(answer: unknown): ParsedBrief {
  let value = answer;
  if (typeof answer === 'string') {
    try {
      value = JSON.parse(answer);
    } catch {
      return { ok: false, problem: 'The brief is not valid JSON.' };
    }
  }
  if (!isRecord(value)) return { ok: false, problem: 'The brief is not a JSON object.' };
  if (!Array.isArray(value.reasons)) return { ok: false, problem: 'The brief has no reasons list.' };
  const reasons: RawBrief['reasons'] = [];
  for (const r of value.reasons) {
    if (isRecord(r) && typeof r.text === 'string' && typeof r.quoteIndex === 'number') reasons.push({ text: r.text, quoteIndex: r.quoteIndex });
  }
  const c = value.check;
  const check = isRecord(c) && typeof c.text === 'string' ? { text: c.text, quoteIndex: typeof c.quoteIndex === 'number' ? c.quoteIndex : null } : null;
  return { ok: true, raw: { suggestion: typeof value.suggestion === 'string' ? value.suggestion : null, reasons, check } };
}

/** Dollars one call cost at the model's published rates; null for a model with no rate or a call with no usage. */
export function briefCost(model: string, usage: TokenUsage | undefined): number | null {
  const rates = PRICE_TABLE[model];
  return rates && usage ? costOf(usage, rates) : null;
}

/** Dollars one brief may cost on `model` (a typical question); null for a model with no published rate. */
export function estimatedBriefCost(model: string): number | null {
  const rates = PRICE_TABLE[model];
  return rates ? costOf({ inputTokens: ESTIMATED_BRIEF_TOKENS.input, outputTokens: ESTIMATED_BRIEF_TOKENS.output }, rates) : null;
}

/** Whether a question's input is worth a call: a suggestion exists and the code found at least one quote for it. */
export const worthABrief = (input: BriefInput): boolean => input.state !== 'none' && input.quotes.length > 0;

/** What one brief attempt left: the brief the owner sees, and everything the eval and the ledger need. */
export interface BriefOutcome {
  brief: ReviewBrief;
  /** A model call was made (and cost something, even when nothing came of it). */
  called: boolean;
  usage?: TokenUsage;
  costUsd: number | null;
  verdicts: BriefVerdict[];
  /** Why there is no model brief, in one sentence; absent when the model's brief is the one shown. */
  fellBack?: string;
  provider?: string;
  model?: string;
  promptVersion: string;
}

/** Writes the brief of one question. Never throws. */
export async function writeBrief(input: BriefInput, model: BriefModel, signal?: AbortSignal): Promise<BriefOutcome> {
  const rules = rulesBrief(input);
  const base = { promptVersion: BRIEF_PROMPT_VERSION, provider: model.provider, model: model.model };
  if (!worthABrief(input)) {
    return { ...base, brief: rules, called: false, costUsd: null, verdicts: [], fellBack: input.state === 'none' ? 'There is no suggestion to explain.' : 'No quote of the suggestion was found on its page.' };
  }
  let result: BriefCallResult;
  try {
    result = await model.ask(briefRequest(input), signal);
  } catch (err) {
    return { ...base, brief: rules, called: false, costUsd: null, verdicts: [], fellBack: err instanceof Error ? err.message : 'The call failed.' };
  }
  const costUsd = briefCost(model.model, result.usage);
  const called = result.usage !== undefined;
  if (!result.ok) return { ...base, brief: rules, called, ...(result.usage ? { usage: result.usage } : {}), costUsd, verdicts: [], fellBack: result.notJudged.message };
  const parsed = parseBriefRaw(result.answer);
  if (!parsed.ok) return { ...base, brief: rules, called: true, usage: result.usage, costUsd, verdicts: [], fellBack: parsed.problem };
  const grounded = groundBrief(parsed.raw, input);
  return {
    ...base, brief: grounded.brief, called: true, usage: result.usage, costUsd, verdicts: grounded.verdicts,
    ...(grounded.usable ? {} : { fellBack: 'No sentence of the brief passed the checks.' }),
  };
}
