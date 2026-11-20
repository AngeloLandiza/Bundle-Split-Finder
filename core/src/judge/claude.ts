// The Claude adapter for the listing judge: one Messages API call per listing, with plain fetch (the
// documented path from a browser; the SDK in an MV3 service worker is not documented). No retries:
// a failed call is "not judged" and the scan goes on without it.
//
// The key is sent in the x-api-key header to https://api.anthropic.com only. It is never put in a
// URL, a message or a log; the address is fixed so no option can send it anywhere else.
//
// The call itself (callClaudeMessages) is shared with the review assistant (core/src/assist/): one
// transport, one set of typed failures, whatever the prompt.

import { JUDGE_PROMPT, PROMPT_VERSION, renderJudgeInput } from './prompt';
import { JUDGE_SCHEMA } from './schema';
import type { JudgeCall, JudgeInput, ListingJudge, NotJudged, TokenUsage } from './types';

export const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

/** The models Settings offers. The eval (Task 4) decides between them. */
export const CLAUDE_JUDGE_MODELS = ['claude-haiku-5-5', 'claude-opus-5-5'] as const;
/** Settings' starting choice: the cheapest. */
export const DEFAULT_CLAUDE_JUDGE_MODEL = 'claude-haiku-5-5';

/**
 * Room for the answer and the model's thinking, which counts against max_tokens and cannot be
 * turned off on these models. Running out is "not judged", never a verdict.
 */
export const CLAUDE_JUDGE_MAX_TOKENS = 2000;

/**
 * Thinking depth. Low keeps the thinking inside CLAUDE_JUDGE_MAX_TOKENS; the eval can raise both.
 * (No thinking budget and no temperature: both are refused by these models.)
 */
export type ClaudeEffort = 'low' | 'medium' | 'high';
export const CLAUDE_JUDGE_EFFORT: ClaudeEffort = 'low';

