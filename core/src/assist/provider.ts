// The review assistant on any ModelProvider (step 13, W6): one call per question, the answer read through the
// neutral layer's stop handling. ClaudeAssist (claude.ts) stays for callers that want the Claude-only path.

import { answerFrom } from '../ai/answer';
import type { ModelProvider } from '../ai/types';
import type { ClaudeEffort } from '../judge/claude';
import { CLAUDE_ASSIST_EFFORT, CLAUDE_ASSIST_MAX_TOKENS } from './claude';
import type { AssistCallResult, AssistModel, AssistRequest } from './types';

export interface ProviderAssistOptions {
  provider: ModelProvider;
  maxTokens?: number;
  /** Only Claude reads it. */
  effort?: ClaudeEffort;
}

export class ProviderAssist implements AssistModel {
  readonly provider: string;
  readonly model: string;
  private readonly backend: ModelProvider;
  private readonly maxTokens: number;
  private readonly effort: ClaudeEffort;

  constructor(opts: ProviderAssistOptions) {
    this.backend = opts.provider;
    this.provider = opts.provider.id;
    this.model = opts.provider.model;
    this.maxTokens = opts.maxTokens ?? CLAUDE_ASSIST_MAX_TOKENS;
    this.effort = opts.effort ?? CLAUDE_ASSIST_EFFORT;
  }

  async ask(request: AssistRequest, signal?: AbortSignal): Promise<AssistCallResult> {
    const res = await this.backend.send(
      {
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
        responseSchema: request.schema,
        maxTokens: this.maxTokens,
        effort: this.effort,
      },
      signal,
    );
    return answerFrom(res, this.backend.label, `${this.backend.label} declined to suggest an answer.`);
  }
}
