// The judge, the assistant and the research agent on a ModelProvider (step 13, W6), with a fake fetch.
// Claude through the neutral layer must send what the Claude-only adapters send; an OpenAI-compatible
// model runs the same pipelines, and research then has the Home Depot tools only.

import { describe, expect, it } from 'vitest';
import { ProviderAssist } from '../src/assist/provider';
import { ClaudeAssist } from '../src/assist/claude';
import { ClaudeProvider } from '../src/ai/claude';
import { OpenAICompatibleProvider } from '../src/ai/openai';
import { estimatedAskCost } from '../src/assist/cost';
import { ClaudeJudge } from '../src/judge/claude';
import { PRICE_TABLE, costOf, ratesFor, setModelRates } from '../src/judge/eval';
import { ProviderJudge } from '../src/judge/provider';
import { ClaudeResearch } from '../src/research/claude';
import { researchQuestion } from '../src/research/loop';
import { RESEARCH_PROMPT, RESEARCH_PROMPT_HOMEDEPOT_ONLY, RESEARCH_PROMPT_VERSION, researchTools } from '../src/research/prompt';
import { ProviderResearch } from '../src/research/provider';
import { estimatedResearchCost, researchCost } from '../src/research/eval';
import { RESEARCH_ANSWER_SCHEMA } from '../src/research/schema';
import { recordedTools } from '../../scripts/research-tools';
import { PCL500525SB, recorded, researchCase } from './research-world';
import type { JudgeInput } from '../src/judge/types';

const KEY = 'sk-test-0000-not-a-real-key';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fake(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift();
    if (!r) throw new Error('no more responses');
    return r;
  }) as typeof fetch;
  return { fetchFn, calls, body: (i = 0) => JSON.parse(String(calls[i]!.init.body)) };
}

const claudeMessage = (stop: string, content: unknown[], usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 5 }) =>
  ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason: stop, stop_details: null, usage });
const chat = (message: Record<string, unknown>, finish = 'stop', usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 20 }) =>
  ({ id: 'c', object: 'chat.completion', model: 'deepseek-flash', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }], usage });

const INPUT: JudgeInput = {
  part: { brand: 'RYOBI', model: 'PCL206', twin: 'PCL206B' },
  listing: {
    itemId: 'v1|237179711800|0', title: 'RYOBI 18V 1/2 in. Drill/Driver (PCL206B) TOOL ONLY',
    aspects: [{ name: 'MPN', value: 'PCL206' }], descriptionText: 'A drill.', mpn: 'PCL206', brand: 'Ryobi', conditionId: '1000',
  },
};

describe('Claude through the neutral layer sends what the Claude-only adapters send', () => {
  it('the judge', async () => {
    const a = fake([json(200, claudeMessage('end_turn', [{ type: 'text', text: '{}' }]))]);
    const b = fake([json(200, claudeMessage('end_turn', [{ type: 'text', text: '{}' }]))]);
    const old = await new ClaudeJudge({ apiKey: KEY, model: 'claude-haiku-5-5', fetchFn: a.fetchFn }).judge(INPUT);
    const neu = await new ProviderJudge({ provider: new ClaudeProvider({ apiKey: KEY, model: 'claude-haiku-5-5', fetchFn: b.fetchFn }) }).judge(INPUT);
    expect(b.body()).toEqual(a.body());
    expect(b.calls[0]!.init.headers).toEqual(a.calls[0]!.init.headers);
    expect(neu).toEqual(old);
  });

  it('the assistant', async () => {
    const request = { system: 'SYS', user: 'USER', schema: { type: 'object', properties: {}, additionalProperties: false } };
    const a = fake([json(200, claudeMessage('end_turn', [{ type: 'text', text: '{"a":1}' }]))]);
    const b = fake([json(200, claudeMessage('end_turn', [{ type: 'text', text: '{"a":1}' }]))]);
    const old = await new ClaudeAssist({ apiKey: KEY, model: 'claude-haiku-5-5', fetchFn: a.fetchFn }).ask(request);
    const neu = await new ProviderAssist({ provider: new ClaudeProvider({ apiKey: KEY, model: 'claude-haiku-5-5', fetchFn: b.fetchFn }) }).ask(request);
    expect(b.body()).toEqual(a.body());
    expect(neu).toEqual(old);
  });

  it('the research loop: the same requests, tools, caching and tool-turn echo', async () => {
    const c = await researchCase(PCL500525SB);
    const turns = () => [
      json(200, claudeMessage('tool_use', [
        { type: 'thinking', thinking: '', signature: 'sig-abc' },
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'ryobi' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
        { type: 'tool_use', id: 'toolu_1', name: 'read_homedepot_page', input: { itemId: '328690510', url: null } },
      ], { input_tokens: 4000, output_tokens: 300, server_tool_use: { web_search_requests: 1 } })),
      json(200, claudeMessage('tool_use', [{ type: 'tool_use', id: 'toolu_2', name: 'submit_answer', input: { quotes: [], parts: [], reason: 'x', decision: 'cannot_tell', choiceIndex: null } }])),
    ];
    const a = fake(turns());
    const b = fake(turns());
    const old = await researchQuestion(c.q, c.evidence, recordedTools(recorded(), c.catalog), new ClaudeResearch({ apiKey: KEY, model: 'claude-opus-5-5', fetchFn: a.fetchFn }), { catalog: c.catalog });
    const neu = await researchQuestion(c.q, c.evidence, recordedTools(recorded(), c.catalog), new ProviderResearch({ provider: new ClaudeProvider({ apiKey: KEY, model: 'claude-opus-5-5', fetchFn: b.fetchFn }) }), { catalog: c.catalog });
    expect(b.calls).toHaveLength(2);
    expect(b.body(0)).toEqual(a.body(0));
    expect(b.body(1)).toEqual(a.body(1));
    expect(b.body(1).messages[1].content).toHaveLength(4); // the assistant turn went back as it came, thinking and server blocks included
    expect(neu).toEqual(old);
    expect(neu).toMatchObject({ status: 'cannot_tell', provider: 'claude', promptVersion: RESEARCH_PROMPT_VERSION, usage: { webSearchRequests: 1 } });
  });
});

