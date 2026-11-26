// Acting from Telegram (agent/telegramBot.ts): who may act, a button that works once, the purchase's confirm step, a Review
// answer through the app's own code, Scan now that keeps the reserve, the chat found for a token saved without one, and the
// token in no output. The owner's app after scan 6 (fixtures/e2e-2026-11-23/after-scan6): the three PSK1212SB BOGO pairs
// worth buying now, 24 open questions. A fake Telegram (any other host fails the test) and a fake clock. No network.

import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActivityResponse, OutcomesResponse, TelegramChatResponse } from '../../core/src/api/contract';
import type { OutgoingTelegram } from '../alerts';
import { createAgent, type Agent } from '../app';
import type { PendingMessage, TelegramAbout } from '../store';
import { BUTTON_TTL_MS, TelegramBot, type TgUpdate } from '../telegramBot';

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan6');
const fixture = (name: string) => JSON.parse(readFileSync(join(DIR, 'store', `${name}.json`), 'utf8'));
const TOKEN = '777001:tg-SECRET-token-xyz123';
const SECRET = 'tg-SECRET-token-xyz123';
const CHAT = '4242';
/** The owner's local noon on Nov 25 (the deals were stored on Nov 24). */
const T0 = new Date(2026, 10, 25, 12).getTime();
const SAW = 'homedepot:341966856'; // RYOBI PSK1212SB-PCL515B, $99, est. +$43.19
const LIGHT = 'homedepot:344305163'; // PSK1212SB-PCL633B
const INFLATOR = 'homedepot:341965772'; // PSK1212SB-PCL031B
const SAW_LINK = 'https://www.homedepot.com/p/RYOBI-ONE-18V-Kit-w-4-0-Ah-Battery-2-0-Ah-Battery-Charger-FREE-ONE-Cordless-Reciprocating-Saw-PSK1212SB-PCL515B/341966856';
const QUESTION = 'split:homedepot:324811429'; // What is inside the DEWALT DCK225D2WCS380B? One reading: DCK225D2, DCS380B.

let agent: Agent;
let server: Server;
let base: string;
let clock: number;
let calls: { method: string; body: Record<string, unknown> }[];
let others: string[];
let updates: unknown[][];
let logs: string[];
let hang: boolean;
let getUpdates: { status: number; body: unknown } | null;
let nextUpdate = 1000;
let scans: number;

const json = (result: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { ok: true, result } : result), { status });

const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(typeof input === 'string' || input instanceof URL ? input : input.url));
  if (url.hostname !== 'api.telegram.org') {
    others.push(url.hostname);
    return new Response('{}', { status: 500 });
  }
  const method = url.pathname.split('/').pop()!;
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ method, body });
  if (method === 'getUpdates') {
    if (getUpdates) return new Response(JSON.stringify(getUpdates.body), { status: getUpdates.status });
    if (hang) {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(new Error('aborted'));
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return json(updates.shift() ?? []);
  }
  if (method === 'sendMessage') return json({ message_id: 900 + calls.length, chat: { id: Number(CHAT), type: 'private' }, text: body.text });
  if (method === 'getMe') return json({ username: 'split_finder_bot' });
  if (method === 'getChat') return json({ id: Number(CHAT), type: 'private' });
  return json(true);
}) as typeof fetch;

const settle = () => new Promise((r) => setTimeout(r, 60));
/** The collections each test starts from (taken once the agent has settled on the owner's data). */
let initial: Record<string, unknown>;
const RESET = ['agent', 'settings', 'keys', 'review', 'activity', 'answers', 'runtime', 'outcomes'] as const;

// One agent for the file: its start pass over the owner's scan store is the slow part (seconds, more on a busy machine).
// Each test starts from the same collections (beforeEach) and leaves the scan store as it found it (an answer is undone).
beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sf-tgbot-'));
  cpSync(join(DIR, 'scan'), join(dataDir, 'scan'), { recursive: true });
  server = createServer();
  // A busy machine can leave a kept-alive connection idle past Node's 5 s; the client would reuse a socket the server closed.
  server.keepAliveTimeout = 120_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  clock = T0;
  calls = [];
  others = [];
  agent = createAgent({ dataDir, port, timers: false, fetchFn, now: () => clock });
  server.on('request', agent.handle);
  // The start's own pass over the scan store, then the review rebuilt from it (what the answers are checked against).
  await settle();
  await agent.work.idle();
  await agent.work.refresh();
  agent.store.update('settings', (s) => ({ ...s, alerts: { ...s.alerts, enabled: true, minProfit: 20, minRoiPercent: 20, minMonthlySold: 50 }, notifications: { ...s.notifications, telegramActions: true } }));
  agent.store.update('keys', (k) => ({ ...k, telegram: { botToken: TOKEN, chatId: CHAT } }));
  initial = Object.fromEntries(RESET.map((n) => [n, structuredClone(agent.store.get(n))]));
  // Scan now is the app's own (work.scanNow); here it only counts, so no scan runs.
  agent.work.scanNow = () => ((scans += 1), { id: `scan-${clock}`, requestedAt: new Date(clock).toISOString() });
  (agent.telegram as unknown as { log: (l: string) => void }).log = (l) => logs.push(l);
}, 180_000);

