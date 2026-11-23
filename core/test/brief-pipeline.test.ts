import { describe, expect, it } from 'vitest';

import { pipelinesFrom } from '../src/ai/factory';
import type { ModelProvider, ModelRequest, ModelResponse } from '../src/ai/types';
import { BRIEF_PROMPT_VERSION, BRIEF_SCHEMA } from '../src/brief/prompt';
import { briefCost, estimatedBriefCost, parseBriefRaw, ProviderBrief, writeBrief } from '../src/brief/pipeline';
import { rulesBrief } from '../src/brief/rules';
import { realInput, suggestionFor } from './brief-world';

// The brief pipeline with a fake provider: no network, and the cost it counts is the call's usage at the model's published rates.

const SIX = 'split:homedepot:321809549';
const input = realInput(SIX);
const batteries = input.quotes.findIndex((q) => q.text.includes('(2) PBP003')) + 1;

const GOOD = JSON.stringify({
  suggestion: 'PCL1600K2 6-tool kit + PBP2003 battery pack',
  reasons: [{ text: 'The page lists (2) PBP003 2.0 Ah batteries.', quoteIndex: batteries }],
  check: { text: 'Read the Includes list on the Home Depot page.', quoteIndex: null },
});

function fake(reply: (req: ModelRequest) => ModelResponse): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    id: 'fake', label: 'Fake', model: 'claude-haiku-5-5', capabilities: { serverTools: [] }, requests,
    async send(req) {
      requests.push(req);
      return reply(req);
    },
  };
}

const answer = (text: string, usage = { inputTokens: 1200, outputTokens: 200 }): ModelResponse =>
  ({ ok: true, content: [{ type: 'text', text }], stop: 'end', rawStop: 'end_turn', usage });

describe('the brief pipeline', () => {
  it('one call: the question, the schema and the found quotes only; a good answer is the brief, with the cost of its usage', async () => {
    const provider = fake(() => answer(GOOD));
    const out = await writeBrief(input, new ProviderBrief({ provider }));
    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0]!;
    expect(req.responseSchema).toBe(BRIEF_SCHEMA);
    expect(req.messages).toHaveLength(1);
    expect(req.tools).toBeUndefined();
    expect(req.serverTools).toBeUndefined();
    expect(String(req.messages[0]!.content)).toContain('<quote n="1" source="Home Depot page"');
    expect(out.called).toBe(true);
    expect(out.brief.writtenBy).toBe('ai');
    expect(out.brief.reasons).toHaveLength(1);
    expect(out.promptVersion).toBe(BRIEF_PROMPT_VERSION);
    // (1200 x $0.10 + 200 x $0.50) per million tokens.
    expect(out.costUsd).toBeCloseTo(0.00022, 8);
    expect(out.fellBack).toBeUndefined();
  });

  it('the answer stays the question’s: the state and the proposed answer are the input’s whatever the model says', async () => {
    const out = await writeBrief(input, new ProviderBrief({ provider: fake(() => answer(GOOD)) }));
    expect(out.brief).toMatchObject({ state: 'not_verified', ask: 'What is inside this bundle?' });
  });

  it('a brief whose every reason fails the checks is the rules brief, and the call is still paid for', async () => {
    const bad = JSON.stringify({ suggestion: null, reasons: [{ text: 'The pair costs $30.', quoteIndex: batteries }], check: null });
    const out = await writeBrief(input, new ProviderBrief({ provider: fake(() => answer(bad)) }));
    expect(out.brief).toEqual(rulesBrief(input));
    expect(out.fellBack).toBe('No sentence of the brief passed the checks.');
    expect(out.called).toBe(true);
    expect(out.costUsd).toBeGreaterThan(0);
    expect(out.verdicts[0]).toMatchObject({ kept: false });
  });

  it('an answer that is not the shape is the rules brief, with its cost', async () => {
    for (const text of ['not json', '[]', '{"reasons": 4}']) {
      const out = await writeBrief(input, new ProviderBrief({ provider: fake(() => answer(text)) }));
      expect(out.brief.writtenBy).toBe('rules');
      expect(out.costUsd).toBeGreaterThan(0);
      expect(out.fellBack).toBeTruthy();
    }
  });

  it('a provider failure is the rules brief and no cost; nothing is retried', async () => {
    const provider = fake(() => ({ ok: false, notJudged: { reason: 'network', message: 'Claude could not be reached.' } }));
    const out = await writeBrief(input, new ProviderBrief({ provider }));
    expect(provider.requests).toHaveLength(1);
    expect(out).toMatchObject({ called: false, costUsd: null, fellBack: 'Claude could not be reached.' });
    expect(out.brief.writtenBy).toBe('rules');
    const thrown = await writeBrief(input, { provider: 'x', model: 'm', ask: async () => { throw new Error('boom'); } });
    expect(thrown.fellBack).toBe('boom');
  });

  it('asks nothing when there is no suggestion or no quote the code found', async () => {
    const provider = fake(() => answer(GOOD));
    const model = new ProviderBrief({ provider });
    const none = await writeBrief(realInput('match:DEWALT:DCF860B', null), model);
    const noQuotes = await writeBrief({ ...input, quotes: [] }, model);
    expect(provider.requests).toHaveLength(0);
    expect(none).toMatchObject({ called: false, costUsd: null, fellBack: 'There is no suggestion to explain.' });
    expect(noQuotes).toMatchObject({ called: false, fellBack: 'No quote of the suggestion was found on its page.' });
  });

  it('reads the answer’s JSON and drops what is off its shape', () => {
    expect(parseBriefRaw(GOOD)).toMatchObject({ ok: true, raw: { reasons: [{ quoteIndex: batteries }], check: { quoteIndex: null } } });
    expect(parseBriefRaw('{"suggestion":null,"reasons":[{"text":"a"},{"text":"b","quoteIndex":1}],"check":null}')).toMatchObject({ ok: true, raw: { reasons: [{ text: 'b', quoteIndex: 1 }], check: null } });
    expect(parseBriefRaw('{')).toMatchObject({ ok: false });
  });
});

