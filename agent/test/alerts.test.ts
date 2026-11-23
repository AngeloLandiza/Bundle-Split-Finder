import { describe, expect, it } from 'vitest';

import type { BundleRow, ReviewItem } from '../../core/src/scan/types';
import { DEFAULT_SETTINGS } from '../../core/src/settings';
import { emptyTracking, freshSignals, trackReport } from '../../core/src/tracking/state';
import { ASIN, bundle, option, part, recordedTrend } from '../../core/test/tracking-world';
import { buildDigest, sendPending, sendTelegram } from '../alerts';

const alerts = { ...DEFAULT_SETTINGS.alerts, enabled: true, minProfit: 20, minRoiPercent: 20 };

const deal = (key: string, model: string, profit: number, roi: number, section: BundleRow['section'] = 'confirmed'): BundleRow =>
  ({ key, brand: 'DEWALT', model, section, estimate: { profit, roi, cost: 100, netRevenue: 100 + profit } }) as unknown as BundleRow;
const question = (id: string): ReviewItem => ({ id, kind: 'split', answer: null }) as unknown as ReviewItem;

describe('the digest: at most one message after a run', () => {
  it('names the deals worth buying now (not bare ROI), the top one with its reason, labelled as estimates, once a day', () => {
    const NOW = new Date(2026, 10, 23, 10).getTime();
    const good = bundle([option('whole', 299, [part('DCF921B', ASIN.DCF921B, 249), part('DCB606', ASIN.DCB606, 199)])]);
    // Above both numbers but no Keepa sales figure for a part: not worth buying now, so not in the message.
    const unsold = { ...bundle([option('whole', 299, [part('DCF921B', ASIN.DCF921B, 249), part('DCB205', 'B0NOTPULLED', 199)])]), key: 'DEWALT:OTHER', model: 'OTHER' };
    const notDiscounted = { ...good, key: 'DEWALT:PLAIN', model: 'PLAIN', percentOff: null };
    const report = { bundles: [good, unsold, notDiscounted], review: [] };
    const tracking = trackReport(emptyTracking(), report, recordedTrend, alerts, NOW);
    const fresh = freshSignals(tracking, ['buyNow'], NOW);
    const first = buildDigest({ report, alerts, notifiedDeals: [], notifiedQuestions: [], autopilotApplied: 0, verifiedWaiting: 0, trendLines: [], buyNow: fresh.lines });
    expect(first.event).toMatchObject({ kind: 'deal', count: 1, route: '/deals' });
    expect(first.text).toBe(
      '1 deal worth buying now. Top: DEWALT DCK200D1P1W921B, est. profit $81.80 (27% ROI). First seen with an estimate: est. profit $81.80 (27% ROI). ' +
        'The slowest part, DCF921B, sold 600 last month on Amazon (Keepa); your minimum is 50. Estimates from your fee settings.',
    );
    expect(first.notifiedDeals).toEqual(['DEWALT:DCK200D1P1W921B']);

    const again = freshSignals({ ...tracking, notified: fresh.notified }, ['buyNow'], NOW + 3_600_000);
    const quiet = buildDigest({ report, alerts, notifiedDeals: first.notifiedDeals, notifiedQuestions: [], autopilotApplied: 0, verifiedWaiting: 0, trendLines: [], buyNow: again.lines });
    expect(quiet.event).toBeNull();
    expect(quiet.text).toBeNull();
  });

  it('a deal that fell through the floor is in the message only when the owner turned it on', () => {
    const line = {
      bundleKey: 'K', brand: 'DEWALT', model: 'DCK240C2',
      signal: { kind: 'marginDown' as const, optionId: 'whole', reason: 'Estimated profit fell from $81.80 to $10.00, below your $20.00 floor.', numbers: {} as never },
    };
    const report = { bundles: [], review: [] };
    const off = buildDigest({ report, alerts, notifiedDeals: [], notifiedQuestions: [], autopilotApplied: 0, verifiedWaiting: 0, trendLines: [], marginDown: [line] });
    expect(off.text).toBeNull();
    const on = buildDigest({ report, alerts: { ...alerts, marginDownDigest: true }, notifiedDeals: [], notifiedQuestions: [], autopilotApplied: 0, verifiedWaiting: 0, trendLines: [], marginDown: [line] });
    expect(on.text).toBe('Stop buying? DEWALT DCK240C2: Estimated profit fell from $81.80 to $10.00, below your $20.00 floor.');
  });

  it('says how many questions need the owner when one is new, and what Autopilot applied, in the same message', () => {
    const report = { bundles: [], review: [question('split:1'), question('match:2')] };
    const d = buildDigest({ report, alerts, notifiedDeals: [], notifiedQuestions: ['split:1'], autopilotApplied: 3, verifiedWaiting: 0, trendLines: [] });
    expect(d.event).toMatchObject({ kind: 'review', count: 2, route: '/review' });
    expect(d.text).toBe('2 questions need you.\nAutopilot applied 3 answers (Undo in Activity).');
    expect(d.notifiedQuestions).toEqual(['split:1', 'match:2']);
    const quiet = buildDigest({ report, alerts, notifiedDeals: [], notifiedQuestions: d.notifiedQuestions, autopilotApplied: 0, verifiedWaiting: 0, trendLines: [] });
    expect(quiet.event).toBeNull();
  });

  it('says how many AI answers wait for the owner in Review, one line, when Autopilot did not apply them', () => {
    const report = { bundles: [], review: [question('split:1')] };
    const d = buildDigest({ report, alerts, notifiedDeals: [], notifiedQuestions: ['split:1'], autopilotApplied: 0, verifiedWaiting: 4, trendLines: [] });
    expect(d.text).toBe('4 answers verified by AI — approve them in Review.');
    expect(d.event).toMatchObject({ kind: 'review', count: 4, route: '/review' });
    const one = buildDigest({ report, alerts, notifiedDeals: [], notifiedQuestions: ['split:1'], autopilotApplied: 0, verifiedWaiting: 1, trendLines: [] });
    expect(one.text).toBe('1 answer verified by AI — approve it in Review.');
    const hidden = buildDigest({ report, alerts: { ...alerts, reviewDigest: false }, notifiedDeals: [], notifiedQuestions: [], autopilotApplied: 0, verifiedWaiting: 4, trendLines: [] });
    expect(hidden.text).toBeNull();
  });

  it('nothing when alerts are off, except what Autopilot did', () => {
    const report = { bundles: [deal('b', 'DCK283D2', 45, 0.34)], review: [question('split:1')] };
    const off = buildDigest({ report, alerts: { ...alerts, enabled: false, reviewDigest: false }, notifiedDeals: [], notifiedQuestions: [], autopilotApplied: 1, verifiedWaiting: 0, trendLines: [] });
    expect(off.text).toBe('Autopilot applied 1 answer (Undo in Activity).');
    expect(off.event).toMatchObject({ kind: 'autopilot', count: 1 });
  });

  it('a BOGO line alone is a deal message and says the figures are estimates; none when alerts are off', () => {
    const report = { bundles: [], review: [] };
    // The line as core's bogoDigestLines words it for the recorded DEWALT pair (the estimate is invented).
    const bogoLines = ['BOGO: buy DCK200D1P1 and choose 921B (DCK200D1P1W921B) — +$41.20 est., ends Jan 31.'];
    const on = buildDigest({ report, alerts, notifiedDeals: [], notifiedQuestions: [], autopilotApplied: 0, verifiedWaiting: 0, trendLines: [], bogoLines });
    expect(on.text).toBe(`${bogoLines[0]}\nEstimates from your fee settings.`);
    expect(on.event).toMatchObject({ kind: 'deal', count: 1, route: '/deals' });
    const off = buildDigest({ report, alerts: { ...alerts, enabled: false }, notifiedDeals: [], notifiedQuestions: [], autopilotApplied: 0, verifiedWaiting: 0, trendLines: [], bogoLines });
    expect(off.text).toBeNull();
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
