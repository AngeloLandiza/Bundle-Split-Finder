// The Claude adapter (step 10, Task 2) against a fake fetch. Nothing here reaches a network or a
// model: every response is written below, in the Messages API's shape.

import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_VERSION,
  CLAUDE_JUDGE_MODELS,
  CLAUDE_MESSAGES_URL,
  ClaudeJudge,
  DEFAULT_CLAUDE_JUDGE_MODEL,
} from '../src/judge/claude';
import { JUDGE_PROMPT, PROMPT_VERSION } from '../src/judge/prompt';
import { JUDGE_SCHEMA } from '../src/judge/schema';
import type { JudgeInput, JudgeRaw } from '../src/judge/types';
import { judgeListing } from '../src/judge/verify';

const KEY = 'sk-ant-test-0000-not-a-real-key';

// The real listing 237179711800's title and item specifics (fixtures/ebay/), cut to what these tests need.
const INPUT: JudgeInput = {
  part: { brand: 'RYOBI', model: 'PCL206', twin: 'PCL206B' },
  listing: {
    itemId: 'v1|237179711800|0',
    title: 'RYOBI 18V 1/2 in. Drill/Driver (PCL206B) TOOL ONLY',
    aspects: [
      { name: 'Number of Items in Set', value: '1' },
      { name: 'MPN', value: 'PCL206' },
    ],
    descriptionText: 'The RYOBI 18V 1/2 in. Drill/Driver (PCL206B) is a heavy-duty and compact cordless drill.',
    mpn: 'PCL206',
    brand: 'Ryobi',
    conditionId: '1000',
    price: { value: '38.50', currency: 'USD' },
  },
};

const MATCH: JudgeRaw = {
  evidence: [
    { claim: 'identity', quote: 'RYOBI 18V 1/2 in. Drill/Driver (PCL206B) TOOL ONLY' },
    { claim: 'quantity', quote: 'Number of Items in Set: 1' },
  ],
  toolOnly: true,
  quantity: 1,
  condition: 'new',
  extras: [],
  reason: 'Title names PCL206B, tool only.',
  verdict: 'match',
};

interface Call {
  url: string;
  init: RequestInit;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: JSON.stringify(MATCH) }],
  stop_reason: 'end_turn',
  stop_details: null,
  usage: { input_tokens: 812, output_tokens: 143, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...over,
});

const apiError = (status: number, type: string, msg: string, headers?: Record<string, string>) =>
  json(status, { type: 'error', error: { type, message: msg } }, headers);

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fn, calls };
}

const judgeWith = (respond: () => Response | Promise<Response>, model = DEFAULT_CLAUDE_JUDGE_MODEL) => {
  const fake = fakeFetch(respond);
  return { judge: new ClaudeJudge({ apiKey: KEY, model, fetchFn: fake.fn }), calls: fake.calls };
};

describe('ClaudeJudge: the request', () => {
  it('posts to the Messages API with exactly the documented headers', async () => {
    const { judge, calls } = judgeWith(() => json(200, message()));
    await judge.judge(INPUT);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(CLAUDE_MESSAGES_URL).toBe('https://api.anthropic.com/v1/messages');
    expect(call!.init.method).toBe('POST');
    expect(call!.init.headers).toEqual({
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    expect(ANTHROPIC_VERSION).toBe('2023-06-01');
  });

  it('never puts the key in the URL or the body', async () => {
    const { judge, calls } = judgeWith(() => json(200, message()));
    await judge.judge(INPUT);
    expect(calls[0]!.url).not.toContain(KEY);
    expect(String(calls[0]!.init.body)).not.toContain(KEY);
  });

  it('sends the model, a small max_tokens, the prompt, the listing and the schema; no sampling or thinking settings', async () => {
    const { judge, calls } = judgeWith(() => json(200, message()), 'claude-opus-5-5');
    await judge.judge(INPUT);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.max_tokens).toBeLessThanOrEqual(1000);
    expect(body.system).toBe(JUDGE_PROMPT);
    expect(body.output_config.format).toEqual({ type: 'json_schema', schema: JUDGE_SCHEMA });
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain(INPUT.listing.title);
    expect(body.messages[0].content).toContain('PCL206');
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) expect(k in body).toBe(false);
  });

  it('passes the abort signal to fetch', async () => {
    const { judge, calls } = judgeWith(() => json(200, message()));
    const controller = new AbortController();
    await judge.judge(INPUT, controller.signal);
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });

  it('names itself and its model, and offers the two Claude models', () => {
    const { judge } = judgeWith(() => json(200, message()), 'claude-opus-5-5');
    expect(judge.id).toBe('claude');
    expect(judge.model).toBe('claude-opus-5-5');
    expect(CLAUDE_JUDGE_MODELS).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
    expect(CLAUDE_JUDGE_MODELS).toContain(DEFAULT_CLAUDE_JUDGE_MODEL);
  });

  it('refuses to start without a key or a model', () => {
    expect(() => new ClaudeJudge({ apiKey: '', model: 'claude-haiku-5-5' })).toThrow();
    expect(() => new ClaudeJudge({ apiKey: KEY, model: '' })).toThrow();
  });
});