afterAll(async () => {
  agent.telegram.stop();
  await agent.work.idle();
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  clock = T0;
  calls = [];
  others = [];
  updates = [];
  logs = [];
  hang = false;
  getUpdates = null;
  scans = 0;
  for (const n of RESET) agent.store.update(n, () => structuredClone(initial[n]) as never);
  // The owner's deals and watchlist as his app stored them after scan 6 (the start cannot judge them: no Keepa trends here).
  agent.store.update('deals', () => fixture('deals'));
  agent.store.update('tracking', (t) => ({ ...t, ...fixture('tracking'), sanityCleared: [] }));
  calls.length = 0;
});

afterEach(async () => {
  agent.telegram.stop();
  await agent.telegram.idle();
  await agent.work.idle();
  expect(others).toEqual([]);
});

const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
const post = (path: string, body: unknown = {}) => ui(path, { method: 'POST', body: JSON.stringify(body) });
const activity = async () => (await (await ui('/api/activity')).json()) as ActivityResponse;

const message = (about: TelegramAbout[], text = 'Split Finder'): PendingMessage => ({ text, at: new Date(clock).toISOString(), tries: 0, about });
type Flat = { text: string; data?: string; url?: string };
const buttons = (m: OutgoingTelegram | undefined): Flat[] =>
  (m?.reply_markup?.inline_keyboard ?? []).flat().map((b) => ('url' in b ? { text: b.text, url: b.url } : { text: b.text, data: b.callback_data }));
const data = (m: OutgoingTelegram | undefined, text: string): string => buttons(m).find((b) => b.text === text)!.data!;

const owner = { id: Number(CHAT), type: 'private' };
/** A press in the owner's chat, as Telegram delivers it. */
const pressUpdate = (callbackData: string, text = 'Split Finder', from = { id: Number(CHAT) }, chat: Record<string, unknown> = owner): TgUpdate => ({
  update_id: nextUpdate++,
  callback_query: { id: `cq-${nextUpdate}`, from, message: { message_id: 77, chat, text }, data: callbackData },
});
const press = (callbackData: string, text?: string) => agent.telegram.handleUpdate(pressUpdate(callbackData, text));
const say = (text: string, chat: Record<string, unknown> = owner, from: Record<string, unknown> = { id: Number(CHAT) }) =>
  agent.telegram.handleUpdate({ update_id: nextUpdate++, message: { message_id: 5, date: Math.floor(clock / 1000), chat, from, text } });
const of = (method: string) => calls.filter((c) => c.method === method);
const lastAnswer = () => of('answerCallbackQuery').at(-1)?.body.text as string | undefined;
const lastEdit = () => of('editMessageText').at(-1)?.body as { text: string; reply_markup: { inline_keyboard: { text: string; callback_data?: string }[][] } } | undefined;
const sentTexts = () => of('sendMessage').map((c) => c.body.text as string);

describe('who may act', () => {
  it('only the saved chat, in a private chat: another chat, a group with the saved id and a bot are ignored, unanswered, one developer line each', async () => {
    const scan = agent.telegram.compose(message([{ kind: 'scan' }]))[0];
    const pause = data(scan, 'Pause scans');
    await say('/pause', { id: 99, type: 'private' }, { id: 99 });
    await say('/pause', { id: Number(CHAT), type: 'group' });
    await say('/pause', owner, { id: Number(CHAT), is_bot: true });
    await agent.telegram.handleUpdate(pressUpdate(pause, 'x', { id: 99 }, { id: 99, type: 'private' }));
    await agent.telegram.handleUpdate(pressUpdate(pause, 'x', { id: Number(CHAT) }, { id: Number(CHAT), type: 'supergroup' }));
    expect(agent.store.get('agent').paused).toBe(false);
    expect(calls).toEqual([]);
    expect(logs).toHaveLength(5);
    expect(logs.every((l) => /^Telegram: ignored a (message|button press) that is not from your chat\.$/.test(l))).toBe(true);
    // The button was never spent: the owner's own press still works.
    await press(pause);
    expect(agent.store.get('agent').paused).toBe(true);
  });
});

