// An OpenAI-compatible Chat Completions provider: DeepSeek and any other service that speaks
// POST {baseUrl}/chat/completions with `tools` (function calling). One call, no retries, plain fetch,
// typed failures.
//
// The key is sent in the Authorization header to the configured address only. It is never put in a
// URL, a message or a log, and an address that would send it in the clear (http, other than this
// computer) is refused. The fetch error's own text and the provider's own message (cut short, the key
// removed should it ever be echoed) are the only text that comes back from the network.
//
// A final answer with no tool loop (ModelRequest.responseSchema) is a forced "submit_answer" function
// call, the same device research already uses with Claude: its arguments are the answer text.

import type { ModelBlock, ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelStop, NotJudged, TokenUsage } from './types';

/** The function a one-shot answer is given through. */
export const SUBMIT_ANSWER_TOOL = 'submit_answer';

export interface OpenAICompatibleOptions {
  /** e.g. https://api.deepseek.com or https://api.openai.com/v1; "/chat/completions" is added. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** "deepseek": stored with every suggestion. */
  id?: string;
  /** "DeepSeek": how a message names it. */
  label?: string;
  /** Fields merged into every request body, for what a service needs beyond the standard ones (DeepSeek: thinking off). */
  extraBody?: Record<string, unknown>;
  fetchFn?: typeof fetch;
}

