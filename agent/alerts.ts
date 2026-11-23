// The alert engine (step 13, Decision 6): after a run, at most one message saying what is new, the same text in the
// app's notification (a `notify` event the shell shows) and on Telegram when the owner set a bot up. A deal is named
// once (by its bundle key); open questions alert only when one is new since the last message. Profit and ROI are
// estimates from the fee settings and the message says so (rule 5). No key is ever in a message.

import type { NotifyEvent } from '../core/src/api/contract';
import type { BundleRow, ReviewItem, ScanReport } from '../core/src/scan/types';
import { estimateRoiPercent, type AlertSettings } from '../core/src/settings';
import type { PendingMessage } from './store';

/** Deal keys remembered as notified; the oldest are forgotten past this. */
const KEEP_NOTIFIED = 2000;
/** A message Telegram refused this many times is dropped. */
export const TELEGRAM_MAX_TRIES = 5;
const KEEP_PENDING = 10;

export interface DigestInput {
  report: Pick<ScanReport, 'bundles' | 'review'> & { ebayQuestions?: { id: string }[] };
  alerts: AlertSettings;
  notifiedDeals: string[];
  notifiedQuestions: string[];
  autopilotApplied: number;
  /** Trend lines already worded (core/src/keepa/alerts.ts). */
  trendLines: string[];
}

export interface Digest {
  text: string | null;
  event: Omit<NotifyEvent, 'id'> | null;
  notifiedDeals: string[];
  notifiedQuestions: string[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Confirmed deals with an estimate at or above both numbers, best estimated profit first. */
export function dealsAbove(rows: BundleRow[], alerts: AlertSettings): BundleRow[] {
  return rows
    .filter((b) => b.section === 'confirmed' && b.estimate !== null && b.estimate.profit >= alerts.minProfit && estimateRoiPercent(b.estimate.roi) >= alerts.minRoiPercent)
    .sort((a, b) => b.estimate!.profit - a.estimate!.profit);
}

export function buildDigest(input: DigestInput): Digest {
  const { report, alerts } = input;
  const lines: string[] = [];
  let kind: NotifyEvent['kind'] | null = null;
  let count = 0;
  let route = '/';

  const already = new Set(input.notifiedDeals);
  const fresh = alerts.enabled ? dealsAbove(report.bundles, alerts).filter((b) => !already.has(b.key)) : [];
  if (fresh.length > 0) {
    const top = fresh[0]!;
    const roi = Math.round(estimateRoiPercent(top.estimate!.roi));
    lines.push(
      `${plural(fresh.length, 'new deal', 'new deals')} above ${alerts.minRoiPercent}% ROI. Top: ${top.brand} ${top.model}, est. profit $${top.estimate!.profit.toFixed(2)} (${roi}% ROI). Estimates from your fee settings.`,
    );
    kind = 'deal';
    count = fresh.length;
    route = '/deals';
  }

  const open = [...report.review.filter((q: ReviewItem) => q.answer === null).map((q) => q.id), ...(report.ebayQuestions ?? []).map((q) => q.id)];
  const seenBefore = new Set(input.notifiedQuestions);
  if (alerts.reviewDigest && open.some((id) => !seenBefore.has(id))) {
    lines.push(`${plural(open.length, 'question needs', 'questions need')} you.`);
    if (!kind) {
      kind = 'review';
      count = open.length;
      route = '/review';
    }
  }

  if (input.autopilotApplied > 0) {
    lines.push(`Autopilot applied ${plural(input.autopilotApplied, 'answer', 'answers')} (Undo in Activity).`);
    if (!kind) {
      kind = 'autopilot';
      count = input.autopilotApplied;
      route = '/activity';
    }
  }

  if (alerts.enabled && input.trendLines.length > 0) {
    lines.push(...input.trendLines.slice(0, 3));
    if (input.trendLines.length > 3) lines.push(`${input.trendLines.length - 3} more price changes in Deals.`);
    if (!kind) {
      kind = 'deal';
      count = input.trendLines.length;
      route = '/deals';
    }
  }

  const notifiedDeals = [...input.notifiedDeals, ...fresh.map((b) => b.key)].slice(-KEEP_NOTIFIED);
  if (!kind) return { text: null, event: null, notifiedDeals, notifiedQuestions: open };
  const text = lines.join('\n');
  return { text, event: { kind, title: 'Split Finder', body: text, count, route }, notifiedDeals, notifiedQuestions: open };
}

// ---------------------------------------------------------------- Telegram

export interface TelegramKeys {
  botToken: string;
  chatId: string;
}

/** Telegram's own words, without the token, short. */
const scrub = (text: string, keys: TelegramKeys): string => text.split(keys.botToken).join('[token]').slice(0, 200);

/**
 * One sendMessage call (core.telegram.org/bots/api, read Nov 22, 2026: POST https://api.telegram.org/bot<token>/METHOD,
 * JSON body; sendMessage takes chat_id (Integer or String) and text (1-4096 characters); the answer is
 * {ok, result} or {ok: false, error_code, description}). The token is in the address Telegram defines; it is never
 * in a message, a log line or an error sentence.
 */
export async function sendTelegram(fetchFn: typeof fetch, keys: TelegramKeys, text: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetchFn(`https://api.telegram.org/bot${keys.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: keys.chatId, text: text.slice(0, 4096) }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, error: 'Telegram could not be reached.' };
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: unknown; description?: unknown };
  if (res.ok && body.ok === true) return { ok: true };
  const said = typeof body.description === 'string' ? `: ${scrub(body.description, keys)}` : '';
  return { ok: false, error: `Telegram refused the message (HTTP ${res.status}${said}).` };
}

/**
 * Sends what waits from earlier runs, then this run's message, in order. A message that fails stays waiting for the
 * next run (dropped after TELEGRAM_MAX_TRIES); once one fails the rest wait too, so they arrive in order.
 */
export async function sendPending(
  fetchFn: typeof fetch,
  keys: TelegramKeys,
  pending: PendingMessage[],
  next: { text: string; at: string } | null,
): Promise<{ sent: number; pending: PendingMessage[]; error: string | null }> {
  const queue = [...pending, ...(next ? [{ ...next, tries: 0 }] : [])];
  let sent = 0;
  let error: string | null = null;
  const left: PendingMessage[] = [];
  for (const m of queue) {
    if (error !== null) {
      left.push(m);
      continue;
    }
    const r = await sendTelegram(fetchFn, keys, m.text);
    if (r.ok) sent += 1;
    else {
      error = r.error;
      if (m.tries + 1 < TELEGRAM_MAX_TRIES) left.push({ ...m, tries: m.tries + 1 });
    }
  }
  return { sent, pending: left.slice(-KEEP_PENDING), error };
}