describe('a button works once', () => {
  it('a press is answered, edits its message to the result, and spends the message’s other buttons; a repeat does nothing', async () => {
    const scan = agent.telegram.compose(message([{ kind: 'scan' }]))[0];
    expect(buttons(scan).map((b) => b.text)).toEqual(['Pause scans', 'Scan now']);
    await press(data(scan, 'Pause scans'), 'Scan finished.');
    expect(agent.store.get('agent').paused).toBe(true);
    expect(lastAnswer()).toMatch(/^Scans paused from Telegram/);
    expect(lastEdit()!.text).toBe('Scan finished.\n\nScans paused from Telegram. No scheduled scan runs until you resume.');
    expect(lastEdit()!.reply_markup.inline_keyboard.flat().map((b) => b.text)).toEqual(['Resume']);

    await press(data(scan, 'Pause scans'));
    expect(lastAnswer()).toBe('That was done already.');
    await press(data(scan, 'Scan now'));
    expect(lastAnswer()).toBe('That was done already.');
    expect(scans).toBe(0);
    expect((await activity()).fromTelegram!.map((e) => e.sentence)).toEqual(['Paused scans from Telegram.']);
  });

  it('the offset is stored before an update is handled: the same update again, or after a restart, is not handled twice', async () => {
    const scan = agent.telegram.compose(message([{ kind: 'scan' }]))[0];
    const update = pressUpdate(data(scan, 'Pause scans'));
    updates.push([update]);
    expect(await agent.telegram.pollOnce()).toBe('ok');
    expect(agent.store.get('runtime').telegramBot!.offset).toBe(update.update_id + 1);
    expect(of('answerCallbackQuery')).toHaveLength(1);

    // A new reader (the agent restarted) asks from the stored offset; Telegram sending the old update anyway changes nothing.
    const again = new TelegramBot({ store: agent.store, now: () => clock, fetchFn, work: agent.work, outcomes: { record: () => { throw new Error('no'); }, undo: () => { throw new Error('no'); } }, pause: () => { throw new Error('paused twice'); }, resume: () => {} });
    updates.push([update]);
    expect(await again.pollOnce()).toBe('ok');
    expect(of('getUpdates').at(-1)!.body).toMatchObject({ offset: update.update_id + 1, timeout: 50, allowed_updates: ['message', 'callback_query'] });
    expect(of('answerCallbackQuery')).toHaveLength(1);
    expect((await activity()).fromTelegram).toHaveLength(1);
  });

  it('an expired button and a forged one do nothing', async () => {
    const scan = agent.telegram.compose(message([{ kind: 'scan' }]))[0];
    clock += BUTTON_TTL_MS + 1;
    await press(data(scan, 'Pause scans'));
    expect(lastAnswer()).toMatch(/^This button has expired\. Nothing was done/);
    expect(of('editMessageReplyMarkup').at(-1)!.body).toMatchObject({ reply_markup: { inline_keyboard: [] } });
    for (const forged of ['sf:AAAAAAAAAAAAAAAA', 'sf:../../keys', '{"do":"pause"}', 'pause']) {
      await press(forged);
      expect(lastAnswer()).toBe('This button is not one the app knows. Nothing was done.');
    }
    expect(agent.store.get('agent').paused).toBe(false);
    expect(of('editMessageText')).toEqual([]);
  });
});