describe('a typed failure is the same through any provider', () => {
  it('judge: an auth failure carries its reason, and the key is nowhere in it', async () => {
    const f = fake([json(401, { error: { message: `bad key ${KEY}` } })]);
    const judge = new ProviderJudge({ provider: new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com', apiKey: KEY, model: 'deepseek-flash', id: 'deepseek', label: 'DeepSeek', fetchFn: f.fetchFn }) });
    const call = await judge.judge(INPUT);
    expect(call).toMatchObject({ ok: false, judgeId: 'deepseek', model: 'deepseek-flash', notJudged: { reason: 'auth', status: 401 } });
    expect(JSON.stringify(call)).not.toContain(KEY);
  });
});

describe('the judge and the assistant on an OpenAI-compatible model', () => {
  const provider = (f: ReturnType<typeof fake>) =>
    new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com', apiKey: KEY, model: 'deepseek-flash', id: 'deepseek', label: 'DeepSeek', fetchFn: f.fetchFn });
  const submit = (args: string) => chat({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'submit_answer', arguments: args } }] }, 'tool_calls');

  it('judge: the schema goes as the submit function, the arguments come back as the answer, usage with cache hits', async () => {
    const f = fake([json(200, { ...submit('{"verdict":"unsure"}'), usage: { prompt_tokens: 1000, completion_tokens: 40, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 } })]);
    const call = await new ProviderJudge({ provider: provider(f) }).judge(INPUT);
    expect(call).toMatchObject({ ok: true, judgeId: 'deepseek', model: 'deepseek-flash', answer: '{"verdict":"unsure"}', usage: { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 900 } });
    expect(f.body().tools[0].function.name).toBe('submit_answer');
    expect(f.body().messages[0].role).toBe('system');
  });

  it('assist: the same, and the model is named in a refusal', async () => {
    const f = fake([json(200, chat({ content: null }, 'content_filter'))]);
    const res = await new ProviderAssist({ provider: provider(f) }).ask({ system: 's', user: 'u', schema: { type: 'object' } });
    expect(res).toMatchObject({ ok: false, notJudged: { reason: 'refusal', message: 'DeepSeek declined to suggest an answer.' } });
  });
});

