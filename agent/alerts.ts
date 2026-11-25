// The alert engine (step 13, Decision 6): after a run, at most one message saying what is new, the same text in the
// app's notification (a `notify` event the shell shows) and on Telegram when the owner set a bot up. A deal is named
// when a watched way to sell is worth buying now and that is news (core/src/tracking/signals.ts: it entered the state, or
// rose by the margin over what was last sent), once per bundle, signal and day (the caller's freshSignals); open
// questions alert only when one is new since the last message. Profit and ROI are
// estimates from the fee settings and the message says so (rule 5). No key is ever in a message.

import type { NotifyEvent, TelegramTestResponse } from '../core/src/api/contract';
import type { BundleRow, ReviewItem, ScanReport } from '../core/src/scan/types';
import { estimateRoiPercent, type AlertSettings } from '../core/src/settings';
import type { SignalLine } from '../core/src/tracking/state';
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
  /** Open questions whose AI suggestion the code verified and nothing has applied yet (what Approve all verified takes). */
  verifiedWaiting: number;
  /** Trend lines already worded (core/src/keepa/alerts.ts). */
  trendLines: string[];
  /** Watched deals worth buying now and not yet sent today, best estimated profit first (core/src/tracking/state.ts). */
  buyNow?: SignalLine[];
  /** Watched deals whose estimate fell through the floor, not yet sent today; used when the owner turned it on. */
  marginDown?: SignalLine[];
  /** BOGO found by the agent: the best choice of each promotion not yet named today (core/src/tracking/bogoPairs.ts). */
  bogoLines?: string[];
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

  const fresh = alerts.enabled ? (input.buyNow ?? []) : [];
  if (fresh.length > 0) {
    const top = fresh[0]!;
    const n = top.signal.numbers;
    lines.push(
      `${plural(fresh.length, 'deal', 'deals')} worth buying now. Top: ${top.brand} ${top.model}, est. profit $${(n.profit ?? 0).toFixed(2)} (${Math.round(n.roiPercent ?? 0)}% ROI). ${top.signal.reason} Estimates from your fee settings.`,
    );
    kind = 'deal';
    count = fresh.length;
    route = '/deals';
  }
  const bogo = alerts.enabled ? (input.bogoLines ?? []) : [];
  if (bogo.length > 0) {
    lines.push(...bogo.slice(0, 3));
    if (bogo.length > 3) lines.push(`${bogo.length - 3} more BOGO promotions in Deals.`);
    if (fresh.length === 0) lines.push('Estimates from your fee settings.');
    if (!kind) {
      kind = 'deal';
      count = bogo.length;
      route = '/deals';
    }
  }
  const down = alerts.enabled && alerts.marginDownDigest ? (input.marginDown ?? []) : [];
  if (down.length > 0) {
    lines.push(...down.slice(0, 3).map((d) => `Stop buying? ${d.brand} ${d.model}: ${d.signal.reason}`));
    if (down.length > 3) lines.push(`${down.length - 3} more below your floor in Deals.`);
    if (!kind) {
      kind = 'deal';
      count = down.length;
      route = '/deals';
    }
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

  if (alerts.reviewDigest && input.verifiedWaiting > 0) {
    const n = input.verifiedWaiting;
    lines.push(`${plural(n, 'answer', 'answers')} verified by AI — approve ${n === 1 ? 'it' : 'them'} in Review.`);
    if (!kind) {
      kind = 'review';
      count = n;
      route = '/review';
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

  const notifiedDeals = [...input.notifiedDeals, ...fresh.map((l) => l.bundleKey)].slice(-KEEP_NOTIFIED);
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
const scrub = (text: string, keys: TelegramKeys): string => {
  // The whole token, and the secret half after the colon in case Telegram echoes only that.
  const secret = keys.botToken.includes(':') ? keys.botToken.slice(keys.botToken.indexOf(':') + 1) : '';
  const clean = text.split(keys.botToken).join('[token]');
  return (secret.length >= 6 ? clean.split(secret).join('[token]') : clean).slice(0, 200);
};

/**
 * One sendMessage call (core.telegram.org/bots/api, read Nov 22, 2026: POST https://api.telegram.org/bot<token>/METHOD,
 * JSON body; sendMessage takes chat_id (Integer or String) and text (1-4096 characters); the answer is
 * {ok, result} or {ok: false, error_code, description}). The token is in the address Telegram defines; it is never
 * in a message, a log line or an error sentence.
 */
export async function sendTelegram(
  fetchFn: typeof fetch,
  keys: TelegramKeys,
  text: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string; /** Telegram's HTTP status; absent when it could not be reached. */ status?: number; /** Telegram's own description, token scrubbed. */ description?: string }> {
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
  const description = typeof body.description === 'string' ? scrub(body.description, keys) : undefined;
  const said = description !== undefined ? `: ${description}` : '';
  return { ok: false, error: `Telegram refused the message (HTTP ${res.status}${said}).`, status: res.status, ...(description !== undefined ? { description } : {}) };
}

/** What the "Send a test message" button sends. */
export const TELEGRAM_TEST_TEXT = 'Split Finder can reach you here.';

/** Telegram's refusal in plain words, with its own description after it. Never the token (scrubbed already). */
export function telegramProblemWords(status: number | undefined, description: string | undefined): string {
  const theirs = description ? ` Telegram said: ${description}.` : '';
  if (status === undefined) return 'Telegram could not be reached. Check this computer’s internet connection and try again.';
  if (status === 401 || status === 404) return `Telegram did not accept the bot token. Copy it again from BotFather in Keys.${theirs}`;
  if (status === 429) return `Telegram asks you to wait a moment before sending again. Try again shortly.${theirs}`;
  if (status === 403) return `The bot is not allowed to message this chat. Open the bot in Telegram and press Start, then try again.${theirs}`;
  if (status === 400 && /chat not found/i.test(description ?? '')) return `Telegram cannot find that chat id. Send your bot a message first, then check the chat id in Keys.${theirs}`;
  return `Telegram refused the message (HTTP ${status}).${theirs}`;
}

/** The test message: one send to the saved bot and chat, answered as the owner reads it. */
export async function testTelegram(fetchFn: typeof fetch, keys: TelegramKeys | undefined): Promise<TelegramTestResponse> {
  if (!keys) return { ok: false, problem: 'Telegram is not set up. Add a bot token and chat id in Keys first.' };
  const r = await sendTelegram(fetchFn, keys, TELEGRAM_TEST_TEXT);
  return r.ok ? { ok: true } : { ok: false, problem: telegramProblemWords(r.status, r.description) };
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
