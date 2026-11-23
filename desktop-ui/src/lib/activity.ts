// How Activity reads (docs/design.md, Desktop app > Screens > Activity): newest first, grouped by day, each run as a plain
// sentence. Pure, so the order and the words are tested once.

import type { Run } from '../api/types';
import { count, money, usdSpend } from './format';

const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today", "Yesterday", else "Wed, Nov 19". */
export function dayLabel(at: string, now: number = Date.now()): string {
  const d = new Date(at);
  const days = Math.round((dayStart(new Date(now)) - dayStart(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** The time of day, "8:51 AM": under a day heading the date is already said. */
export function clock(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export interface DayGroup<T> {
  /** The day, as the heading says it; the key is the local date. */
  key: string;
  label: string;
  items: T[];
}

/** Newest first, then one group per local day. An item with no readable time goes last, in its own group. */
export function byDay<T>(items: readonly T[], at: (item: T) => string, now: number = Date.now()): DayGroup<T>[] {
  const stamp = (x: T): number => {
    const t = Date.parse(at(x));
    return Number.isFinite(t) ? t : -Infinity;
  };
  const sorted = [...items].sort((a, b) => stamp(b) - stamp(a));
  const groups: DayGroup<T>[] = [];
  for (const item of sorted) {
    const t = stamp(item);
    const key = Number.isFinite(t) ? new Date(t).toDateString() : 'unknown';
    const last = groups.at(-1);
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: Number.isFinite(t) ? dayLabel(at(item), now) : 'Earlier', items: [item] });
  }
  return groups;
}

const NAME: Record<Run['kind'], { you: string; auto: string }> = {
  scan: { you: 'Scan you started', auto: 'Scheduled scan' },
  ask: { you: 'Ask AI, started by you', auto: 'AI check after a scan' },
  lookup: { you: 'Amazon lookup you started', auto: 'Scheduled Amazon lookup' },
  verify: { you: 'Listing confirmation you started', auto: 'Listing confirmation' },
};

const OUTCOME: Record<Run['result'], string> = { finished: 'Finished', stopped: 'Stopped', limit: 'Stopped at the limit', failed: 'Failed', running: 'Running now' };

export interface RunWords {
  /** "Scheduled scan", "Amazon lookup you started". */
  title: string;
  /** "Finished", "Stopped at the limit", "Failed". */
  outcome: string;
  /** How it ended is something to act on: a failure or a stop he did not ask for. */
  problem: boolean;
  /** "Used 3 searches, 16 Keepa tokens and $0.04 of AI", or null when it spent nothing. */
  spent: string | null;
}

export function runWords(r: Run): RunWords {
  const bits: string[] = [];
  if (r.searches > 0) bits.push(`${count(r.searches)} ${r.searches === 1 ? 'search' : 'searches'}`);
  if (r.keepaTokens > 0) bits.push(`${count(r.keepaTokens)} Keepa ${r.keepaTokens === 1 ? 'token' : 'tokens'}`);
  if (r.aiUsd > 0) bits.push(`${r.aiUsd < 0.005 ? usdSpend(r.aiUsd) : money(r.aiUsd)} of AI`);
  const spent = bits.length === 0 ? null : `Used ${bits.length === 1 ? bits[0] : `${bits.slice(0, -1).join(', ')} and ${bits.at(-1)}`}`;
  return { title: r.byYou ? NAME[r.kind].you : NAME[r.kind].auto, outcome: OUTCOME[r.result], problem: r.result === 'failed' || r.result === 'limit', spent };
}

export type TextPiece = { text: string; url?: undefined } | { text: string; url: string };

/** Splits a sentence that quotes web addresses into text and links ("(source)"), so every claim keeps a source link he can open. */
export function linkPieces(text: string): TextPiece[] {
  const out: TextPiece[] = [];
  let rest = text;
  for (let m = rest.match(/https?:\/\/[^\s)]+/); m; m = rest.match(/https?:\/\/[^\s)]+/)) {
    const at = m.index ?? 0;
    if (at > 0) out.push({ text: rest.slice(0, at) });
    // A trailing full stop or semicolon belongs to the sentence, not the address.
    const url = m[0].replace(/[.;,]+$/, '');
    out.push({ text: 'source', url });
    rest = rest.slice(at + url.length);
  }
  if (rest) out.push({ text: rest });
  return out;
}
