// providerFrom / pipelinesFrom: Settings to models. No network: nothing here sends a request.

import { afterEach, describe, expect, it } from 'vitest';
import { type AiSettings, type PipelineAiSettings, pipelinesFrom, providerFrom } from '../src/ai/factory';
import { PRICE_TABLE } from '../src/judge/eval';

const KEYS: Record<string, string> = { 'key:anthropic': 'sk-ant-test-1', 'key:deepseek': 'sk-ds-test-2' };
const deps = { resolveKey: (ref: string) => KEYS[ref] };

const claude: PipelineAiSettings = { provider: 'anthropic', model: 'claude-haiku-5-5', apiKeyRef: 'key:anthropic' };
const deepseek: PipelineAiSettings = { provider: 'openai-compatible', preset: 'deepseek', model: 'deepseek-flash', apiKeyRef: 'key:deepseek' };

afterEach(() => {
  delete PRICE_TABLE['acme-chat'];
});

describe('providerFrom', () => {
  it('builds Claude from an anthropic setting', () => {
    const r = providerFrom(claude, deps);
    expect(r).toMatchObject({ ok: true, provider: { id: 'claude', model: 'claude-haiku-5-5', capabilities: { serverTools: ['web_search', 'web_fetch'] } } });
  });

  it('builds DeepSeek from its preset, with no server tools', () => {
    const r = providerFrom(deepseek, deps);
    expect(r).toMatchObject({ ok: true, provider: { id: 'deepseek', label: 'DeepSeek', model: 'deepseek-flash', capabilities: { serverTools: [] } } });
  });

  it('a generic OpenAI-compatible setting needs an address, and takes its own id and label', () => {
    const s: PipelineAiSettings = { provider: 'openai-compatible', model: 'gpt-x', apiKeyRef: 'key:deepseek' };
    expect(providerFrom(s, deps)).toEqual({ ok: false, error: 'Give the address of the model service.' });
    expect(providerFrom({ ...s, baseUrl: 'https://llm.example.com/v1', id: 'acme', label: 'Acme' }, deps)).toMatchObject({ ok: true, provider: { id: 'acme', label: 'Acme' } });
  });

  it('says why there is no provider, in a sentence that holds no key', () => {
    expect(providerFrom({ ...claude, apiKeyRef: 'key:missing' }, deps)).toEqual({ ok: false, error: 'There is no API key saved for this model.' });
    expect(providerFrom({ ...claude, model: ' ' }, deps)).toEqual({ ok: false, error: 'Choose a model.' });
    const insecure = providerFrom({ provider: 'openai-compatible', baseUrl: 'http://llm.example.com', model: 'm', apiKeyRef: 'key:deepseek' }, deps);
    expect(insecure).toMatchObject({ ok: false });
    expect(JSON.stringify(insecure)).not.toContain('sk-ds-test-2');
    expect(providerFrom({ ...claude, provider: 'mystery' as never }, deps)).toMatchObject({ ok: false });
  });

  it('registers the rates a setting carries, so costs and estimates follow', () => {
    providerFrom({ ...deepseek, model: 'acme-chat', rates: { input: 1, output: 2, cacheRead: 0.1 } }, deps);
    expect(PRICE_TABLE['acme-chat']).toEqual({ input: 1, output: 2, cacheRead: 0.1 });
  });
});

describe('pipelinesFrom', () => {
  const ai: AiSettings = { judge: deepseek, assist: claude, research: deepseek };

  it('gives each pipeline its own model: ids and models follow the setting', () => {
    const p = pipelinesFrom(ai, deps);
    expect(p.judge).toMatchObject({ ok: true, value: { id: 'deepseek', model: 'deepseek-flash' } });
    expect(p.assist).toMatchObject({ ok: true, value: { provider: 'claude', model: 'claude-haiku-5-5' } });
    expect(p.research).toMatchObject({ ok: true, value: { provider: 'deepseek', webTools: false } });
  });

  it('research on Claude keeps the web tools', () => {
    expect(pipelinesFrom({ ...ai, research: claude }, deps).research).toMatchObject({ ok: true, value: { provider: 'claude', webTools: true } });
  });

  it('one pipeline without a key does not take the others down', () => {
    const p = pipelinesFrom({ ...ai, judge: { ...deepseek, apiKeyRef: 'key:missing' } }, deps);
    expect(p.judge).toEqual({ ok: false, error: 'There is no API key saved for this model.' });
    expect(p.assist.ok && p.research.ok).toBe(true);
  });
});
