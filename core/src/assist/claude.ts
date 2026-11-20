// The Claude adapter for the review assistant: one Messages API call per question, through the same
// transport as the listing judge (callClaudeMessages): the key only in the x-api-key header to
// https://api.anthropic.com, no retries, typed failures. The model is the one Settings chose for the judge.

import { callClaudeMessages, type ClaudeEffort } from '../judge/claude';
import type { AssistCallResult, AssistModel, AssistRequest } from './types';

/** Room for the answer and the model's thinking. Running out is "not suggested", never an answer. */
export const CLAUDE_ASSIST_MAX_TOKENS = 2000;
export const CLAUDE_ASSIST_EFFORT: ClaudeEffort = 'low';

export interface ClaudeAssistOptions {
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
  maxTokens?: number;
  effort?: ClaudeEffort;
}

export class ClaudeAssist implements AssistModel {
  readonly provider = 'claude';
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch | undefined;
  private readonly maxTokens: number;
  private readonly effort: ClaudeEffort;

  constructor(opts: ClaudeAssistOptions) {
    if (!opts.apiKey) throw new Error('ClaudeAssist needs an Anthropic API key.');
    if (!opts.model) throw new Error('ClaudeAssist needs a model id.');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchFn = opts.fetchFn;
    this.maxTokens = opts.maxTokens ?? CLAUDE_ASSIST_MAX_TOKENS;
    this.effort = opts.effort ?? CLAUDE_ASSIST_EFFORT;
  }

  /** The request body for one question. */
  requestBody(request: AssistRequest): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      output_config: { effort: this.effort, format: { type: 'json_schema', schema: request.schema } },
    };
  }

  ask(request: AssistRequest, signal?: AbortSignal): Promise<AssistCallResult> {
    return callClaudeMessages({
      apiKey: this.apiKey,
      body: this.requestBody(request),
      ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
      ...(signal ? { signal } : {}),
      declined: 'Claude declined to suggest an answer.',
    });
  }
}