describe('research on a model with no server tools', () => {
  const toolCall = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

  it('offers the Home Depot tools and the answer tool only, with a prompt that says there is no web search', async () => {
    const c = await researchCase(PCL500525SB);
    const f = fake([
      json(200, chat({ content: null, tool_calls: [toolCall('call_1', 'read_homedepot_page', { itemId: '328690510', url: null })] }, 'tool_calls', { prompt_tokens: 3000, completion_tokens: 80, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 3000 })),
      json(200, chat({ content: null, tool_calls: [toolCall('call_2', 'submit_answer', { quotes: [], parts: [], reason: 'Not settled.', decision: 'cannot_tell', choiceIndex: null })] }, 'tool_calls', { prompt_tokens: 4000, completion_tokens: 60, prompt_cache_hit_tokens: 3000, prompt_cache_miss_tokens: 1000 })),
    ]);
    const model = new ProviderResearch({ provider: new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com', apiKey: KEY, model: 'deepseek-flash', id: 'deepseek', label: 'DeepSeek', fetchFn: f.fetchFn }) });
    expect(model).toMatchObject({ provider: 'deepseek', webTools: false, label: 'DeepSeek' });
    const s = await researchQuestion(c.q, c.evidence, recordedTools(recorded(), c.catalog), model, { catalog: c.catalog });

    const first = f.body(0);
    expect(first.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['read_homedepot_page', 'search_homedepot', 'catalog_lookup', 'submit_answer']);
    expect(JSON.stringify(first.tools)).not.toMatch(/web_search|web_fetch/);
    expect(first.tool_choice).toBe('auto');
    expect(first.thinking).toBeUndefined(); // set by the preset, not by the provider on its own
    expect(first.messages[0]).toEqual({ role: 'system', content: RESEARCH_PROMPT_HOMEDEPOT_ONLY });
    expect(RESEARCH_PROMPT_HOMEDEPOT_ONLY).not.toBe(RESEARCH_PROMPT);
    expect(RESEARCH_PROMPT_HOMEDEPOT_ONLY).toContain('You have no web search');
    expect(RESEARCH_PROMPT_HOMEDEPOT_ONLY).not.toContain('web_search and web_fetch:');
    expect(first.messages[1].content).toContain('There is no web search.');
    expect(first.messages[1].content).not.toContain('web fetches');

    // The tool result went back as a role "tool" message tied to the call.
    const second = f.body(1);
    expect(second.messages[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'read_homedepot_page' } }] });
    expect(second.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(String(second.messages[3].content)).toContain('PCL500');

    expect(s).toMatchObject({
      status: 'cannot_tell', provider: 'deepseek', model: 'deepseek-flash', promptVersion: `${RESEARCH_PROMPT_VERSION}+homedepot-only`,
      usage: { inputTokens: 4000, outputTokens: 140, cacheReadInputTokens: 3000, webSearchRequests: 0 },
    });
    expect(JSON.stringify(s)).not.toContain(KEY);
  });

  it('the web tools are left out of the tool list and the answer tool is still there', () => {
    const names = (web: boolean) => researchTools(undefined, web).map((t) => t.name);
    expect(names(true)).toEqual(['read_homedepot_page', 'search_homedepot', 'catalog_lookup', 'submit_answer', 'web_search', 'web_fetch']);
    expect(names(false)).toEqual(['read_homedepot_page', 'search_homedepot', 'catalog_lookup', 'submit_answer']);
    expect(researchTools(undefined, false).find((t) => t.name === 'submit_answer')).toMatchObject({ input_schema: RESEARCH_ANSWER_SCHEMA });
  });

  it('a plain-text JSON answer with no submit call is still read and checked, never trusted', async () => {
    const c = await researchCase(PCL500525SB);
    const text = JSON.stringify({ quotes: [], parts: [], reason: 'Not settled.', decision: 'cannot_tell', choiceIndex: null });
    const f = fake([json(200, chat({ content: text }))]);
    const model = new ProviderResearch({ provider: new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com', apiKey: KEY, model: 'deepseek-flash', id: 'deepseek', label: 'DeepSeek', fetchFn: f.fetchFn }) });
    const s = await researchQuestion(c.q, c.evidence, recordedTools(recorded(), c.catalog), model, { catalog: c.catalog });
    expect(s.status).toBe('cannot_tell');
  });

  it('a failure names the model that failed, not Claude', async () => {
    const c = await researchCase(PCL500525SB);
    const f = fake([json(200, chat({ content: 'cut' }, 'length'))]);
    const model = new ProviderResearch({ provider: new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com', apiKey: KEY, model: 'deepseek-flash', id: 'deepseek', label: 'DeepSeek', fetchFn: f.fetchFn }) });
    const s = await researchQuestion(c.q, c.evidence, recordedTools(recorded(), c.catalog), model, { catalog: c.catalog });
    expect(s).toMatchObject({ status: 'not_suggested', notSuggested: { reason: 'max_tokens', message: 'DeepSeek’s answer was cut off before it finished.' } });
  });
});

describe('prices per model', () => {
  it('DeepSeek models have rates (peak, read Nov 22, 2026) and a cost follows from usage with cache hits', () => {
    expect(ratesFor('deepseek-flash')).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.006 });
    expect(ratesFor('deepseek-v4-pro')).toEqual({ input: 1.32, output: 3.96, cacheRead: 0.044 });
    // 200 uncached + 800 cached input, 50 output on flash: 200*0.3 + 800*0.006 + 50*1.2 per million.
    const rates = ratesFor('deepseek-flash')!;
    expect(researchCost({ inputTokens: 200, cacheReadInputTokens: 800, outputTokens: 50 }, rates)).toBeCloseTo((200 * 0.3 + 800 * 0.006 + 50 * 1.2) / 1e6, 10);
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 0 }, rates)).toBeCloseTo(0.3, 10);
  });

  it('estimates work for a priced non-Claude model, and a model with no rate says nothing rather than guessing', () => {
    expect(estimatedAskCost('deepseek-flash')).not.toBeNull();
    expect(estimatedResearchCost('deepseek-flash')).toBeLessThan(estimatedResearchCost('claude-opus-5-5')!);
    expect(estimatedAskCost('some-unknown-model')).toBeNull();
    expect(ratesFor('some-unknown-model')).toBeNull();
  });

  it('a rate set from Settings is used by every estimate', () => {
    setModelRates('acme-chat', { input: 1, output: 2 });
    try {
      expect(estimatedAskCost('acme-chat')).toBeCloseTo((1800 * 1 + 500 * 2) / 1e6, 10);
    } finally {
      delete PRICE_TABLE['acme-chat'];
    }
  });
});
