import { describe, expect, it } from 'vitest';

import type { BundleRow, ReviewItem } from '../../core/src/scan/types';
import { DEFAULT_SETTINGS } from '../../core/src/settings';
import { buildDigest, sendPending, sendTelegram } from '../alerts';

const alerts = { ...DEFAULT_SETTINGS.alerts, enabled: true, minProfit: 20, minRoiPercent: 20 };

const deal = (key: string, model: string, profit: number, roi: number, section: BundleRow['section'] = 'confirmed'): BundleRow =>
  ({ key, brand: 'DEWALT', model, section, estimate: { profit, roi, cost: 100, netRevenue: 100 + profit } }) as unknown as BundleRow;
const question = (id: string): ReviewItem => ({ id, kind: 'split', answer: null }) as unknown as ReviewItem;

describe('the digest: at most one message after a run', () => {
  it('names the new deals above the ROI threshold, the best first, labelled as estimates, and each deal once', () => {
    const report = {
      bundles: [deal('a', 'DCK240C2', 30, 0.25), deal('b', 'DCK283D2', 45.1, 0.34), deal('c', 'DCK2100D1T1', 5, 0.5), deal('d', 'DCK300', 60, 0.6, 'waiting')],
      review: [],
    };
    const first = buildDigest({ report, alerts, notifiedDeals: [], notifiedQuestions: [], autopilotApplied: 0, trendLines: [] });
    expect(first.event).toMatchObject({ kind: 'deal', count: 2, route: '/deals' });
    expect(first.text).toContain('2 new deals above 20% ROI');
    expect(first.text).toContain('Top: DEWALT DCK283D2, est. profit $45.10 (34% ROI)');
    expect(first.text).toMatch(/estimate/i);
    expect(first.notifiedDeals).toEqual(['b', 'a']);

    const again = buildDigest({ report, alerts, notifiedDeals: first.notifiedDeals, notifiedQuestions: [], autopilotApplied: 0, trendLines: [] });
    expect(again.event).toBeNull();
    expect(again.text).toBeNull();
  });

  it('says how many questions need the owner when one is new, and what Autopilot applied, in the same message', () => {
    const report = { bundles: [], review: [question('split:1'), question('match:2')] };
    const d = buildDigest({ report, alerts, notifiedDeals: [], notifiedQuestions: ['split:1'], autopilotApplied: 3, trendLines: [] });
    expect(d.event).toMatchObject({ kind: 'review', count: 2, route: '/review' });
    expect(d.text).toBe('2 questions need you.\nAutopilot applied 3 answers (Undo in Activity).');
    expect(d.notifiedQuestions).toEqual(['split:1', 'match:2']);
    const quiet = buildDigest({ report, alerts, notifiedDeals: [], notifiedQuestions: d.notifiedQuestions, autopilotApplied: 0, trendLines: [] });
    expect(quiet.event).toBeNull();
  });

  it('nothing when alerts are off, except what Autopilot did', () => {
    const report = { bundles: [deal('b', 'DCK283D2', 45, 0.34)], review: [question('split:1')] };
    const off = buildDigest({ report, alerts: { ...alerts, enabled: false, reviewDigest: false }, notifiedDeals: [], notifiedQuestions: [], autopilotApplied: 1, trendLines: [] });
    expect(off.text).toBe('Autopilot applied 1 answer (Undo in Activity).');
    expect(off.event).toMatchObject({ kind: 'autopilot', count: 1 });
  });
});

describe('Telegram (Bot API sendMessage)', () => {
  const keys = { botToken: '123:SECRET-TOKEN', chatId: '42' };

  it('posts chat_id and text as JSON to the bot address', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }) as typeof fetch;
    expect(await sendTelegram(fetchFn, keys, 'hello')).toEqual({ ok: true });
    expect(seen).toEqual([{ url: 'https://api.telegram.org/bot123:SECRET-TOKEN/sendMessage', body: { chat_id: '42', text: 'hello' } }]);
  });

  it('a refusal or a network failure is one sentence with no token in it, and the message waits for the next run', async () => {
    const refuse = (async () => new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized for 123:SECRET-TOKEN' }), { status: 401 })) as unknown as typeof fetch;
    const r = await sendTelegram(refuse, keys, 'hello');
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain('SECRET');
    const down = (async () => { throw new Error('getaddrinfo api.telegram.org/bot123:SECRET-TOKEN'); }) as unknown as typeof fetch;

    const first = await sendPending(down, keys, [], { text: 'run 1', at: 't1' });
    expect(first.sent).toBe(0);
    expect(first.pending).toEqual([{ text: 'run 1', at: 't1', tries: 1 }]);
    expect(first.error).not.toContain('SECRET');

    const sent: string[] = [];
    const up = (async (_u: string, init?: RequestInit) => {
      sent.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return new Response('{"ok":true,"result":{}}', { status: 200 });
    }) as typeof fetch;
    const second = await sendPending(up, keys, first.pending, { text: 'run 2', at: 't2' });
    expect(sent).toEqual(['run 1', 'run 2']);
    expect(second).toMatchObject({ sent: 2, pending: [], error: null });
  });
});
