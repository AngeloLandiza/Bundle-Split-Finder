// The research agent on any ModelProvider (step 13, W6). The loop (loop.ts) speaks in Messages-API-shaped
// content blocks (text, tool_use, tool_result: the shape the recorded runs and the tests are written in);
// this adapter turns each request into the neutral ModelRequest and each response back into those blocks.
// A provider that returns `native` blocks (Claude: server-tool and thinking blocks) has them passed through
// unchanged both ways, so Claude behaves exactly as ClaudeResearch does; any other provider's text and tool
// calls become text and tool_use blocks.
//
// A provider with no server tools (an OpenAI-compatible one) gets the Home Depot tools and the answer
// tool only: the loop reads `webTools: false` and sends the prompt that says so.

import type { ModelBlock, ModelMessage, ModelProvider, ModelResponse, ModelStop, ModelTool, ServerToolName, ServerToolSpec } from '../ai/types';
import type { ClaudeEffort } from '../judge/claude';
import type { ResearchModel, ResearchRequest, ResearchTurn } from './types';

export const RESEARCH_EFFORT: ClaudeEffort = 'low';

export interface ProviderResearchOptions {
  provider: ModelProvider;
  /** Only Claude reads it. */
  effort?: ClaudeEffort;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function serverToolOf(t: Record<string, unknown>): ServerToolSpec | null {
  const type = typeof t.type === 'string' ? t.type : '';
  const name: ServerToolName | null = type.startsWith('web_search') ? 'web_search' : type.startsWith('web_fetch') ? 'web_fetch' : null;
  if (!name) return null;
  return {
    name,
    ...(typeof t.max_uses === 'number' ? { maxUses: t.max_uses } : {}),
    ...(Array.isArray(t.allowed_domains) ? { allowedDomains: t.allowed_domains.map(String) } : {}),
    ...(typeof t.max_content_tokens === 'number' ? { maxContentTokens: t.max_content_tokens } : {}),
  };
}

/** The loop's blocks as neutral blocks. Blocks the neutral layer has no word for (server tools, thinking) are dropped: they travel in `native`. */
function blocksOf(content: unknown): ModelBlock[] | string {
  if (typeof content === 'string') return content;
  const out: ModelBlock[] = [];
  for (const b of Array.isArray(content) ? content.filter(isRecord) : []) {
    if (b.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') out.push({ type: 'tool_call', id: String(b.id), name: String(b.name), input: isRecord(b.input) ? b.input : {} });
    else if (b.type === 'tool_result') {
      out.push({ type: 'tool_result', callId: String(b.tool_use_id), content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content), ...(b.is_error === true ? { isError: true } : {}) });
    }
  }
  return out;
}

const STOP_NAMES: Record<ModelStop, string | null> = { end: 'end_turn', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal', pause: 'pause_turn', other: null };

export class ProviderResearch implements ResearchModel {
  readonly provider: string;
  readonly model: string;
  readonly label: string;
  readonly webTools: boolean;
  private readonly backend: ModelProvider;
  private readonly effort: ClaudeEffort;

  constructor(opts: ProviderResearchOptions) {
    this.backend = opts.provider;
    this.provider = opts.provider.id;
    this.model = opts.provider.model;
    this.label = opts.provider.label;
    this.webTools = opts.provider.capabilities.serverTools.length > 0;
    this.effort = opts.effort ?? RESEARCH_EFFORT;
  }

  async send(request: ResearchRequest, signal?: AbortSignal): Promise<ResearchTurn> {
    const supported = this.backend.capabilities.serverTools;
    const tools: ModelTool[] = [];
    const serverTools: ServerToolSpec[] = [];
    for (const t of request.tools) {
      const server = serverToolOf(t);
      if (server) {
        if (supported.includes(server.name)) serverTools.push(server);
      } else if (typeof t.name === 'string' && isRecord(t.input_schema)) {
        tools.push({ name: t.name, description: typeof t.description === 'string' ? t.description : '', inputSchema: t.input_schema, ...(t.strict === true ? { strict: true } : {}) });
      }
    }
    const messages: ModelMessage[] = request.messages.map((m) => ({
      role: m.role,
      content: blocksOf(m.content),
      ...(m.role === 'assistant' && Array.isArray(m.content) ? { native: m.content } : {}),
    }));
    const res: ModelResponse = await this.backend.send(
      { system: request.system, messages, tools, ...(serverTools.length > 0 ? { serverTools } : {}), maxTokens: request.maxTokens, effort: this.effort, cache: true },
      signal,
    );
    if (!res.ok) return res;
    // A provider that has its own blocks gets them back unchanged; others' text and calls are written as Messages-API blocks.
    const content: unknown[] = res.native ?? res.content.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_call') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      return { type: 'tool_result', tool_use_id: b.callId, content: b.content };
    });
    return {
      ok: true, stopReason: STOP_NAMES[res.stop] ?? res.rawStop, content, usage: res.usage,
      ...(res.stopDetails !== undefined ? { stopDetails: res.stopDetails } : {}),
    };
  }
}