describe('what a brief costs', () => {
  it('is the usage at the model’s rates, null for a model with no rate, and estimated before the call', () => {
    expect(briefCost('claude-haiku-5-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.1, 8);
    expect(briefCost('deepseek-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(1.5, 8);
    expect(briefCost('no-such-model', { inputTokens: 5, outputTokens: 5 })).toBeNull();
    expect(briefCost('claude-haiku-5-5', undefined)).toBeNull();
    expect(estimatedBriefCost('claude-haiku-5-5')).toBeCloseTo((1500 * 0.1 + 500 * 0.5) / 1e6, 8);
    expect(estimatedBriefCost('no-such-model')).toBeNull();
  });
});

describe('the brief in Settings', () => {
  const keys: Record<string, string> = { anthropic: 'sk-ant-test', openai: 'sk-ds-test' };
  const base = {
    judge: { provider: 'anthropic' as const, model: 'claude-haiku-5-5', apiKeyRef: 'anthropic' },
    assist: { provider: 'anthropic' as const, model: 'claude-opus-5-5', apiKeyRef: 'anthropic' },
    research: { provider: 'anthropic' as const, model: 'claude-opus-5-5', apiKeyRef: 'anthropic' },
  };

  it('a store with no choice for it uses Claude Haiku on the Anthropic key', () => {
    const p = pipelinesFrom(base, { resolveKey: (r) => keys[r] });
    expect(p.brief).toMatchObject({ ok: true, value: { provider: 'claude', model: 'claude-haiku-5-5' } });
    expect(pipelinesFrom(base, { resolveKey: () => undefined }).brief).toEqual({ ok: false, error: 'No Anthropic key yet — add it in Settings › Keys.' });
  });

  it('is provider-neutral: DeepSeek writes briefs through the same pipeline', () => {
    const p = pipelinesFrom({ ...base, brief: { provider: 'openai-compatible', preset: 'deepseek', model: 'deepseek-flash', apiKeyRef: 'openai' } }, { resolveKey: (r) => keys[r] });
    expect(p.brief).toMatchObject({ ok: true, value: { provider: 'deepseek', model: 'deepseek-flash' } });
  });

  it('suggestion records of the real data have what a brief needs', () => {
    expect(suggestionFor(SIX).suggestion.status).toBe('unverified');
  });
});