/** The presets Settings offers. A preset is a starting point: the model and the address stay editable. */
export const OPENAI_COMPATIBLE_PRESETS = {
  /**
   * DeepSeek (https://api-docs.deepseek.com, read Nov 22, 2026): models `deepseek-flash` and `deepseek-v4-pro`; thinking is ON by
   * default, and then a forced tool_choice is a 400 and every earlier turn's reasoning_content must be sent back in a tool loop, so
   * the preset turns thinking off ({"thinking":{"type":"disabled"}}).
   */
  deepseek: { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', extraBody: { thinking: { type: 'disabled' } } },
  /** Any other OpenAI-compatible service: the owner gives the address and the model. */
  generic: { id: 'openai-compatible', label: 'The model', baseUrl: '', model: '', extraBody: {} },
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Whether an address may carry the key: https, or http to this computer (a local model server). */
function keySafe(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}

function chatMessages(system: string, messages: ModelMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.filter((b): b is Extract<ModelBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content.filter((b): b is Extract<ModelBlock, { type: 'tool_call' }> => b.type === 'tool_call');
      out.push({
        role: 'assistant',
        content: text === '' ? null : text,
        ...(calls.length > 0 ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
      });
      continue;
    }
    // A user message: each tool result is a message of its own (role "tool"); any plain text follows as the user's.
    for (const b of m.content) {
      if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.callId, content: b.isError ? `Error: ${b.content}` : b.content });
    }
    const text = m.content.filter((b): b is Extract<ModelBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n');
    if (text !== '') out.push({ role: 'user', content: text });
  }
  return out;
}

const FINISH: Record<string, ModelStop> = { stop: 'end', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

/**
 * Tokens as ModelUsage keeps them: inputTokens is the UNCACHED input (as Claude's input_tokens is), cache hits are apart, so one cost
 * formula serves both. DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens; OpenAI and others: prompt_tokens_details.cached_tokens.
 */
export function readChatUsage(u: unknown): TokenUsage | undefined {
  if (!isRecord(u)) return undefined;
  const prompt = num(u.prompt_tokens) ?? 0;
  const details = isRecord(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  const hit = num(u.prompt_cache_hit_tokens) ?? num(details.prompt_cache_hit_tokens) ?? num(details.cached_tokens);
  const miss = num(u.prompt_cache_miss_tokens) ?? num(details.prompt_cache_miss_tokens);
  const usage: TokenUsage = {
    inputTokens: miss ?? (hit !== undefined ? Math.max(0, prompt - hit) : prompt),
    outputTokens: num(u.completion_tokens) ?? 0,
  };
  if (hit !== undefined) usage.cacheReadInputTokens = hit;
  return usage;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly capabilities = { serverTools: [] } as const;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly extraBody: Record<string, unknown>;
  private readonly fetchFn: typeof fetch | undefined;

  constructor(opts: OpenAICompatibleOptions) {
    if (!opts.apiKey) throw new Error('An OpenAI-compatible provider needs an API key.');
    if (!opts.model) throw new Error('An OpenAI-compatible provider needs a model id.');
    let base: URL;
    try {
      base = new URL(opts.baseUrl);
    } catch {
      throw new Error('The model service address is not a web address.');
    }
    if (!keySafe(base)) throw new Error('The model service address must be https (or http on this computer): the key is never sent in the clear.');
    if (base.username || base.password || base.search || base.hash) throw new Error('The model service address must not hold a user, a password or a query.');
    this.url = `${base.origin}${base.pathname.replace(/\/+$/, '')}/chat/completions`;
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.id = opts.id ?? 'openai-compatible';
    this.label = opts.label ?? 'The model';
    this.extraBody = opts.extraBody ?? {};
    this.fetchFn = opts.fetchFn;
  }

  /** The request body for one call. */
  requestBody(req: ModelRequest): Record<string, unknown> {
    const tools = (req.tools ?? []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    let choice: unknown;
    if (req.responseSchema) {
      tools.push({
        type: 'function',
        function: { name: SUBMIT_ANSWER_TOOL, description: 'Gives your answer. Call it once; its arguments are the answer.', parameters: req.responseSchema },
      });
      choice = tools.length === 1 ? { type: 'function', function: { name: SUBMIT_ANSWER_TOOL } } : 'auto';
    } else if (tools.length > 0) choice = 'auto';
    return {
      ...this.extraBody,
      model: this.model,
      max_tokens: req.maxTokens,
      messages: chatMessages(req.system, req.messages),
      ...(tools.length > 0 ? { tools, tool_choice: choice } : {}),
    };
  }

  async send(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const fail = (notJudged: NotJudged, usage?: TokenUsage): ModelResponse => ({ ok: false, notJudged, ...(usage ? { usage } : {}) });
    if ((req.serverTools ?? []).length > 0) {
      return fail({ reason: 'bad_request', message: `${this.label} has no server tools (web search); the request asked for one.` });
    }
    // Called through a wrapper: a bare `fetch` stored on an object throws "Illegal invocation".
    const fetchFn = this.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    let res: Response;
    try {
      res = await fetchFn(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(this.requestBody(req)),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      // The fetch error's own text is not passed on: it is not ours to show and could hold anything.
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) return fail({ reason: 'aborted', message: `The call to ${this.label} was cancelled.` });
      return fail({ reason: 'network', message: `${this.label} could not be reached.` });
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (!res.ok) return fail(this.httpFailure(res, body));

    const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
    const finish = isRecord(choice) ? choice.finish_reason : undefined;
    if (!message || typeof finish !== 'string') return fail({ reason: 'bad_response', message: `${this.label} answered with something that is not a chat completion.` });
    const usage = readChatUsage((body as Record<string, unknown>).usage) ?? { inputTokens: 0, outputTokens: 0 };

    const content: ModelBlock[] = [];
    if (typeof message.content === 'string' && message.content.trim() !== '') content.push({ type: 'text', text: message.content });
    let submitted: string | undefined;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
    for (const c of calls) {
      const fn = isRecord(c.function) ? c.function : {};
      const name = typeof fn.name === 'string' ? fn.name : '';
      const args = typeof fn.arguments === 'string' ? fn.arguments : '';
      if (req.responseSchema && name === SUBMIT_ANSWER_TOOL) {
        submitted = args;
        continue;
      }
      let input: unknown;
      try {
        input = args.trim() === '' ? {} : JSON.parse(args);
      } catch {
        return fail({ reason: 'bad_response', message: `${this.label} called ${name.slice(0, 40) || 'a tool'} with arguments that are not JSON.` }, usage);
      }
      if (!isRecord(input) || name === '') return fail({ reason: 'bad_response', message: `${this.label} made a tool call that is not readable.` }, usage);
      content.push({ type: 'tool_call', id: typeof c.id === 'string' ? c.id : `call_${content.length}`, name, input });
    }

    if (submitted !== undefined) {
      // The answer text is the submit call's arguments; any plain text beside it is not the answer.
      return { ok: true, content: [{ type: 'text', text: submitted }], stop: 'end', rawStop: finish, usage };
    }
    const refused = typeof message.refusal === 'string' && message.refusal.trim() !== '';
    if (finish === 'insufficient_system_resource') return fail({ reason: 'server', message: `${this.label} stopped for lack of system resources.` }, usage);
    let stop: ModelStop = refused ? 'refusal' : (FINISH[finish] ?? 'other');
    if (stop === 'end' && content.some((b) => b.type === 'tool_call')) stop = 'tool_use';
    return { ok: true, content, stop, rawStop: finish, ...(refused ? { stopDetails: { category: 'refusal' } } : {}), usage };
  }

  private httpFailure(res: Response, body: unknown): NotJudged {
    const status = res.status;
    const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    const type = typeof error?.type === 'string' ? error.type : undefined;
    // The service's own message, cut short and with the key removed should it ever be echoed.
    const said = typeof error?.message === 'string' ? error.message.split(this.apiKey).join('[key]').slice(0, 200) : '';
    const detail = [type, said].filter(Boolean).join(': ');
    const tail = detail ? ` (${detail})` : '';
    const who = this.label;
    if (status === 401 || status === 403) return { reason: 'auth', status, message: `${who} refused the API key (HTTP ${status}).${tail}` };
    // DeepSeek's 402: the account has no balance. A key problem to the owner: nothing will work until it is topped up.
    if (status === 402) return { reason: 'auth', status, message: `${who} says the account has insufficient balance (HTTP 402).${tail}` };
    if (status === 429) {
      const after = Number(res.headers.get('retry-after'));
      return {
        reason: 'rate_limited', status, message: `${who}'s rate limit was reached (HTTP 429).${tail}`,
        ...(Number.isFinite(after) && after > 0 ? { retryAfterSeconds: after } : {}),
      };
    }
    // 503 is "server overloaded" for DeepSeek and OpenAI alike; 529 is Anthropic's, and some gateways pass it on.
    if (status === 503 || status === 529) return { reason: 'overloaded', status, message: `${who} is overloaded (HTTP ${status}).${tail}` };
    if (status >= 500) return { reason: 'server', status, message: `${who} answered with a server error (HTTP ${status}).${tail}` };
    if (status === 400 || status === 413 || status === 422) return { reason: 'bad_request', status, message: `${who} refused the request (HTTP ${status}).${tail}` };
    return { reason: 'http', status, message: `${who} answered with HTTP ${status}.${tail}` };
  }
}
