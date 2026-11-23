// Settings to models (step 13, W6): which provider and model each AI pipeline (listing judge, review
// assistant, research agent) uses, and the one place that turns that choice into a ModelProvider. The agent
// (Wave 2) calls providerFrom / pipelinesFrom with the owner's Settings and a way to read a key by its
// reference; this file never sees where keys are kept and never stores one.

import { ProviderAssist } from '../assist/provider';
import type { AssistModel } from '../assist/types';
import { type PriceRates, setModelRates } from '../judge/eval';
import { ProviderJudge } from '../judge/provider';
import type { ListingJudge } from '../judge/types';
import { ProviderResearch } from '../research/provider';
import type { ResearchModel } from '../research/types';
import { ClaudeProvider } from './claude';
import { OPENAI_COMPATIBLE_PRESETS, OpenAICompatibleProvider } from './openai';
import type { ModelProvider } from './types';

export type ProviderKind = 'anthropic' | 'openai-compatible';

/** One pipeline's choice, as Settings stores it. `apiKeyRef` names a key the agent holds; it is not the key. */
export interface PipelineAiSettings {
  provider: ProviderKind;
  /** openai-compatible only: the service address ("https://api.deepseek.com"). Omitted: the preset's. */
  baseUrl?: string;
  model: string;
  apiKeyRef: string;
  /** openai-compatible only: a preset to start from (its address, labels and extra request fields). */
  preset?: keyof typeof OPENAI_COMPATIBLE_PRESETS;
  /** openai-compatible only: the id and the name this model goes by in stored suggestions and messages. */
  id?: string;
  label?: string;
  /** Dollars per million tokens for a model whose price this build does not know, or one that changed. Optional. */
  rates?: PriceRates;
}

/** The three pipelines, each with its own choice. */
export interface AiSettings {
  judge: PipelineAiSettings;
  assist: PipelineAiSettings;
  research: PipelineAiSettings;
}

export interface ProviderDeps {
  /** The key a reference names, or undefined when there is none. */
  resolveKey(ref: string): string | undefined;
  fetchFn?: typeof fetch;
}

export type ProviderResult = { ok: true; provider: ModelProvider } | { ok: false; error: string };

/**
 * A provider for one pipeline's settings, or why there is none (a sentence for the owner, never holding a key). Never throws.
 * When the settings carry `rates`, they are registered for the model (setModelRates), so every cost and estimate follows.
 */
export function providerFrom(settings: PipelineAiSettings, deps: ProviderDeps): ProviderResult {
  if (!settings.model.trim()) return { ok: false, error: 'Choose a model.' };
  const apiKey = deps.resolveKey(settings.apiKeyRef);
  if (!apiKey) return { ok: false, error: 'There is no API key saved for this model.' };
  const fetchFn = deps.fetchFn ? { fetchFn: deps.fetchFn } : {};
  try {
    let provider: ModelProvider;
    if (settings.provider === 'anthropic') {
      provider = new ClaudeProvider({ apiKey, model: settings.model, ...fetchFn });
    } else if (settings.provider === 'openai-compatible') {
      const preset = OPENAI_COMPATIBLE_PRESETS[settings.preset ?? 'generic'];
      const baseUrl = settings.baseUrl?.trim() || preset.baseUrl;
      if (!baseUrl) return { ok: false, error: 'Give the address of the model service.' };
      provider = new OpenAICompatibleProvider({
        baseUrl, apiKey, model: settings.model,
        id: settings.id ?? preset.id, label: settings.label ?? preset.label, extraBody: { ...preset.extraBody }, ...fetchFn,
      });
    } else {
      return { ok: false, error: 'That kind of model service is not one this version knows.' };
    }
    if (settings.rates) setModelRates(settings.model, settings.rates);
    return { ok: true, provider };
  } catch (err) {
    // The constructors' own sentences (an address that is not https, ...): ours, and they never hold the key.
    return { ok: false, error: err instanceof Error ? err.message : 'The model could not be set up.' };
  }
}

export type PipelineResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Pipelines {
  judge: PipelineResult<ListingJudge>;
  assist: PipelineResult<AssistModel>;
  research: PipelineResult<ResearchModel>;
}

/** The three pipelines' models for the owner's Settings. A pipeline with no usable provider says why; the others still work. */
export function pipelinesFrom(ai: AiSettings, deps: ProviderDeps): Pipelines {
  const build = <T>(s: PipelineAiSettings, make: (p: ModelProvider) => T): PipelineResult<T> => {
    const r = providerFrom(s, deps);
    return r.ok ? { ok: true, value: make(r.provider) } : { ok: false, error: r.error };
  };
  return {
    judge: build(ai.judge, (provider) => new ProviderJudge({ provider })),
    assist: build(ai.assist, (provider) => new ProviderAssist({ provider })),
    research: build(ai.research, (provider) => new ProviderResearch({ provider })),
  };
}