export interface ClaudeJudgeOptions {
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
  maxTokens?: number;
  effort?: ClaudeEffort;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function readUsage(body: Record<string, unknown>): TokenUsage | undefined {
  const u = body.usage;
  if (!isRecord(u)) return undefined;
  const usage: TokenUsage = { inputTokens: num(u.input_tokens) ?? 0, outputTokens: num(u.output_tokens) ?? 0 };
  const read = num(u.cache_read_input_tokens);
  const created = num(u.cache_creation_input_tokens);
  if (read !== undefined) usage.cacheReadInputTokens = read;
  if (created !== undefined) usage.cacheCreationInputTokens = created;
  // Server tools (step 12, research): the web searches this response ran, billed apart from tokens.
  const searches = isRecord(u.server_tool_use) ? num(u.server_tool_use.web_search_requests) : undefined;
  if (searches !== undefined) usage.webSearchRequests = searches;
  const fetches = isRecord(u.server_tool_use) ? num(u.server_tool_use.web_fetch_requests) : undefined;
  if (fetches !== undefined) usage.webFetchRequests = fetches;
  return usage;
}

/** One Messages API call's result, before the caller adds who answered: the answer text, or why there is none. */
export type ClaudeMessagesResult = { ok: true; answer: string; usage: TokenUsage } | { ok: false; notJudged: NotJudged; usage?: TokenUsage };

export interface ClaudeMessagesRequest {
  apiKey: string;
  /** The request body, as the Messages API takes it. */
  body: Record<string, unknown>;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  /** The sentence for a refusal, naming what was declined. */
  declined?: string;
}

/** A Messages API response, read only as far as the transport needs: the rest is the caller's. */
export interface ClaudeMessageBody {
  stop_reason: string;
  content: unknown[];
  [field: string]: unknown;
}

/**
 * One Messages API call's whole response (step 12: the research loop reads the content blocks
 * itself), with its usage when the response gave one, or why there is no response.
 */
export type ClaudeRawResult = { ok: true; body: ClaudeMessageBody; usage?: TokenUsage } | { ok: false; notJudged: NotJudged };

/**
 * One call to the Messages API, returning the response as it came: HTTP, network and shape failures
 * are typed; the stop reason is left to the caller. No retries; never throws for a provider or
 * network failure. callClaudeMessages is this plus the judge's reading of the stop reason.
 */
export async function sendClaudeMessages(req: ClaudeMessagesRequest): Promise<ClaudeRawResult> {
  const { apiKey, signal } = req;
  // Called through a wrapper: a bare `fetch` stored on an object throws "Illegal invocation".
  const fetchFn = req.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const fail = (notJudged: NotJudged): ClaudeRawResult => ({ ok: false, notJudged });

  let res: Response;
  try {
    res = await fetchFn(CLAUDE_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(req.body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    // The fetch error's own text is not passed on: it is not ours to show and could hold anything.
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return fail({ reason: 'aborted', message: 'The call to Claude was cancelled.' });
    }
    return fail({ reason: 'network', message: 'Claude could not be reached.' });
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  if (!res.ok) return fail(httpFailure(res, body, apiKey));

  if (!isRecord(body) || typeof body.stop_reason !== 'string' || !Array.isArray(body.content)) {
    return fail({ reason: 'bad_response', message: 'Claude answered with something that is not a message.' });
  }
  const usage = readUsage(body);
  return { ok: true, body: body as ClaudeMessageBody, ...(usage ? { usage } : {}) };
}

/**
 * Why a response's stop reason gives no answer, for the stops every caller reads alike (a refusal, an
 * answer cut off); null for any other stop, which the caller reads.
 */
export function stopFailure(body: ClaudeMessageBody, declined?: string): NotJudged | null {
  const stop = body.stop_reason;
  if (stop === 'refusal') {
    const details = body.stop_details;
    const category = isRecord(details) && typeof details.category === 'string' ? details.category : undefined;
    return { reason: 'refusal', message: declined ?? 'Claude declined to answer.', ...(category ? { refusalCategory: category } : {}) };
  }
  if (stop === 'max_tokens') return { reason: 'max_tokens', message: 'Claude’s answer was cut off before it finished.' };
  return null;
}

/**
 * One call to the Messages API. No retries. Never throws for a provider or network failure: it
 * returns ok: false with a typed reason.
 */
export async function callClaudeMessages(req: ClaudeMessagesRequest): Promise<ClaudeMessagesResult> {
  const sent = await sendClaudeMessages(req);
  if (!sent.ok) return sent;
  const { body, usage } = sent;
  const fail = (notJudged: NotJudged): ClaudeMessagesResult => ({ ok: false, notJudged, ...(usage ? { usage } : {}) });
  const stopped = stopFailure(body, req.declined);
  if (stopped) return fail(stopped);
  const stop = body.stop_reason;
  if (stop !== 'end_turn') {
    return fail({ reason: 'unexpected_stop', message: `Claude stopped for an unexpected reason (${stop.slice(0, 40)}).` });
  }
  const text = body.content.find((b): b is { type: 'text'; text: string } => isRecord(b) && b.type === 'text' && typeof b.text === 'string');
  if (!text) return fail({ reason: 'no_answer', message: 'Claude’s answer had no text.' });
  return { ok: true, answer: text.text, usage: usage ?? { inputTokens: 0, outputTokens: 0 } };
}

function httpFailure(res: Response, body: unknown, apiKey: string): NotJudged {
  const status = res.status;
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const type = typeof error?.type === 'string' ? error.type : undefined;
  // The API's own message, cut short and with the key removed should it ever be echoed.
  const said = typeof error?.message === 'string' ? error.message.split(apiKey).join('[key]').slice(0, 200) : '';
  const detail = [type, said].filter(Boolean).join(': ');
  const tail = detail ? ` (${detail})` : '';
  if (status === 401 || status === 403) {
    return { reason: 'auth', status, message: `Claude refused the API key (HTTP ${status}).${tail}` };
  }
  if (status === 429) {
    const after = Number(res.headers.get('retry-after'));
    return {
      reason: 'rate_limited',
      status,
      message: `Claude's rate limit was reached (HTTP 429).${tail}`,
      ...(Number.isFinite(after) && after > 0 ? { retryAfterSeconds: after } : {}),
    };
  }
  if (status === 529) return { reason: 'overloaded', status, message: `Claude is overloaded (HTTP 529).${tail}` };
  if (status >= 500) return { reason: 'server', status, message: `Claude answered with a server error (HTTP ${status}).${tail}` };
  if (status === 400) return { reason: 'bad_request', status, message: `Claude refused the request (HTTP 400).${tail}` };
  return { reason: 'http', status, message: `Claude answered with HTTP ${status}.${tail}` };
}

export class ClaudeJudge implements ListingJudge {
  readonly id = 'claude';
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch | undefined;
  private readonly maxTokens: number;
  private readonly effort: ClaudeEffort;

  constructor(opts: ClaudeJudgeOptions) {
    if (!opts.apiKey) throw new Error('ClaudeJudge needs an Anthropic API key.');
    if (!opts.model) throw new Error('ClaudeJudge needs a model id.');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchFn = opts.fetchFn;
    this.maxTokens = opts.maxTokens ?? CLAUDE_JUDGE_MAX_TOKENS;
    this.effort = opts.effort ?? CLAUDE_JUDGE_EFFORT;
  }

  /** The request body for one listing. */
  requestBody(input: JudgeInput): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      system: JUDGE_PROMPT,
      messages: [{ role: 'user', content: renderJudgeInput(input) }],
      output_config: { effort: this.effort, format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
    };
  }

  async judge(input: JudgeInput, signal?: AbortSignal): Promise<JudgeCall> {
    const result = await callClaudeMessages({
      apiKey: this.apiKey,
      body: this.requestBody(input),
      ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
      ...(signal ? { signal } : {}),
      declined: 'Claude declined to judge this listing.',
    });
    return { judgeId: this.id, model: this.model, promptVersion: PROMPT_VERSION, ...result };
  }
}