describe('a deal entering Buy now', () => {
  it('the digest carries the top deal’s buttons, and each further deal follows with its own', async () => {
    const out = agent.telegram.compose(message([{ kind: 'buyNow', keys: [SAW, LIGHT, INFLATOR] }, { kind: 'scan' }], '3 deals worth buying now. Top: RYOBI PSK1212SB-PCL515B …'));
    expect(out).toHaveLength(3);
    expect(buttons(out[0]).map((b) => b.text)).toEqual(['I bought this', 'Not for me', 'Open Home Depot', 'Pause scans', 'Scan now']);
    expect(buttons(out[0]).find((b) => b.text === 'Open Home Depot')!.url).toBe(SAW_LINK);
    expect(out[1]!.text).toBe('Also worth buying now: RYOBI PSK1212SB-PCL633B, est. profit $38.79 (39% ROI) at $99.00. An estimate from your fee settings, before sales tax and inbound shipping.');
    expect(buttons(out[2]).map((b) => b.text)).toEqual(['I bought this', 'Not for me', 'Open Home Depot']);
    // Off: the text alone.
    agent.store.update('settings', (s) => ({ ...s, notifications: { ...s.notifications, telegramActions: false } }));
    expect(agent.telegram.compose(message([{ kind: 'buyNow', keys: [SAW] }]))).toEqual([{ text: 'Split Finder' }]);
  });

  it('the digest after a scan goes out with them (sendMessage’s reply_markup)', async () => {
    await (agent.work as unknown as { sendTelegram(t: string, a: TelegramAbout[]): Promise<string | null> }).sendTelegram('Scan done.', [{ kind: 'buyNow', keys: [SAW] }, { kind: 'scan' }]);
    const body = of('sendMessage')[0]!.body as { chat_id: string; reply_markup: { inline_keyboard: unknown[][] } };
    expect(body.chat_id).toBe(CHAT);
    expect(body.reply_markup.inline_keyboard.flat()).toHaveLength(5);
  });

  it('I bought this asks once more, then records it through the app’s own code with the estimate frozen, with Undo', async () => {
    const out = agent.telegram.compose(message([{ kind: 'buyNow', keys: [SAW] }]));
    await press(data(out[0], 'I bought this'));
    expect((await (await ui('/api/outcomes')).json() as OutcomesResponse).purchases).toEqual([]);
    expect(lastEdit()!.text).toBe('Split Finder\n\nI bought this: confirm below.');
    const ask = of('sendMessage').at(-1)!.body as { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
    expect(ask.text).toBe('Record 1 bought at $99.00 today (Nov 25)? RYOBI PSK1212SB-PCL515B.');
    const yes = ask.reply_markup.inline_keyboard.flat().find((b) => b.text === 'Yes')!.callback_data;
    expect(ask.reply_markup.inline_keyboard.flat().map((b) => b.text)).toEqual(['Yes', 'Change in the app']);

    await press(yes, ask.text);
    const { purchases } = (await (await ui('/api/outcomes')).json()) as OutcomesResponse;
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({ dealId: SAW, boughtAt: '2026-11-25', pricePaid: 99, quantity: 1 });
    expect(purchases[0]!.snapshot.estimate).toMatchObject({ profit: 43.19, cost: 99 });
    expect(lastEdit()!.text).toMatch(/Recorded from Telegram: 1 bought at \$99\.00 on Nov 25\. Its estimate is kept as it stood: est\. profit \$43\.19 \(an estimate from your fee settings, before sales tax and inbound shipping\)\.$/);
    const entry = (await activity()).outcomes![0]!;
    expect(entry.sentence).toBe('Recorded a purchase: 1 bundle of PSK1212SB-PCL515B at $99.00 each on Nov 25, from Telegram.');
    expect(entry.undoable).toBe(true);

    // The same as the app's "I bought this" on the same deal (POST /api/outcomes), but for who said it.
    const app = (await (await post('/api/outcomes', { dealId: SAW, boughtAt: '2026-11-25', pricePaid: 99, quantity: 1 })).json()) as { purchase: { snapshot: unknown }; entryId: string };
    expect(app.purchase.snapshot).toEqual(purchases[0]!.snapshot);
    await post(`/api/outcomes/entries/${app.entryId}/undo`);

    const undo = lastEdit()!.reply_markup.inline_keyboard.flat().find((b) => b.text === 'Undo')!.callback_data!;
    await press(undo);
    expect(lastEdit()!.text).toMatch(/Undone: the purchase is no longer recorded\.$/);
    expect(((await (await ui('/api/outcomes')).json()) as OutcomesResponse).purchases).toEqual([]);
    // Yes once more does nothing.
    await press(yes);
    expect(lastAnswer()).toBe('That was done already.');
  });

  it('Not for me stops watching it, is in Activity from Telegram, and the app’s Undo watches it again', async () => {
    const before = agent.store.get('tracking').watch[SAW];
    const out = agent.telegram.compose(message([{ kind: 'buyNow', keys: [SAW] }]));
    await press(data(out[0], 'Not for me'));
    expect(agent.store.get('tracking').watch[SAW]).toMatchObject({ watched: false, by: 'owner' });
    const [entry] = (await activity()).fromTelegram!;
    expect(entry).toMatchObject({ sentence: 'Not for me, from Telegram: stopped watching RYOBI PSK1212SB-PCL515B, so it is not announced again.', undoable: true });
    const res = await post(`/api/telegram/actions/${entry!.id}/undo`);
    expect(res.status).toBe(200);
    expect(agent.store.get('tracking').watch[SAW]).toEqual(before);
    expect((await activity()).fromTelegram![0]).toMatchObject({ undoable: false, undoneAt: expect.any(String) });
    expect((await post(`/api/telegram/actions/${entry!.id}/undo`)).status).toBe(409);
  });
});

describe('a Review question with choices', () => {
  it('the question in a few lines with its source, a button per choice and Skip; an answer goes through the app’s route logic, with Undo', async () => {
    const out = agent.telegram.compose(message([{ kind: 'questions', ids: [QUESTION, 'split:homedepot:328690517'] }]));
    // The second has no choice to press: no message for it.
    expect(out).toHaveLength(2);
    const q = out[1]!;
    expect(q.text.split('\n')[0]).toMatch(/^Review: What is inside the DEWALT DCK225D2WCS380B\? model number says DCK225D2, DCS380B; page names DCD708B, DCF809B/);
    expect(q.text).toContain('1. DCK225D2, DCS380B');
    expect(q.text).toContain('Home Depot: DEWALT DCK225D2WCS380B: https://www.homedepot.com/p/');
    expect(buttons(q).map((b) => b.text)).toEqual(['1. DCK225D2, DCS380B', 'Skip']);

    // Free text never answers a question.
    await say('1');
    expect((await agent.work.scanStore.getReview(QUESTION))!.answer).toBeNull();

    await press(data(q, '1. DCK225D2, DCS380B'), q.text);
    expect((await agent.work.scanStore.getReview(QUESTION))!.answer).toBe('DCK225D2,DCS380B');
    expect(lastEdit()!.text).toMatch(/Saved: DCK225D2, DCS380B \(from Telegram\)\. The deal’s estimate follows it\.$/);
    expect((await activity()).answers![0]).toMatchObject({ questionId: QUESTION, answer: 'DCK225D2, DCS380B (from Telegram)', undoable: true });

    const undo = lastEdit()!.reply_markup.inline_keyboard.flat().find((b) => b.text === 'Undo')!.callback_data!;
    await press(undo);
    expect((await agent.work.scanStore.getReview(QUESTION))!.answer).toBeNull();
    expect(lastEdit()!.text).toMatch(/Undone: the question is open again in Review\.$/);
  });

  it('a question that changed since the message was sent is refused by the same check as the app', async () => {
    const out = agent.telegram.compose(message([{ kind: 'questions', ids: [QUESTION] }]));
    const choice = data(out[1], '1. DCK225D2, DCS380B');
    // The owner answers in the app first.
    expect((await post(`/api/review/${encodeURIComponent(QUESTION)}/answer`, { answer: { choice: 0 } })).status).toBe(200);
    await press(choice);
    expect(lastEdit()!.text).toMatch(/Not done: .+ Nothing was changed; do it in the app\.$/);
    const answered = agent.store.get('answers').filter((a) => a.questionId === QUESTION);
    expect(answered).toHaveLength(1);
    // The scan store as it was, for the next test.
    expect((await post(`/api/review/${answered[0]!.id}/undo`)).status).toBe(200);
  });

  it('Skip leaves it open', async () => {
    const out = agent.telegram.compose(message([{ kind: 'questions', ids: [QUESTION] }]));
    await press(data(out[1], 'Skip'));
    expect(lastEdit()!.text).toMatch(/Skipped\. It waits in Review\.$/);
    expect((await agent.work.scanStore.getReview(QUESTION))!.answer).toBeNull();
  });
});

describe('scans, costs and the reserve', () => {
  const serp = (left: number) => agent.store.update('runtime', (r) => ({ ...r, serp: { left, perMonth: 250, rateLimitPerHour: 50, at: new Date(clock).toISOString() } }));
  beforeEach(() => {
    agent.store.update('keys', (k) => ({ ...k, serpapi: 'serp-key-for-tests' }));
    agent.store.update('settings', (s) => ({ ...s, settings: { ...s.settings, reserve: 100, searchesPerScan: 20 } }));
  });

  it('Scan now at or below the reserve spends none and starts at once', async () => {
    serp(80);
    const out = agent.telegram.compose(message([{ kind: 'scan' }]));
    await press(data(out[0], 'Scan now'));
    expect(scans).toBe(1);
    expect(lastEdit()!.text).toMatch(/Scan started from Telegram\. It spends no searches: 80 left is at or below your reserve of 100\.$/);
  });

  it('above the reserve it says what it may spend and waits for Yes', async () => {
    serp(150);
    const out = agent.telegram.compose(message([{ kind: 'scan' }]));
    await press(data(out[0], 'Scan now'));
    expect(scans).toBe(0);
    const ask = of('sendMessage').at(-1)!.body as { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
    expect(ask.text).toBe('This scan may spend up to 20 searches (150 left; your reserve of 100 is kept). Keepa and AI stay within your limits in Costs. Start it?');
    await press(ask.reply_markup.inline_keyboard.flat().find((b) => b.text === 'Yes, scan')!.callback_data, ask.text);
    expect(scans).toBe(1);
  });

  it('a balance from last month is not known: it asks', async () => {
    agent.store.update('runtime', (r) => ({ ...r, serp: { left: 10, perMonth: 250, rateLimitPerHour: 50, at: new Date(2026, 9, 30).toISOString() } }));
    const out = agent.telegram.compose(message([{ kind: 'scan' }]));
    await press(data(out[0], 'Scan now'));
    expect(scans).toBe(0);
    expect(sentTexts().at(-1)).toMatch(/^This scan may spend up to 20 searches \(10 left; your reserve of 100 is kept\)/);
  });

  it('a cost message has Open Costs only, and it changes nothing', async () => {
    const out = agent.telegram.compose(message([{ kind: 'costs' }], 'AI: held back. …'));
    expect(buttons(out[0]).map((b) => b.text)).toEqual(['Open Costs']);
    const before = JSON.stringify(agent.store.get('settings'));
    await press(data(out[0], 'Open Costs'));
    expect(lastEdit()!.text).toMatch(/Costs change only in the app on your computer: Costs\./);
    expect(JSON.stringify(agent.store.get('settings'))).toBe(before);
  });

  it('nothing from the phone changes a key, a limit, the reserve or a setting, or spends a search', async () => {
    serp(80);
    const keys = JSON.stringify(agent.store.get('keys'));
    const settings = JSON.stringify(agent.store.get('settings'));
    for (const t of ['/status', '/pause', '/resume', '/help', '/start', '/reserve 0', '/setkey abc', 'set reserve to 0', '/settings', '/limit 1000']) await say(t);
    const all = agent.telegram.compose(message([{ kind: 'buyNow', keys: [SAW] }, { kind: 'questions', ids: [QUESTION] }, { kind: 'costs' }, { kind: 'scan' }]));
    for (const m of all) for (const b of buttons(m)) if (b.data && b.text !== 'I bought this' && !b.text.startsWith('1.')) await press(b.data);
    expect(JSON.stringify(agent.store.get('keys'))).toBe(keys);
    expect(JSON.stringify(agent.store.get('settings'))).toBe(settings);
    expect(others).toEqual([]);
    // The unknown lines got one answer in the hour.
    expect(sentTexts().filter((t) => t.startsWith('I take /status'))).toHaveLength(1);
  });
});

describe('commands', () => {
  it('/status: Buy now with the best, open questions, searches left, the month’s costs, the next scan; estimates labelled', async () => {
    agent.store.update('runtime', (r) => ({ ...r, serp: { left: 80, perMonth: 250, rateLimitPerHour: 50, at: new Date(clock).toISOString() } }));
    await say('/status');
    const text = sentTexts().at(-1)!;
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Worth buying now: 3 deals\. Best: RYOBI PSK1212SB-PCL515B, est\. profit \$43\.19 \(44% ROI\)\.$/);
    expect(lines[1]).toMatch(/^Open questions: \d+\.$/);
    expect(lines[2]).toBe(`Searches left: 80 (you keep ${agent.store.get('settings').settings.reserve}).`);
    expect(lines[3]).toMatch(/^This month: /);
    expect(lines[4]).toMatch(/^(Next scan: |No scan is scheduled|Scans are paused)/);
    expect(lines[5]).toBe('Profit figures are estimates from your fee settings, not your real fees, before sales tax and inbound shipping.');
  });

  it('/status with two SerpApi keys: the total, then each key by its label (never a key)', async () => {
    const at = new Date(clock).toISOString();
    agent.store.update('keys', (k) => ({
      ...k, serpapi: 'serp-one-for-tests-0000',
      serpapiKeys: [
        { id: 'serpapi-1', label: 'Key 1', addedAt: null, key: 'serp-one-for-tests-0000' },
        { id: 'serpapi-b', label: 'Partner', addedAt: at, key: 'serp-two-for-tests-0000' },
      ],
    }));
    agent.store.update('runtime', (r) => ({
      ...r,
      serp: { left: 203, perMonth: 500, rateLimitPerHour: 100, at },
      serpKeys: { 'serpapi-1': { left: 60, perMonth: 250, rateLimitPerHour: 50, at }, 'serpapi-b': { left: 143, perMonth: 250, rateLimitPerHour: 50, at } },
    }));
    await say('/status');
    const text = sentTexts().at(-1)!;
    expect(text.split('\n')[2]).toBe(`Searches left: 203 across 2 keys: Key 1 60, Partner 143 (you keep ${agent.store.get('settings').settings.reserve}).`);
    expect(text).not.toContain('serp-one');
    expect(text).not.toContain('serp-two');
  });

  it('/pause and /resume through the app’s own pause, in Activity with Undo; a problem the app paused for is not resumed from the phone', async () => {
    await say('/pause');
    expect(agent.store.get('agent').paused).toBe(true);
    await say('/resume');
    expect(agent.store.get('agent').paused).toBe(false);
    expect((await activity()).fromTelegram!.map((e) => e.sentence)).toEqual(['Resumed scans from Telegram.', 'Paused scans from Telegram.']);
    agent.store.update('agent', (a) => ({ ...a, paused: true, problem: 'Saved data could not be read.' }));
    await say('/resume');
    expect(agent.store.get('agent').paused).toBe(true);
    expect(sentTexts().at(-1)).toMatch(/^The app paused itself: Saved data could not be read\. Resume it in the app/);
  });

  it('a command older than an hour (the computer slept) is not acted on', async () => {
    await agent.telegram.handleUpdate({ update_id: nextUpdate++, message: { message_id: 1, date: Math.floor(clock / 1000) - 7200, chat: owner, from: { id: Number(CHAT) }, text: '/pause' } });
    expect(agent.store.get('agent').paused).toBe(false);
  });
});

describe('the reader', () => {
  it('runs only while a key is saved and the setting is on, and stops when either goes', async () => {
    hang = true;
    agent.telegram.start();
    expect(agent.telegram.polling).toBe(true);
    await settle();
    expect(of('getUpdates')).toHaveLength(1);

    agent.store.update('settings', (s) => ({ ...s, notifications: { ...s.notifications, telegramActions: false } }));
    await agent.telegram.idle();
    expect(agent.telegram.polling).toBe(false);

    agent.store.update('settings', (s) => ({ ...s, notifications: { ...s.notifications, telegramActions: true } }));
    expect(agent.telegram.polling).toBe(true);
    agent.store.update('keys', (k) => {
      const { telegram: _t, ...rest } = k;
      return rest;
    });
    await agent.telegram.idle();
    expect(agent.telegram.polling).toBe(false);
    const n = of('getUpdates').length;
    await settle();
    expect(of('getUpdates')).toHaveLength(n);
  });

  it('a refused token stops reading until the key changes, and no output holds the token', async () => {
    getUpdates = { status: 401, body: { ok: false, error_code: 401, description: `Unauthorized: bot${TOKEN} is not valid (${SECRET})` } };
    agent.telegram.start();
    await agent.telegram.idle();
    expect(agent.telegram.polling).toBe(false);
    expect(of('getUpdates')).toHaveLength(1);
    const outputs = JSON.stringify({ logs, runtime: agent.store.get('runtime'), activity: agent.store.get('activity'), state: await (await ui('/api/state')).json() });
    expect(outputs).not.toContain(SECRET);
    expect(outputs).not.toContain('777001:');
    expect(agent.store.get('runtime').telegramBot!.lastError).toMatch(/^Telegram refused getUpdates \(HTTP 401: Unauthorized: bot\[token\] is not valid \(\[token\]\)\)\.$/);
  });

  it('a fetch that fails with the address in its error says only that Telegram could not be reached, and backs off', async () => {
    const waits: number[] = [];
    const failing = (async () => {
      throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getUpdates`);
    }) as unknown as typeof fetch;
    let rounds = 0;
    const bot = new TelegramBot({
      store: agent.store, now: () => clock, fetchFn: failing, work: agent.work, outcomes: { record: () => { throw new Error(); }, undo: () => { throw new Error(); } },
      pause: () => {}, resume: () => {}, log: (l) => logs.push(l),
      sleep: async (ms) => {
        waits.push(ms);
        if (++rounds >= 4) bot.stop();
      },
    });
    bot.start();
    await bot.idle();
    expect(waits).toEqual([5_000, 15_000, 60_000, 300_000]);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(logs.at(-1)).toBe('Telegram: reading the chat failed. Telegram could not be reached.');
  });
});

describe('finding the chat for a token saved without one', () => {
  const chatState = async () => (await (await ui('/api/telegram/chat')).json()) as TelegramChatResponse;
  const hello = (chat: Record<string, unknown>, text = 'hi'): TgUpdate => ({ update_id: nextUpdate++, message: { message_id: 1, date: Math.floor(clock / 1000), chat, from: { id: chat.id }, text } });

  beforeEach(async () => {
    const res = await ui('/api/keys/telegram', { method: 'PUT', body: JSON.stringify({ botToken: TOKEN }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { check: { ok: boolean } }).check.ok).toBe(true);
    calls.length = 0;
  });

  it('no message yet: it waits, and the keys say the bot waits for its chat', async () => {
    updates.push([]);
    expect(await agent.telegram.pollOnce()).toBe('ok');
    expect(await chatState()).toEqual({ state: 'waiting', chats: [] });
    const state = (await (await ui('/api/state')).json()) as { keys: Record<string, boolean> };
    expect(state.keys).toMatchObject({ telegram: false, telegramWaitingForChat: true });
  });

  it('one private chat is offered by name and saved only when chosen; then the test message goes to it', async () => {
    updates.push([hello({ id: 5150, type: 'private', first_name: 'Angelo', username: 'angelo' }, '/pause')]);
    await agent.telegram.pollOnce();
    // Nothing is acted on and nothing is answered while no chat is chosen.
    expect(agent.store.get('agent').paused).toBe(false);
    expect(of('sendMessage')).toEqual([]);
    expect(agent.store.get('keys').telegram!.chatId).toBe('');
    expect(await chatState()).toEqual({ state: 'found', chats: [{ id: '5150', name: 'Angelo @angelo', at: new Date(clock).toISOString() }] });

    const res = await post('/api/telegram/chat', { chatId: '5150' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ saved: true, test: { ok: true } });
    expect(agent.store.get('keys').telegram).toEqual({ botToken: TOKEN, chatId: '5150' });
    expect(of('sendMessage').at(-1)!.body).toMatchObject({ chat_id: '5150', text: expect.stringMatching(/^Split Finder can reach you here\.\n\nYou can act from here/) });
    expect(await chatState()).toEqual({ state: 'chosen', chats: [] });
  });

  it('a group chat is ignored; two private chats are both offered and neither is picked', async () => {
    updates.push([hello({ id: -100200, type: 'group', title: 'Shop' }), hello({ id: 5150, type: 'private', first_name: 'Angelo' }), hello({ id: 6000, type: 'private', first_name: 'Stranger' })]);
    await agent.telegram.pollOnce();
    expect((await chatState()).chats.map((c) => [c.id, c.name])).toEqual([['6000', 'Stranger'], ['5150', 'Angelo']]);
    expect(agent.store.get('keys').telegram!.chatId).toBe('');
  });

  it('only a chat that wrote to the bot can be chosen', async () => {
    updates.push([hello({ id: 5150, type: 'private', first_name: 'Angelo' })]);
    await agent.telegram.pollOnce();
    expect((await post('/api/telegram/chat', { chatId: '-100200' })).status).toBe(400);
    expect((await post('/api/telegram/chat', {})).status).toBe(400);
    expect(agent.store.get('keys').telegram!.chatId).toBe('');
  });

  it('the reader runs for a token without a chat whatever the setting, and stops once the chat is chosen with the setting off', async () => {
    agent.store.update('settings', (s) => ({ ...s, notifications: { ...s.notifications, telegramActions: false } }));
    hang = true;
    agent.telegram.start();
    expect(agent.telegram.polling).toBe(true);
    agent.store.update('keys', (k) => ({ ...k, telegram: { botToken: TOKEN, chatId: '5150' } }));
    await agent.telegram.idle();
    expect(agent.telegram.polling).toBe(false);
  });
});
