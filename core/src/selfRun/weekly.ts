// The weekly summary (Nov 25): one message a week (default Monday 8:00, local), built from the stores. Pure: the stores' contents
// and the clock are handed in; the agent (agent/selfRun.ts) reads the stores and sends it.
//
// Plain text, one line to a fact, no table (Telegram would mangle one). Every dollar figure says what it is: an estimate (from the
// fee settings, not his real fees) or recorded (what he entered, or what the app's own ledgers counted). Nothing is made up: with
// no purchases recorded the message says so.

import type { Purchase, RunRecord } from '../api/contract';
import { localDate } from '../costs/time';
import type { CostService, CostsView } from '../costs/types';
import { type AiSpendSources, aiEvents, countEvents, keepaEvents, serpEvents, type UsageEvent } from '../costs/usage';
import type { CostsInput } from '../costs/view';
import { amount, usd } from '../costs/words';
import { dayOf, purchaseResult, scorecardOf } from '../outcomes/outcomes';
import type { BundleRow } from '../scan/types';
import type { TrackingState } from '../tracking/state';

export interface WeeklySetting {
  /** 0 is Sunday, 1 Monday. */
  day: number;
  /** "HH:MM", local. */
  at: string;
}

export const DEFAULT_WEEKLY: WeeklySetting = { day: 1, at: '08:00' };

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** The owner's setting with the defaults for a store written before it existed. */
export function weeklyOf(n: { weekly?: Partial<WeeklySetting> } | undefined): WeeklySetting {
  const w = n?.weekly;
  return {
    day: typeof w?.day === 'number' && Number.isInteger(w.day) && w.day >= 0 && w.day <= 6 ? w.day : DEFAULT_WEEKLY.day,
    at: typeof w?.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(w.at) ? w.at : DEFAULT_WEEKLY.at,
  };
}

/** The latest moment at or before `now` that is the weekly time (epoch ms). */
export function lastWeeklyDue(now: number, w: WeeklySetting): number {
  const [h, m] = w.at.split(':').map(Number) as [number, number];
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - w.day + 7) % 7));
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  return d.getTime();
}

/** What was last sent: the due day's key and when (epoch ms). */
export interface WeeklySent {
  key: string;
  at: number;
}

export type WeeklyDecision =
  | { action: 'none' }
  /** The first look at a store: this week's moment is taken as passed, so a new install does not send an empty message. */
  | { action: 'seed'; sent: WeeklySent }
  | { action: 'send'; key: string; from: number };

/** Whether the weekly message is due now. Once per due moment: the key is the local day of that moment. */
export function weeklyDecision(now: number, w: WeeklySetting, sent: WeeklySent | undefined): WeeklyDecision {
  const due = lastWeeklyDue(now, w);
  const key = dayOf(due);
  if (!sent) return { action: 'seed', sent: { key, at: now } };
  if (sent.key >= key) return { action: 'none' };
  return { action: 'send', key, from: Math.max(sent.at, now - 7 * 86_400_000) };
}

// ---------------------------------------------------------------- what the week used

export type WeekUse = Record<CostService, { used: number; usd: number }>;

/** What each service was used for between `from` and `to`, from the ledgers' rows and the counted calls (as the costs view reads them). */
export function weekUse(c: Pick<CostsInput, 'serp' | 'keepa' | 'counts'> & { ai: AiSpendSources }, from: number, to: number, tz?: string): WeekUse {
  const within = (events: readonly UsageEvent[]) => events.filter((e) => e.at > from && e.at <= to);
  const sum = (events: readonly UsageEvent[]) => ({ used: events.reduce((n, e) => n + e.used, 0), usd: events.reduce((n, e) => n + e.usd, 0) });
  // eBay calls and Telegram messages are counted by day: the days after `from`'s up to `to`'s.
  const firstDay = localDate(from, tz);
  const lastDay = localDate(to, tz);
  const counted = (kind: 'ebay' | 'telegram') => {
    const days = Object.fromEntries(Object.entries(c.counts).filter(([d]) => d > firstDay && d <= lastDay).map(([d, v]) => [d, v[kind] ?? 0]));
    return sum(countEvents(days));
  };
  return {
    serpapi: sum(within(serpEvents(c.serp.rows))),
    keepa: sum(within(keepaEvents(c.keepa.rows))),
    ai: sum(within(aiEvents(c.ai))),
    ebay: counted('ebay'),
    telegram: counted('telegram'),
  };
}