describe('ClaudeJudge: an answer', () => {
  it('returns the answer text, the prompt version and the token usage', async () => {
    const { judge } = judgeWith(() => json(200, message()));
    const call = await judge.judge(INPUT);
    expect(call).toMatchObject({
      ok: true,
      judgeId: 'claude',
      model: DEFAULT_CLAUDE_JUDGE_MODEL,
      promptVersion: PROMPT_VERSION,
      answer: JSON.stringify(MATCH),
      usage: { inputTokens: 812, outputTokens: 143, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
  });

  it('reads the text block after a thinking block', async () => {
    const { judge } = judgeWith(() =>
      json(200, message({ content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: JSON.stringify(MATCH) }] })),
    );
    const call = await judge.judge(INPUT);
    expect(call.ok && call.answer).toBe(JSON.stringify(MATCH));
  });

  it('judgeListing verifies the answer: a verified match', async () => {
    const { judge } = judgeWith(() => json(200, message()));
    const out = await judgeListing(judge, INPUT);
    expect(out).toMatchObject({ kind: 'judged', verdict: 'match', claimed: 'match', itemId: INPUT.listing.itemId, promptVersion: PROMPT_VERSION });
  });

  it('judgeListing: a match the quotes do not support comes back unsure', async () => {
    const fabricated = { ...MATCH, evidence: [{ claim: 'identity', quote: 'Genuine RYOBI PCL206B bare tool, nothing else' }] };
    const { judge } = judgeWith(() => json(200, message({ content: [{ type: 'text', text: JSON.stringify(fabricated) }] })));
    const out = await judgeListing(judge, INPUT);
    expect(out.kind).toBe('judged');
    expect(out.kind === 'judged' && out.verdict).toBe('unsure');
  });

  it('judgeListing: malformed JSON from the model is unsure, not a failure', async () => {
    const { judge } = judgeWith(() => json(200, message({ content: [{ type: 'text', text: '{"verdict": "match"' }] })));
    const out = await judgeListing(judge, INPUT);
    expect(out).toMatchObject({ kind: 'judged', verdict: 'unsure', claimed: null });
  });
});

describe('ClaudeJudge: not judged', () => {
  const cases: [string, () => Response, string, number | undefined][] = [
    ['401', () => apiError(401, 'authentication_error', 'invalid x-api-key'), 'auth', 401],
    ['403', () => apiError(403, 'permission_error', 'not allowed'), 'auth', 403],
    ['429', () => apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': '20' }), 'rate_limited', 429],
    ['500', () => apiError(500, 'api_error', 'internal'), 'server', 500],
    ['503', () => new Response('<html>bad gateway</html>', { status: 503 }), 'server', 503],
    ['529', () => apiError(529, 'overloaded_error', 'overloaded'), 'overloaded', 529],
    ['400', () => apiError(400, 'invalid_request_error', 'output_config.format: bad schema'), 'bad_request', 400],
    ['404', () => apiError(404, 'not_found_error', 'model: claude-haiku-5-5'), 'http', 404],
    ['refusal', () => json(200, message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' }, content: [] })), 'refusal', undefined],
    ['max_tokens', () => json(200, message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"evidence": [' }] })), 'max_tokens', undefined],
    ['pause_turn', () => json(200, message({ stop_reason: 'pause_turn' })), 'unexpected_stop', undefined],
    ['no text block', () => json(200, message({ content: [{ type: 'thinking', thinking: '', signature: 'x' }] })), 'no_answer', undefined],
    ['a body that is not JSON', () => new Response('not json', { status: 200 }), 'bad_response', undefined],
    ['a body that is not a message', () => json(200, { hello: 'world' }), 'bad_response', undefined],
  ];

  it.each(cases)('%s → not judged, typed, called once, key not in the message', async (_label, respond, reason, status) => {
    const { judge, calls } = judgeWith(respond);
    const call = await judge.judge(INPUT);
    expect(calls).toHaveLength(1); // no retries
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.notJudged.reason).toBe(reason);
    expect(call.notJudged.status).toBe(status);
    expect(call.notJudged.message).toMatch(/\S/);
    expect(call.notJudged.message).not.toContain(KEY);
    const out = await judgeListing(judgeWith(respond).judge, INPUT);
    expect(out.kind).toBe('not_judged');
    expect('verdict' in out).toBe(false);
  });

  it('429 carries the wait the API asked for', async () => {
    const { judge } = judgeWith(() => apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': '20' }));
    const call = await judge.judge(INPUT);
    expect(!call.ok && call.notJudged.retryAfterSeconds).toBe(20);
  });

  it('a refusal keeps its category and the tokens it cost', async () => {
    const { judge } = judgeWith(() =>
      json(200, message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' }, content: [] })),
    );
    const call = await judge.judge(INPUT);
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.notJudged.refusalCategory).toBe('cyber');
    expect(call.usage).toEqual({ inputTokens: 812, outputTokens: 143, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  });

  it('a network failure is not judged, without the error text', async () => {
    const { judge, calls } = judgeWith(() => {
      throw new TypeError(`Failed to fetch ${KEY}`);
    });
    const call = await judge.judge(INPUT);
    expect(calls).toHaveLength(1);
    expect(!call.ok && call.notJudged.reason).toBe('network');
    expect(!call.ok && call.notJudged.message).not.toContain(KEY);
  });

  it('an abort is not judged', async () => {
    const { judge } = judgeWith(() => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const call = await judge.judge(INPUT);
    expect(!call.ok && call.notJudged.reason).toBe('aborted');
  });

  it('an API error message that echoes the key is not passed on', async () => {
    const { judge } = judgeWith(() => apiError(400, 'invalid_request_error', `bad key ${KEY}`));
    const call = await judge.judge(INPUT);
    expect(!call.ok && call.notJudged.message).not.toContain(KEY);
  });
});
