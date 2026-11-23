// The OpenAI-compatible provider against a fake fetch. Nothing here reaches a network or a model: every
// response is written below in the Chat Completions shape (DeepSeek's fields from
// https://api-docs.deepseek.com/api/create-chat-completion, read Nov 22, 2026).

import { describe, expect, it, vi } from 'vitest';
import { answerFrom } from '../src/ai/answer';
import { OPENAI_COMPATIBLE_PRESETS, OpenAICompatibleProvider, SUBMIT_ANSWER_TOOL, readChatUsage } from '../src/ai/openai';
import type { ModelRequest } from '../src/ai/types';

const KEY = 'sk-test-0000-not-a-real-key';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const completion = (message: Record<string, unknown>, finish = 'stop', usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 20 }) =>
  ({ id: 'c1', object: 'chat.completion', model: 'deepseek-flash', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }], usage });

function provider(responses: (Response | Error)[], opts: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift();
    if (!r) throw new Error('no more responses');
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com', apiKey: KEY, model: 'deepseek-flash', id: 'deepseek', label: 'DeepSeek', fetchFn, ...opts });
  return { p, calls, body: (i = 0) => JSON.parse(String(calls[i]!.init.body)) };
}

const REQ: ModelRequest = { system: 'SYS', messages: [{ role: 'user', content: 'hello' }], maxTokens: 500 };
const TOOL = { name: 'search_homedepot', description: 'Searches.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };

describe('OpenAICompatibleProvider request', () => {
  it('posts to {baseUrl}/chat/completions with the key in the Authorization header only', async () => {
    const { p, calls, body } = provider([json(200, completion({ content: 'hi' }))]);
    await p.send(REQ);
    expect(calls[0]!.url).toBe('https://api.deepseek.com/chat/completions');
    expect(calls[0]!.init.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(calls[0]!.url).not.toContain(KEY);
    expect(String(calls[0]!.init.body)).not.toContain(KEY);
    expect(body()).toEqual({ model: 'deepseek-flash', max_tokens: 500, messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hello' }] });
  });

  it('keeps a path in the base URL and drops a trailing slash', async () => {
    const { p, calls } = provider([json(200, completion({ content: 'x' }))], { baseUrl: 'https://api.openai.com/v1/' });
    await p.send(REQ);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('sends client tools as functions with tool_choice "auto"', async () => {
    const { p, body } = provider([json(200, completion({ content: 'x' }))]);
    await p.send({ ...REQ, tools: [TOOL] });
    expect(body().tools).toEqual([{ type: 'function', function: { name: 'search_homedepot', description: 'Searches.', parameters: TOOL.inputSchema } }]);
    expect(body().tool_choice).toBe('auto');
  });

  it('maps an assistant tool call and its result both ways: tool_calls, then a role "tool" message', async () => {
    const { p, body } = provider([json(200, completion({ content: 'x' }))]);
    await p.send({
      ...REQ,
      tools: [TOOL],
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_call', id: 'call_1', name: 'search_homedepot', input: { query: 'ryobi' } }] },
        { role: 'user', content: [{ type: 'tool_result', callId: 'call_1', content: 'ten rows' }] },
        { role: 'assistant', content: [{ type: 'tool_call', id: 'call_2', name: 'search_homedepot', input: { query: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', callId: 'call_2', content: 'no page', isError: true }] },
      ],
    });
    expect(body().messages.slice(2)).toEqual([
      { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_homedepot', arguments: '{"query":"ryobi"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'ten rows' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'search_homedepot', arguments: '{"query":"x"}' } }] },
      { role: 'tool', tool_call_id: 'call_2', content: 'Error: no page' },
    ]);
  });

  it('a response schema becomes a forced submit_answer function; with other tools it is offered with "auto"', async () => {
    const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };
    const one = provider([json(200, completion({ content: null }))]);
    await one.p.send({ ...REQ, responseSchema: schema });
    expect(one.body().tools).toEqual([{ type: 'function', function: { name: SUBMIT_ANSWER_TOOL, description: expect.any(String), parameters: schema } }]);
    expect(one.body().tool_choice).toEqual({ type: 'function', function: { name: SUBMIT_ANSWER_TOOL } });
    const two = provider([json(200, completion({ content: null }))]);
    await two.p.send({ ...REQ, tools: [TOOL], responseSchema: schema });
    expect(two.body().tools).toHaveLength(2);
    expect(two.body().tool_choice).toBe('auto');
  });

  it('the DeepSeek preset turns thinking off (a forced tool choice is a 400 in thinking mode)', async () => {
    const d = OPENAI_COMPATIBLE_PRESETS.deepseek;
    const { p, body } = provider([json(200, completion({ content: 'x' }))], { baseUrl: d.baseUrl, model: d.model, extraBody: { ...d.extraBody } });
    await p.send(REQ);
    expect(body().thinking).toEqual({ type: 'disabled' });
    expect(d).toMatchObject({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
  });

  it('refuses a request for server tools: this provider has none', async () => {
    const { p, calls } = provider([]);
    const res = await p.send({ ...REQ, serverTools: [{ name: 'web_search' }] });
    expect(res).toMatchObject({ ok: false, notJudged: { reason: 'bad_request' } });
    expect(calls).toHaveLength(0);
    expect(p.capabilities.serverTools).toEqual([]);
  });

  it('refuses an address that would send the key in the clear, or hold a secret of its own', () => {
    const make = (baseUrl: string) => () => new OpenAICompatibleProvider({ baseUrl, apiKey: KEY, model: 'm' });
    expect(make('http://api.example.com')).toThrow(/https/);
    expect(make('not a url')).toThrow(/web address/);
    expect(make('https://user:pass@api.example.com')).toThrow(/user/);
    expect(make('https://api.example.com/v1?key=abc')).toThrow(/query/);
    expect(make('http://localhost:11434/v1')).not.toThrow();
    expect(() => new OpenAICompatibleProvider({ baseUrl: 'https://a.example.com', apiKey: '', model: 'm' })).toThrow(/key/);
  });
});

describe('OpenAICompatibleProvider response', () => {
  it('reads text, and a finished answer is "end"', async () => {
    const { p } = provider([json(200, completion({ content: 'Done.' }))]);
    expect(await p.send(REQ)).toMatchObject({ ok: true, content: [{ type: 'text', text: 'Done.' }], stop: 'end', rawStop: 'stop', usage: { inputTokens: 100, outputTokens: 20 } });
  });

  it('reads tool calls with parsed arguments and stops with "tool_use"', async () => {
    const calls = [{ id: 'call_9', type: 'function', function: { name: 'search_homedepot', arguments: '{"query":"ryobi jig saw"}' } }];
    const { p } = provider([json(200, completion({ content: null, tool_calls: calls }, 'tool_calls'))]);
    expect(await p.send({ ...REQ, tools: [TOOL] })).toMatchObject({
      ok: true, stop: 'tool_use', content: [{ type: 'tool_call', id: 'call_9', name: 'search_homedepot', input: { query: 'ryobi jig saw' } }],
    });
  });

  it('a tool call under finish_reason "stop" is still tool_use', async () => {
    const calls = [{ id: 'c', type: 'function', function: { name: 'search_homedepot', arguments: '{"query":"a"}' } }];
    const { p } = provider([json(200, completion({ content: '', tool_calls: calls }, 'stop'))]);
    expect(await p.send({ ...REQ, tools: [TOOL] })).toMatchObject({ ok: true, stop: 'tool_use' });
  });

  it('a submit_answer call is the answer text, and the judge/assist reading takes it', async () => {
    const args = '{"verdict":"match"}';
    const { p } = provider([json(200, completion({ content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: SUBMIT_ANSWER_TOOL, arguments: args } }] }, 'tool_calls'))]);
    const res = await p.send({ ...REQ, responseSchema: { type: 'object' } });
    expect(answerFrom(res, 'DeepSeek')).toEqual({ ok: true, answer: args, usage: { inputTokens: 100, outputTokens: 20 } });
  });

  it('a one-shot answer given as plain text instead of the call is still read (the verifier decides what it is worth)', async () => {
    const { p } = provider([json(200, completion({ content: '{"verdict":"unsure"}' }))]);
    const res = await p.send({ ...REQ, responseSchema: { type: 'object' } });
    expect(answerFrom(res, 'DeepSeek')).toMatchObject({ ok: true, answer: '{"verdict":"unsure"}' });
  });

  it('arguments that are not JSON are a typed bad_response, with the usage kept', async () => {
    const calls = [{ id: 'c', type: 'function', function: { name: 'search_homedepot', arguments: '{"query":' } }];
    const { p } = provider([json(200, completion({ content: null, tool_calls: calls }, 'tool_calls'))]);
    expect(await p.send({ ...REQ, tools: [TOOL] })).toMatchObject({ ok: false, notJudged: { reason: 'bad_response' }, usage: { inputTokens: 100 } });
  });

  it('length is max_tokens, content_filter and a refusal are refusal, insufficient_system_resource is a server failure', async () => {
    const length = await provider([json(200, completion({ content: 'cut' }, 'length'))]).p.send(REQ);
    expect(answerFrom(length, 'DeepSeek')).toMatchObject({ ok: false, notJudged: { reason: 'max_tokens' } });
    const filtered = await provider([json(200, completion({ content: null }, 'content_filter'))]).p.send(REQ);
    expect(answerFrom(filtered, 'DeepSeek', 'DeepSeek declined to judge this listing.')).toMatchObject({ ok: false, notJudged: { reason: 'refusal', message: 'DeepSeek declined to judge this listing.' } });
    const refused = await provider([json(200, completion({ content: null, refusal: 'I cannot help.' }))]).p.send(REQ);
    expect(answerFrom(refused, 'DeepSeek')).toMatchObject({ ok: false, notJudged: { reason: 'refusal' } });
    const resource = await provider([json(200, completion({ content: 'x' }, 'insufficient_system_resource'))]).p.send(REQ);
    expect(resource).toMatchObject({ ok: false, notJudged: { reason: 'server' } });
  });

  it('something that is not a chat completion is bad_response', async () => {
    expect(await provider([json(200, { hello: 1 })]).p.send(REQ)).toMatchObject({ ok: false, notJudged: { reason: 'bad_response' } });
    expect(await provider([new Response('<html>', { status: 200 })]).p.send(REQ)).toMatchObject({ ok: false, notJudged: { reason: 'bad_response' } });
  });
});

describe('OpenAICompatibleProvider usage', () => {
  it("DeepSeek: cache hit and miss tokens are read as cacheRead and uncached input", () => {
    expect(readChatUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 })).toEqual({
      inputTokens: 200, outputTokens: 50, cacheReadInputTokens: 800,
    });
  });
  it('DeepSeek schema variant: the same fields under prompt_tokens_details', () => {
    expect(readChatUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 } })).toEqual({
      inputTokens: 400, outputTokens: 50, cacheReadInputTokens: 600,
    });
  });
  it('OpenAI and others: prompt_tokens_details.cached_tokens, input is what is left', () => {
    expect(readChatUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 300 } })).toEqual({
      inputTokens: 700, outputTokens: 50, cacheReadInputTokens: 300,
    });
  });
  it('plain prompt and completion tokens with no cache fields; nothing at all is no usage', () => {
    expect(readChatUsage({ prompt_tokens: 12, completion_tokens: 3 })).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(readChatUsage(undefined)).toBeUndefined();
  });
});