// ---------------------------------------------------------------- the summary

export interface WeeklyInput {
  /** The period: after `from`, up to `now` (epoch ms). */
  now: number;
  from: number;
  bundles: readonly Pick<BundleRow, 'key' | 'section'>[];
  tracking: Pick<TrackingState, 'history' | 'signals' | 'watch' | 'notified'>;
  purchases: readonly Purchase[];
  /** Open questions in Review. */
  openQuestions: number;
  costs: CostsView;
  week: WeekUse;
  /** Runs recorded in Activity; the ones in the period that stopped at a limit are counted as held back. */
  runs: readonly Pick<RunRecord, 'kind' | 'startedAt' | 'status'>[];
  /** Home Depot pages waiting to be read, when counted. */
  pagesWaiting: number | null;
  paused: boolean;
}

export interface WeeklyCounts {
  dealsFound: number;
  buyNowAnnounced: number;
  buyNowNow: number;
  purchases: number;
}

export interface WeeklySummary {
  /** The system notification's short form. */
  short: string;
  /** Telegram's full form: plain text. */
  text: string;
  counts: WeeklyCounts;
}

const money = (n: number): string => (n < 0 ? `-${usd(-n)}` : usd(n));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const dayWords = (ms: number): string => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** The distinct deals announced as worth buying now on days from `fromDay` to `toDay` (the notified list's `<key>|buyNow|<day>`). */
function announcedBuys(notified: readonly string[], fromDay: string, toDay: string): number {
  const keys = new Set<string>();
  for (const n of notified) {
    const parts = n.split('|');
    const day = parts[parts.length - 1]!;
    if (parts[parts.length - 2] === 'buyNow' && day >= fromDay && day <= toDay) keys.add(parts.slice(0, -2).join('|'));
  }
  return keys.size;
}

export function weeklySummary(i: WeeklyInput): WeeklySummary {
  const fromDay = dayOf(i.from);
  const toDay = dayOf(i.now);

  // Deals: a deal is a bundle with every part priced (the section the app calls confirmed). New: its first stored scan point is in the period.
  const dealsFound = i.bundles.filter((b) => {
    const first = i.tracking.history[b.key]?.[0]?.at;
    return b.section === 'confirmed' && first !== undefined && first > i.from && first <= i.now;
  }).length;
  const buyNowAnnounced = announcedBuys(i.tracking.notified, fromDay, toDay);
  const buyNowNow = Object.entries(i.tracking.signals).filter(([k, s]) => i.tracking.watch[k]?.watched === true && s.buyNow !== null).length;

  // What he recorded.
  const bought = i.purchases.filter((p) => p.boughtAt >= fromDay && p.boughtAt <= toDay);
  const paid = bought.reduce((n, p) => n + p.pricePaid * p.quantity, 0);
  const estimatedWhenBought = bought.reduce((n, p) => n + (purchaseResult(p).estimatedProfit ?? 0), 0);
  let realised = 0;
  let realisedParts = 0;
  let feesEstimated = 0;
  for (const p of i.purchases) {
    for (const r of purchaseResult(p).parts) {
      if (r.date !== null && r.date >= fromDay && r.date <= toDay && r.profit !== null) {
        realised += r.profit;
        realisedParts += 1;
        if (r.netFrom === 'fees_estimated') feesEstimated += 1;
      }
    }
  }
  const accuracy = scorecardOf(i.purchases, i.now).accuracy;

  const lines: string[] = [`Split Finder, your week: ${dayWords(i.from)} to ${dayWords(i.now)}`, ''];
  lines.push('Dollar figures say what they are: an estimate (from your fee settings, not your real fees) or recorded (what you entered, or what the app counted).', '');

  lines.push('Deals');
  lines.push(dealsFound > 0 ? `- ${plural(dealsFound, 'new deal', 'new deals')} found (every part priced).` : '- No new deals found.');
  lines.push(`- ${plural(buyNowAnnounced, 'deal was', 'deals were')} announced as worth buying now; ${buyNowNow} ${buyNowNow === 1 ? 'is' : 'are'} worth buying now as of this message.`, '');

  lines.push('Bought');
  if (bought.length === 0) lines.push('- No purchases recorded this week.');
  else lines.push(`- ${plural(bought.length, 'purchase', 'purchases')} recorded: ${money(paid)} paid (recorded); estimated profit when bought ${money(estimatedWhenBought)} (estimate).`);
  lines.push('');

  lines.push('Profit');
  lines.push(
    realisedParts > 0
      ? `- Realised this week: ${money(realised)} from ${plural(realisedParts, 'part', 'parts')} sold or returned (recorded${feesEstimated > 0 ? `; Amazon's fees estimated for ${feesEstimated}` : ''}).`
      : '- No sales recorded this week.',
  );
  lines.push(
    accuracy
      ? `- Estimate against actual, on ${plural(accuracy.deals, 'finished deal', 'finished deals')}: estimated ${money(accuracy.estimated)} (estimate), actual ${money(accuracy.actual)} (recorded), ${accuracy.diff >= 0 ? 'ahead by' : 'behind by'} ${money(Math.abs(accuracy.diff))}.`
      : '- No finished deals recorded yet, so there is nothing to compare an estimate with.',
    '',
  );

  lines.push('Questions');
  lines.push(i.openQuestions > 0 ? `- ${plural(i.openQuestions, 'question is', 'questions are')} open in Review.` : '- No questions are open.', '');

  const w = i.week;
  lines.push('Costs this week (from the app\'s own records)');
  lines.push(`- SerpApi ${amount(w.serpapi.used, 'searches')}, Keepa ${amount(w.keepa.used, 'tokens')}, AI ${usd(w.ai.usd)} (recorded), eBay ${amount(w.ebay.used, 'calls')}, Telegram ${amount(w.telegram.used, 'messages')}.`);
  const attention = i.costs.services.filter((s) => s.state !== 'ok');
  if (attention.length === 0 && i.costs.total.state === 'ok') lines.push('- This month is inside your limits.');
  else {
    if (i.costs.total.state !== 'ok') lines.push(`- ${i.costs.total.sentence}`);
    for (const s of attention) lines.push(`- ${s.label}: ${s.sentence}`);
  }
  lines.push('');

  const held: string[] = [];
  const periodBlocked = i.costs.services.flatMap((s) => s.blocked.filter((b) => Date.parse(b.at) > i.from).map((b) => `${b.what}. ${b.why}`));
  held.push(...periodBlocked);
  const limited = i.runs.filter((r) => r.kind === 'scan' && r.status === 'limit' && Date.parse(r.startedAt) > i.from).length;
  if (limited > 0) held.push(`${plural(limited, 'scan', 'scans')} stopped at a limit.`);
  if (i.pagesWaiting !== null && i.pagesWaiting > 0) held.push(`${plural(i.pagesWaiting, 'Home Depot page waits', 'Home Depot pages wait')} to be read.`);
  if (i.paused) held.push('The agent is paused, so no scan runs.');
  lines.push('Held back');
  lines.push(...(held.length > 0 ? held.map((h) => `- ${h}`) : ['- Nothing.']));

  const short = [
    `${plural(dealsFound, 'new deal', 'new deals')}, ${buyNowAnnounced} announced as worth buying now.`,
    bought.length > 0 ? `${plural(bought.length, 'purchase', 'purchases')} recorded.` : 'No purchases recorded.',
    i.openQuestions > 0 ? `${plural(i.openQuestions, 'question', 'questions')} open.` : null,
    attention.length === 0 && i.costs.total.state === 'ok' ? 'Costs inside your limits.' : 'Costs need a look.',
  ].filter((x): x is string => x !== null).join(' ');

  return { short: `Your week: ${short}`, text: lines.join('\n'), counts: { dealsFound, buyNowAnnounced, buyNowNow, purchases: bought.length } };
}
