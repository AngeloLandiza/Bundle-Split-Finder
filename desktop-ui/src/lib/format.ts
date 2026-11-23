// How the desktop app writes numbers and times (docs/design.md, Behaviour > Numbers).
// Currency has two decimals; profit carries a leading + and a loss the real minus sign (U+2212);
// ROI is a whole percent. The same rules as the side panel, so a figure reads the same in both.

export const MINUS = '−';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const cents = (n: number): number => Math.round(Math.abs(n) * 100);

/** $1,234.50, or −$22.70. */
export function money(n: number): string {
  return `${n < 0 && cents(n) > 0 ? MINUS : ''}${usd.format(cents(n) / 100)}`;
}

/** +$337.30 for a gain, −$22.70 for a loss, $0.00 for nothing. */
export function profit(n: number): string {
  if (cents(n) === 0) return money(0);
  return `${n > 0 ? '+' : ''}${money(n)}`;
}

/** A fraction as a whole percent: 0.45 reads 45%, −0.06 reads −6%. */
export function roi(fraction: number): string {
  const pct = Math.round(Math.abs(fraction) * 100);
  return `${fraction < 0 && pct > 0 ? MINUS : ''}${pct}%`;
}

/** A fraction as a whole percent with its sign, for the two ends of a range: +12%, −6%, 0%. */
export function roiSigned(fraction: number): string {
  const pct = Math.round(Math.abs(fraction) * 100);
  return `${pct === 0 ? '' : fraction < 0 ? MINUS : '+'}${pct}%`;
}

/** "ROI −6% to +12%", or null when the two ends read the same (design.md: only when they read differently). */
export function roiRange(range: { low: number; high: number } | null | undefined): string | null {
  if (!range) return null;
  const lo = roiSigned(range.low);
  const hi = roiSigned(range.high);
  return lo === hi ? null : `ROI ${lo} to ${hi}`;
}

/** A dollar amount for AI spend: $0.02, $3.10. Under a cent reads "under $0.01". */
export function usdSpend(n: number): string {
  if (n > 0 && n < 0.005) return 'under $0.01';
  return money(n);
}

/** 1,240 */
export function count(n: number): string {
  return whole.format(n);
}

/** "1 search", "5 searches"; the noun follows the count. */
export function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** A whole percent off: 34% off. */
export function percentOff(n: number | null | undefined): string | null {
  return typeof n === 'number' && n > 0 ? `${Math.round(n)}% off` : null;
}

const time = (d: Date): string => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * A moment as the owner reads it: relative while under an hour ("just now", "in 12 min", "12 min ago"),
 * otherwise the local time today, "yesterday"/"tomorrow" and the time, or the date and time.
 */
export function when(at: string | number, now: number = Date.now()): string {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  const diff = ms - now;
  const minutes = Math.round(Math.abs(diff) / 60_000);
  if (Math.abs(diff) < 60_000) return diff <= 0 ? 'just now' : 'now';
  if (minutes < 60) return diff > 0 ? `in ${minutes} min` : `${minutes} min ago`;
  const d = new Date(ms);
  const days = Math.round((dayStart(d) - dayStart(new Date(now))) / 86_400_000);
  if (days === 0) return time(d);
  if (days === 1) return `tomorrow ${time(d)}`;
  if (days === -1) return `yesterday ${time(d)}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time(d)}`;
}

/** "about 4 min", "under a minute", or "estimating" (design.md, Scan progress > The estimate). */
export function eta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'estimating';
  if (seconds < 60) return 'under a minute';
  return `about ${Math.round(seconds / 60)} min`;
}
