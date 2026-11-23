// Claude as a ModelProvider: the neutral request becomes one Messages API body and the response is
// read back, through the transport the listing judge already has (sendClaudeMessages: the key only in
// the x-api-key header to https://api.anthropic.com, no retries, typed failures). Claude is the only
// provider with server tools (web search and web fetch) and the only one that takes `effort`.

import { sendClaudeMessages } from '../judge/claude';
import type { ModelBlock, ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelStop, ModelTool, ServerToolSpec } from './types';

/** The web search server tool's type: the version with dynamic filtering, called directly. */
export const WEB_SEARCH_TOOL_TYPE = 'web_search_20260209';
/** The web fetch server tool's type: the same generation as web search, called directly. */
export const WEB_FETCH_TOOL_TYPE = 'web_fetch_20260209';

export interface ClaudeProviderOptions {
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function claudeTool(t: ModelTool): Record<string, unknown> {
  return { name: t.name, description: t.description, ...(t.strict ? { strict: true } : {}), input_schema: t.inputSchema };
}

function claudeServerTool(t: ServerToolSpec): Record<string, unknown> {
  // Called directly, not from code execution: its results then come back as plain result blocks the caller can read, and max_uses
  // counts every use (dynamic filtering would hide both).
  return {
    type: t.name === 'web_search' ? WEB_SEARCH_TOOL_TYPE : WEB_FETCH_TOOL_TYPE,
    name: t.name,
    ...(t.maxUses !== undefined ? { max_uses: t.maxUses } : {}),
    ...(t.allowedDomains ? { allowed_domains: t.allowedDomains } : {}),
    ...(t.maxContentTokens !== undefined ? { max_content_tokens: t.maxContentTokens } : {}),
    allowed_callers: ['direct'],
  };
}

function claudeBlock(b: ModelBlock): Record<string, unknown> {
  if (b.type === 'text') return { type: 'text', text: b.text };
  if (b.type === 'tool_call') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
  return { type: 'tool_result', tool_use_id: b.callId, content: b.content, ...(b.isError ? { is_error: true } : {}) };
}

function claudeMessage(m: ModelMessage): { role: string; content: unknown } {
  if (m.role === 'assistant' && m.native !== undefined) return { role: m.role, content: m.native };
  return { role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(claudeBlock) };
}

const STOPS: Record<string, ModelStop> = { end_turn: 'end', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal', pause_turn: 'pause' };

export class ClaudeProvider implements ModelProvider {
  readonly id = 'claude';
  readonly label = 'Claude';
  readonly model: string;
  readonly capabilities = { serverTools: ['web_search', 'web_fetch'] } as const;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch | undefined;

  constructor(opts: ClaudeProviderOptions) {
    if (!opts.apiKey) throw new Error('ClaudeProvider needs an Anthropic API key.');
    if (!opts.model) throw new Error('ClaudeProvider needs a model id.');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchFn = opts.fetchFn;
  }

  /** The request body for one call. Prompt caching follows research's: a breakpoint on the last system block (tools render before it) and top-level cache_control for the growing conversation. */
  requestBody(req: ModelRequest): Record<string, unknown> {
    const tools = [...(req.tools ?? []).map(claudeTool), ...(req.serverTools ?? []).map(claudeServerTool)];
    const output = {
      ...(req.effort ? { effort: req.effort } : {}),
      ...(req.responseSchema ? { format: { type: 'json_schema', schema: req.responseSchema } } : {}),
    };
    return {
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.cache ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }] : req.system,
      ...(tools.length > 0 ? { tools } : {}),
      messages: req.messages.map(claudeMessage),
      ...(req.cache ? { cache_control: { type: 'ephemeral' } } : {}),
      ...(Object.keys(output).length > 0 ? { output_config: output } : {}),
    };
  }

  async send(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const sent = await sendClaudeMessages({
      apiKey: this.apiKey,
      body: this.requestBody(req),
      ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!sent.ok) return sent;
    const { body } = sent;
    const content: ModelBlock[] = [];
    for (const b of body.content.filter(isRecord)) {
      if (b.type === 'text' && typeof b.text === 'string') content.push({ type: 'text', text: b.text });
      if (b.type === 'tool_use') {
        content.push({ type: 'tool_call', id: String(b.id), name: String(b.name), input: isRecord(b.input) ? b.input : {} });
      }
    }
    return {
      ok: true,
      content,
      stop: STOPS[body.stop_reason] ?? 'other',
      rawStop: body.stop_reason,
      ...(body.stop_details !== undefined ? { stopDetails: body.stop_details } : {}),
      usage: sent.usage ?? { inputTokens: 0, outputTokens: 0 },
      native: body.content,
    };
  }
}
