// The provider-neutral model layer (step 13, W6): one request and one response shape for every model
// the AI pipelines (listing judge, review assistant, research agent) may talk to. A provider turns a
// ModelRequest into one HTTP call and the answer back into a ModelResponse; nothing above this file
// knows which company answered. Claude (claude.ts) and the OpenAI-compatible Chat Completions API
// (openai.ts: DeepSeek and others) are the two providers.
//
// One call, no retries, never throws for a provider or network failure: it returns ok: false with a
// typed reason (the NotJudged reasons the pipelines already use). The key goes in a header to the
// provider's own address only; it is never in a URL, a message or a log.

import type { NotJudged, TokenUsage } from '../judge/types';

export type { NotJudged, NotJudgedReason, TokenUsage } from '../judge/types';

/** A function the model may call; the caller runs it and sends the result back. */
export interface ModelTool {
  name: string;
  description: string;
  /** JSON schema of the arguments. */
  inputSchema: Record<string, unknown>;
  /** Ask the provider to enforce the schema where it can (Claude strict tools). Others may ignore it: the caller checks the arguments anyway. */
  strict?: boolean;
}

export type ServerToolName = 'web_search' | 'web_fetch';

/** A tool the provider itself runs (Anthropic's web search and web fetch). A provider without it must not be sent it. */
export interface ServerToolSpec {
  name: ServerToolName;
  maxUses?: number;
  allowedDomains?: string[];
  maxContentTokens?: number;
}

export type ModelBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; content: string; isError?: boolean };

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string | ModelBlock[];
  /**
   * An assistant message's content as its provider gave it (ModelResponse.native), sent back unchanged to that provider: Claude's
   * server-tool and thinking blocks must be returned as they came. Other providers ignore it.
   */
  native?: unknown;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  /** Client tools. Sent with tool_choice "auto" where the provider has one. */
  tools?: ModelTool[];
  serverTools?: ServerToolSpec[];
  /**
   * A final answer with no tool loop (the judge, the assistant): a JSON schema, and the answer comes back as the response's text
   * (Claude: structured output; OpenAI-compatible: a forced "submit_answer" function call whose arguments are the text).
   */
  responseSchema?: Record<string, unknown>;
  maxTokens: number;
  /** Thinking depth. Only Claude has it; others ignore it. */
  effort?: 'low' | 'medium' | 'high';
  /** Cache the fixed prompt and the conversation so far where the provider can (Claude cache_control). Others cache by themselves. */
  cache?: boolean;
}

export type ModelStop =
  | 'end' // the model finished
  | 'tool_use' // it called tools and waits for their results
  | 'max_tokens' // the answer was cut off
  | 'refusal'
  | 'pause' // the provider paused its own server-tool loop: send the content back
  | 'other'; // see rawStop

export type ModelResponse =
  | {
    ok: true;
    /** Text and tool calls, in order. Provider-only blocks (server tools, thinking) are not here: they are in `native`. */
    content: ModelBlock[];
    stop: ModelStop;
    /** The provider's own stop reason. */
    rawStop: string;
    stopDetails?: unknown;
    usage: TokenUsage;
    native?: unknown[];
  }
  | { ok: false; notJudged: NotJudged; usage?: TokenUsage };

export interface ModelCapabilities {
  /** The server tools the provider runs itself. Empty: the research agent uses the Home Depot tools only. */
  serverTools: readonly ServerToolName[];
}

export interface ModelProvider {
  /** Who: "claude", "deepseek", "openai-compatible". Stored with every suggestion. */
  readonly id: string;
  /** How it is named in a sentence ("Claude", "DeepSeek"). */
  readonly label: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  send(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

/** A one-shot answer: the answer text, or why there is none. The judge's and the assistant's calls end here. */
export type ModelAnswer = { ok: true; answer: string; usage: TokenUsage } | { ok: false; notJudged: NotJudged; usage?: TokenUsage };
