// The research loop through the Claude adapter with a fake fetch: what each request holds (the tools,
// the web search restricted to the two brand sites, the key only in its header) and how responses are
// read. Nothing reaches a network or a model: every response is written below in the Messages API's
// shape (tool_use, server_tool_use and web_search_tool_result as the web search tool page shows them).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaudeResearch } from '../src/research/claude';
import { researchQuestion } from '../src/research/loop';
import { RESEARCH_ANSWER_SCHEMA } from '../src/research/schema';
import { RESEARCH_PROMPT, WEB_SEARCH_TOOL_TYPE } from '../src/research/prompt';
import { recordedTools } from '../../scripts/research-tools';
import { PCL500525SB, recorded, researchCase } from './research-world';

const KEY = 'sk-ant-test-0000-not-a-real-key';
const MODEL = 'claude-opus-5-5';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const message = (stop: string, content: unknown[], usage: Record<string, unknown> = { input_tokens: 2000, output_tokens: 150 }) =>
  ({ id: 'msg_test', type: 'message', role: 'assistant', model: MODEL, content, stop_reason: stop, stop_details: null, usage });

function claudeWith(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift();
    if (!r) throw new Error('no more responses');
    return r;
  }) as typeof fetch;
  return { model: new ClaudeResearch({ apiKey: KEY, model: MODEL, fetchFn }), calls };
}

afterEach(() => vi.restoreAllMocks());

describe('ClaudeResearch', () => {
  it('sends the prompt, the tools, web search on ryobitools.com and dewalt.com only (at most 2), and the key only in its header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in the default tests'));
    const c = await researchCase(PCL500525SB);
    const { model, calls } = claudeWith([
      json(200, message('end_turn', [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'ryobi pcl500525sb' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
        { type: 'tool_use', id: 'toolu_1', name: 'submit_answer', input: { quotes: [], parts: [], reason: 'Not settled.', decision: 'cannot_tell', choiceIndex: null } },
      ], { input_tokens: 4000, output_tokens: 300, server_tool_use: { web_search_requests: 1 } })),
    ]);
    const s = await researchQuestion(c.q, c.evidence, recordedTools(recorded(), c.catalog), model, { catalog: c.catalog });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(s).toMatchObject({ status: 'cannot_tell', provider: 'claude', model: MODEL, usage: { inputTokens: 4000, outputTokens: 300, webSearchRequests: 1 } });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call!.init.headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01' });
    expect(String(call!.init.body)).not.toContain(KEY);
    const body = JSON.parse(String(call!.init.body));
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system', 'tools']);
    expect(body).toMatchObject({ model: MODEL, max_tokens: 4000, system: RESEARCH_PROMPT, output_config: { effort: 'low' } });
    // No output_config.format: citations (always on with web search) and JSON outputs are refused together.
    expect(body.output_config.format).toBeUndefined();

    const tools = body.tools as Record<string, unknown>[];
    expect(tools.map((t) => t.name)).toEqual(['read_homedepot_page', 'search_homedepot', 'catalog_lookup', 'submit_answer', 'web_search']);
    expect(tools.find((t) => t.name === 'web_search')).toEqual({
      type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: 2, allowed_domains: ['ryobitools.com', 'dewalt.com'], allowed_callers: ['direct'],
    });
    expect(WEB_SEARCH_TOOL_TYPE).toBe('web_search_20260209');
    expect(tools.find((t) => t.name === 'submit_answer')).toMatchObject({ strict: true, input_schema: RESEARCH_ANSWER_SCHEMA });
    for (const t of tools.filter((x) => x.name !== 'web_search')) expect(t).toMatchObject({ strict: true });
    // No tool reaches Amazon or SerpApi.
    expect(JSON.stringify(tools)).not.toMatch(/amazon|serpapi/i);
  });

  it('a tool turn goes back with the assistant content unchanged and only tool_result blocks', async () => {
    const c = await researchCase(PCL500525SB);
    const first = [
      { type: 'thinking', thinking: '', signature: 'sig-abc' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_homedepot_page', input: { itemId: '328690510', url: null } },
    ];
    const { model, calls } = claudeWith([
      json(200, message('tool_use', first)),
      json(200, message('tool_use', [{ type: 'tool_use', id: 'toolu_2', name: 'submit_answer', input: { quotes: [], parts: [], reason: 'x', decision: 'cannot_tell', choiceIndex: null } }])),
    ]);
    await researchQuestion(c.q, c.evidence, recordedTools(recorded(), c.catalog), model, { catalog: c.catalog });
    const second = JSON.parse(String(calls[1]!.init.body));
    expect(second.messages[1]).toEqual({ role: 'assistant', content: first });
    expect(second.messages[2].role).toBe('user');
    expect(second.messages[2].content.map((b: { type: string; tool_use_id: string }) => [b.type, b.tool_use_id])).toEqual([['tool_result', 'toolu_1']]);
    expect(second.tools).toEqual(JSON.parse(String(calls[0]!.init.body)).tools);
  });

  it('an HTTP failure is not_suggested with the typed reason, and the key never appears in it', async () => {
    const c = await researchCase(PCL500525SB);
    const { model } = claudeWith([json(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } })]);
    const s = await researchQuestion(c.q, c.evidence, recordedTools(recorded(), c.catalog), model, { catalog: c.catalog });
    expect(s).toMatchObject({ status: 'not_suggested', notSuggested: { reason: 'auth', status: 401 } });
    expect(JSON.stringify(s)).not.toContain(KEY);
  });
});