describe('OpenAICompatibleProvider failures', () => {
  const failure = async (status: number, error: Record<string, unknown> = { message: 'nope' }, headers: Record<string, string> = {}) => {
    const { p } = provider([json(status, { error }, headers)]);
    const res = await p.send(REQ);
    if (res.ok) throw new Error('expected a failure');
    return res.notJudged;
  };

  it('maps HTTP statuses to the typed reasons', async () => {
    expect(await failure(401)).toMatchObject({ reason: 'auth', status: 401 });
    expect(await failure(403)).toMatchObject({ reason: 'auth' });
    expect(await failure(402)).toMatchObject({ reason: 'auth', status: 402, message: expect.stringContaining('insufficient balance') });
    expect(await failure(429, { message: 'slow down' }, { 'retry-after': '7' })).toMatchObject({ reason: 'rate_limited', retryAfterSeconds: 7 });
    expect(await failure(503)).toMatchObject({ reason: 'overloaded' });
    expect(await failure(500)).toMatchObject({ reason: 'server' });
    expect(await failure(502)).toMatchObject({ reason: 'server' });
    expect(await failure(400)).toMatchObject({ reason: 'bad_request' });
    expect(await failure(422)).toMatchObject({ reason: 'bad_request' });
    expect(await failure(404)).toMatchObject({ reason: 'http', status: 404 });
  });

  it('a network failure and an abort are typed, and the fetch error text is not passed on', async () => {
    const down = await provider([new Error(`connect failed for ${KEY}`)]).p.send(REQ);
    expect(down).toMatchObject({ ok: false, notJudged: { reason: 'network', message: 'DeepSeek could not be reached.' } });
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(await provider([abort]).p.send(REQ)).toMatchObject({ ok: false, notJudged: { reason: 'aborted' } });
    const controller = new AbortController();
    controller.abort();
    expect(await provider([new Error('x')]).p.send(REQ, controller.signal)).toMatchObject({ ok: false, notJudged: { reason: 'aborted' } });
  });

  it('the key never appears in an error, even when the service echoes it', async () => {
    const n = await failure(401, { type: 'authentication_error', message: `Incorrect API key provided: ${KEY}` });
    expect(JSON.stringify(n)).not.toContain(KEY);
    expect(n.message).toContain('[key]');
  });

  it('uses the global fetch through a wrapper when none is given, and never throws', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in the default tests'));
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com', apiKey: KEY, model: 'deepseek-flash' });
    expect(await p.send(REQ)).toMatchObject({ ok: false, notJudged: { reason: 'network' } });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
