// The Claude adapter for the research agent: one Messages API request per turn of the loop, through
// the listing judge's transport (sendClaudeMessages): the key only in the x-api-key header to
// https://api.anthropic.com, no retries, typed failures. The loop (loop.ts) reads the stop reason and
// the content blocks; this file only builds the body and passes the response on.

import { type ClaudeEffort, sendClaudeMessages } from '../judge/claude';
import type { ResearchModel, ResearchRequest, ResearchTurn } from './types';

export const CLAUDE_RESEARCH_EFFORT: ClaudeEffort = 'low';

export interface ClaudeResearchOptions {
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
  effort?: ClaudeEffort;
}

export class ClaudeResearch implements ResearchModel {
  readonly provider = 'claude';
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch | undefined;
  private readonly effort: ClaudeEffort;

  constructor(opts: ClaudeResearchOptions) {
    if (!opts.apiKey) throw new Error('ClaudeResearch needs an Anthropic API key.');
    if (!opts.model) throw new Error('ClaudeResearch needs a model id.');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchFn = opts.fetchFn;
    this.effort = opts.effort ?? CLAUDE_RESEARCH_EFFORT;
  }

  /**
   * The body of one request. No output_config.format: the answer is the submit_answer tool's input (schema.ts).
   * Prompt caching (fix round 2; prompt caching guide: tools render before system, a breakpoint on the last
   * system block caches both; top-level cache_control places one more on the last block and moves it forward
   * as the conversation grows): the fixed prompt and tools are read from the cache by every question, and each
   * request of a question reads the conversation before it. Nothing in the prompt varies by time or request.
   */
  requestBody(request: ResearchRequest): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: request.maxTokens,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      tools: request.tools,
      messages: request.messages,
      cache_control: { type: 'ephemeral' },
      output_config: { effort: this.effort },
    };
  }

  async send(request: ResearchRequest, signal?: AbortSignal): Promise<ResearchTurn> {
    const sent = await sendClaudeMessages({
      apiKey: this.apiKey,
      body: this.requestBody(request),
      ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!sent.ok) return sent;
    return {
      ok: true, stopReason: sent.body.stop_reason, content: sent.body.content,
      usage: sent.usage ?? { inputTokens: 0, outputTokens: 0 },
      ...(sent.body.stop_details !== undefined ? { stopDetails: sent.body.stop_details } : {}),
    };
  }
}
