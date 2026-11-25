// Local days and months for the costs (step 18). Pure: the clock and the time zone are handed in. `tz` undefined is the
// computer's own zone (the agent's); tests name one so a day's edge is exact.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string | undefined): Intl.DateTimeFormat {
  const key = tz ?? '';
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(key, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  /** Minutes since local midnight. */
  minutes: number;
}

export function localParts(ms: number, tz?: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), minutes: hour * 60 + Number(parts.minute) };
}

const two = (n: number): string => String(n).padStart(2, '0');

/** "2026-11-25", the local day of `ms`. */
export function localDate(ms: number, tz?: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${two(p.month)}-${two(p.day)}`;
}

/** "2026-11" of "2026-11-25". */
export const monthOf = (date: string): string => date.slice(0, 7);

/** Days in a month "2026-11". */
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The date `n` days after `date` (calendar arithmetic, no clock). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())}`;
}

/** "2026-12" after "2026-11". */
export function nextMonth(month: string): string {
  return monthOf(addDays(`${month}-${two(daysInMonth(month))}`, 1));
}

/** "2026-10" before "2026-11". */
export function previousMonth(month: string): string {
  return monthOf(addDays(`${month}-01`, -1));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 28" for "2026-11-28". */
export function shortDay(date: string): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}`;
}

/** Every date from `from` to `to`, both included, oldest first. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 4000; d = addDays(d, 1)) out.push(d);
  return out;
}
