// POST /api/notify/test-telegram: one test message through the same Telegram sender the digest uses, with the saved bot
// token and chat id. Answers { ok, problem? } with Telegram's refusal in plain words and never a key (rule 3). A fake fetch.

import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TelegramTestResponse } from '../../core/src/api/contract';
import { telegramProblemWords, testTelegram, TELEGRAM_TEST_TEXT } from '../alerts';
import { createAgent, type Agent } from '../app';

const TOKEN = '123456:SECRET-bot-token-abc';
const keys = { botToken: TOKEN, chatId: '42' };

const telegramSays = (status: number, body: Record<string, unknown>) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('testTelegram', () => {
  it('sends "Split Finder can reach you here." to the saved chat through the bot address', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response('{"ok":true,"result":{"message_id":1}}', { status: 200 });
    }) as typeof fetch;
    expect(await testTelegram(fetchFn, keys)).toEqual({ ok: true });
    expect(TELEGRAM_TEST_TEXT).toBe('Split Finder can reach you here.');
    expect(seen).toEqual([{ url: `https://api.telegram.org/bot${TOKEN}/sendMessage`, body: { chat_id: '42', text: 'Split Finder can reach you here.' } }]);
  });

  it('without a bot saved: says so, and sends nothing', async () => {
    let calls = 0;
    const fetchFn = (async () => ((calls += 1), new Response('{}'))) as unknown as typeof fetch;
    expect(await testTelegram(fetchFn, undefined)).toEqual({ ok: false, problem: 'Telegram is not set up. Add a bot token and chat id in Keys first.' });
    expect(calls).toBe(0);
  });

  it('Telegram’s refusals, recorded in its documented shape, in plain words with its own description', async () => {
    const cases: { status: number; description: string; says: RegExp }[] = [
      { status: 401, description: 'Unauthorized', says: /did not accept the bot token.*Telegram said: Unauthorized\./ },
      { status: 400, description: 'Bad Request: chat not found', says: /cannot find that chat id.*Telegram said: Bad Request: chat not found\./ },
      { status: 403, description: 'Forbidden: bot was blocked by the user', says: /not allowed to message this chat.*press Start/ },
      { status: 429, description: 'Too Many Requests: retry after 5', says: /wait a moment/ },
      { status: 500, description: 'Internal Server Error', says: /refused the message \(HTTP 500\)\. Telegram said: Internal Server Error\./ },
    ];
    for (const c of cases) {
      const r = await testTelegram(telegramSays(c.status, { ok: false, error_code: c.status, description: c.description }), keys);
      expect(r.ok).toBe(false);
      expect(r.problem, c.description).toMatch(c.says);
    }
  });

  it('no problem sentence holds the token or its secret half, even when Telegram echoes it', async () => {
    for (const echoed of [`Unauthorized for ${TOKEN}`, 'Unauthorized for SECRET-bot-token-abc', 'plain']) {
      const r = await testTelegram(telegramSays(401, { ok: false, error_code: 401, description: echoed }), keys);
      expect(JSON.stringify(r)).not.toContain('SECRET');
      expect(JSON.stringify(r)).not.toContain('123456:');
    }
  });

  it('Telegram unreachable: one sentence about the connection, no error text from the network layer', async () => {
    const down = (async () => {
      throw new Error(`getaddrinfo ENOTFOUND api.telegram.org/bot${TOKEN}`);
    }) as unknown as typeof fetch;
    const r = await testTelegram(down, keys);
    expect(r).toEqual({ ok: false, problem: 'Telegram could not be reached. Check this computer’s internet connection and try again.' });
    expect(telegramProblemWords(undefined, undefined)).toBe(r.problem);
  });
});

describe('POST /api/notify/test-telegram', () => {
  let server: Server;
  let agent: Agent;
  let base: string;
  let sent: string[];
  let reply: Response;

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
    sent = [];
    reply = new Response('{"ok":true,"result":{}}', { status: 200 });
    const fetchFn = (async (url: string, init?: RequestInit) => {
      sent.push(`${new URL(url).hostname} ${(JSON.parse(String(init?.body)) as { text: string }).text}`);
      return reply.clone();
    }) as unknown as typeof fetch;
    agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-tgtest-')), port, timers: false, fetchFn });
    server.on('request', agent.handle);
  });

  afterEach(async () => {
    agent.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (headers: Record<string, string> = { Authorization: `Bearer ${agent.auth.uiToken}` }) =>
    fetch(`${base}/api/notify/test-telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });

  it('without a token: refused, and nothing is sent', async () => {
    agent.store.update('keys', (k) => ({ ...k, telegram: { botToken: TOKEN, chatId: '42' } }));
    expect((await post({})).status).toBe(401);
    expect(sent).toEqual([]);
  });

  it('a wrong token is refused too', async () => {
    agent.store.update('keys', (k) => ({ ...k, telegram: { botToken: TOKEN, chatId: '42' } }));
    expect((await post({ Authorization: 'Bearer not-the-ui-token' })).status).toBe(401);
    expect(sent).toEqual([]);
  });

  it('with the bot saved: one message to Telegram, {ok: true}', async () => {
    agent.store.update('keys', (k) => ({ ...k, telegram: { botToken: TOKEN, chatId: '42' } }));
    const r = await post();
    expect(r.status).toBe(200);
    expect((await r.json()) as TelegramTestResponse).toEqual({ ok: true });
    expect(sent).toEqual(['api.telegram.org Split Finder can reach you here.']);
  });

  it('a refusal comes back as {ok: false, problem} with HTTP 200 and no key in the body', async () => {
    agent.store.update('keys', (k) => ({ ...k, telegram: { botToken: TOKEN, chatId: '42' } }));
    reply = new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }), { status: 400 });
    const r = await post();
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ ok: false, problem: expect.stringContaining('cannot find that chat id') });
    expect(text).not.toContain('SECRET');
  });

  it('with no bot saved: {ok: false, problem} and nothing sent', async () => {
    const r = await post();
    expect(await r.json()).toEqual({ ok: false, problem: 'Telegram is not set up. Add a bot token and chat id in Keys first.' });
    expect(sent).toEqual([]);
  });

  it('does not touch the digest queue or the last send', async () => {
    agent.store.update('keys', (k) => ({ ...k, telegram: { botToken: TOKEN, chatId: '42' } }));
    const before = JSON.stringify(agent.store.get('runtime').telegram);
    await post();
    expect(JSON.stringify(agent.store.get('runtime').telegram)).toBe(before);
  });
});
