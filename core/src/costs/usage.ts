// What was used, from the app's own records (step 18): the SerpApi ledger (`{at, engine, label}` a search that counted), the
// Keepa ledger (`{at, kind, key, label, tokens, tokensLeft, refillIn, refillRate}` a call Keepa charged), the AI's dollars
// (each suggestion, each brief, each run's eBay judge: as views.ts aiSpentThisMonth counts them), and counted eBay calls and
// Telegram messages. Pure: the agent reads the files and hands the rows in.

import type { CostDay } from './types';
import { datesBetween, localDate, monthOf } from './time';

/** One use of a service: when (epoch ms), how much in its unit, and the metered dollars (0 for a subscription). */
export interface UsageEvent {
  at: number;
  used: number;
  usd: number;
}

export interface KeepaLedgerRow {
  at: string;
  tokens: number;
  tokensLeft?: number;
  refillRate?: number;
}

/** The rows of a keepa-ledger.jsonl text: a damaged line, or one without a time or a token count, is skipped. */
export function parseKeepaLedger(text: string): KeepaLedgerRow[] {
  const rows: KeepaLedgerRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      if (typeof j.at !== 'string' || typeof j.tokens !== 'number' || !Number.isFinite(j.tokens)) continue;
      rows.push({
        at: j.at, tokens: j.tokens,
        ...(typeof j.tokensLeft === 'number' ? { tokensLeft: j.tokensLeft } : {}),
        ...(typeof j.refillRate === 'number' ? { refillRate: j.refillRate } : {}),
      });
    } catch {
      // A half-written line is not a row.
    }
  }
  return rows;
}

const time = (at: string): number => Date.parse(at);

/** Each SerpApi ledger row is one search. A row whose time cannot be read is left out (no day to put it on). */
export function serpEvents(rows: readonly { at: string }[]): UsageEvent[] {
  return rows.filter((r) => Number.isFinite(time(r.at))).map((r) => ({ at: time(r.at), used: 1, usd: 0 }));
}

/** Each Keepa ledger row is the tokens that call cost. */
export function keepaEvents(rows: readonly KeepaLedgerRow[]): UsageEvent[] {
  return rows.filter((r) => Number.isFinite(time(r.at)) && r.tokens > 0).map((r) => ({ at: time(r.at), used: r.tokens, usd: 0 }));
}

/** What the AI spend is read from: the same sources and the same once-each rule as views.ts aiSpentThisMonth. */
export interface AiSpendSources {
  suggestions: readonly { askedAt: number; costUsd?: number | null; briefMeta?: { at: number; costUsd?: number | null } }[];
  runs: readonly { startedAt: string; judgeCostUsd?: number }[];
}

/** The AI's dollars as events: each ask, each brief, each run's eBay judge. Its unit is the dollar, so used = usd. */
export function aiEvents(src: AiSpendSources): UsageEvent[] {
  const out: UsageEvent[] = [];
  const add = (at: number, usd: number | null | undefined) => {
    if (Number.isFinite(at) && typeof usd === 'number' && usd > 0) out.push({ at, used: usd, usd });
  };
  for (const s of src.suggestions) {
    add(s.askedAt, s.costUsd);
    if (s.briefMeta) add(s.briefMeta.at, s.briefMeta.costUsd);
  }
  for (const r of src.runs) add(time(r.startedAt), r.judgeCostUsd);
  return out;
}

/** Counted uses by local day ("2026-11-25" → n), as the agent keeps them for eBay calls and Telegram messages. */
export function countEvents(byDay: Readonly<Record<string, number>>): UsageEvent[] {
  // Local noon of the day stands for it: the day is all that was kept, and noon stays on that day in any zone the
  // agent runs in.
  return Object.entries(byDay)
    .filter(([d, n]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && typeof n === 'number' && n > 0)
    .map(([d, n]) => ({ at: Date.parse(`${d}T12:00:00`), used: n, usd: 0 }));
}

/** Use and dollars by local day. */
export function byDay(events: readonly UsageEvent[], tz?: string): Map<string, { used: number; usd: number }> {
  const out = new Map<string, { used: number; usd: number }>();
  for (const e of events) {
    const d = localDate(e.at, tz);
    const cur = out.get(d) ?? { used: 0, usd: 0 };
    cur.used += e.used;
    cur.usd += e.usd;
    out.set(d, cur);
  }
  return out;
}

const round = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;

/** This month so far, one entry a day from the 1st to `today` (both local), zeros included, oldest first. */
export function monthDays(events: readonly UsageEvent[], today: string, tz?: string): CostDay[] {
  const days = byDay(events, tz);
  return datesBetween(`${monthOf(today)}-01`, today).map((date) => {
    const d = days.get(date);
    return { date, used: round(d?.used ?? 0, 6), usd: round(d?.usd ?? 0, 6) };
  });
}

/** Totals by local month ("2026-10" → used, usd). */
export function byMonth(events: readonly UsageEvent[], tz?: string): Map<string, { used: number; usd: number }> {
  const out = new Map<string, { used: number; usd: number }>();
  for (const [date, d] of byDay(events, tz)) {
    const m = monthOf(date);
    const cur = out.get(m) ?? { used: 0, usd: 0 };
    cur.used += d.used;
    cur.usd += d.usd;
    out.set(m, cur);
  }
  return out;
}
