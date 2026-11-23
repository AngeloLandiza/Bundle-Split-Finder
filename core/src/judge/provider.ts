// The listing judge on any ModelProvider (step 13, W6): one call per listing, the answer read through the
// neutral layer's stop handling. ClaudeJudge (claude.ts) stays for callers that want the Claude-only path;
// this is the one the agent uses, so a cheaper OpenAI-compatible model is a setting, not code.

import { answerFrom } from '../ai/answer';
import type { ModelProvider } from '../ai/types';
import { CLAUDE_JUDGE_EFFORT, CLAUDE_JUDGE_MAX_TOKENS, type ClaudeEffort } from './claude';
import { JUDGE_PROMPT, PROMPT_VERSION, renderJudgeInput } from './prompt';
import { JUDGE_SCHEMA } from './schema';
import type { JudgeCall, JudgeInput, ListingJudge } from './types';

export interface ProviderJudgeOptions {
  provider: ModelProvider;
  maxTokens?: number;
  /** Only Claude reads it. */
  effort?: ClaudeEffort;
}

export class ProviderJudge implements ListingJudge {
  readonly id: string;
  readonly model: string;
  private readonly provider: ModelProvider;
  private readonly maxTokens: number;
  private readonly effort: ClaudeEffort;

  constructor(opts: ProviderJudgeOptions) {
    this.provider = opts.provider;
    this.id = opts.provider.id;
    this.model = opts.provider.model;
    this.maxTokens = opts.maxTokens ?? CLAUDE_JUDGE_MAX_TOKENS;
    this.effort = opts.effort ?? CLAUDE_JUDGE_EFFORT;
  }

  async judge(input: JudgeInput, signal?: AbortSignal): Promise<JudgeCall> {
    const res = await this.provider.send(
      {
        system: JUDGE_PROMPT,
        messages: [{ role: 'user', content: renderJudgeInput(input) }],
        responseSchema: JUDGE_SCHEMA,
        maxTokens: this.maxTokens,
        effort: this.effort,
      },
      signal,
    );
    const result = answerFrom(res, this.provider.label, `${this.provider.label} declined to judge this listing.`);
    return { judgeId: this.id, model: this.model, promptVersion: PROMPT_VERSION, ...result };
  }
}
