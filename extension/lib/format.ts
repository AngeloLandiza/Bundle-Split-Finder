// How the side panel writes numbers and times. Currency has two decimals, a loss uses the
// real minus sign (U+2212), ROI is a whole percent.

const MINUS = '−';
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

/** A fraction as a whole percent: 0.45 becomes 45%, -0.06 becomes −6%. */
export function roi(fraction: number): string {
  const pct = Math.round(Math.abs(fraction) * 100);
  return `${fraction < 0 && pct > 0 ? MINUS : ''}${pct}%`;
}

const time = (d: Date): string => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * A moment as the owner reads it: relative while it is less than an hour away, otherwise the local
 * time today, "tomorrow" and the time, or the local date and time.
 */
export function when(ms: number, now: number): string {
  const diff = ms - now;
  const minutes = Math.round(Math.abs(diff) / 60_000);
  if (Math.abs(diff) < 60_000) return 'now';
  if (minutes < 60) return diff > 0 ? `in ${minutes} min` : `${minutes} min ago`;
  const d = new Date(ms);
  const days = Math.round((dayStart(d) - dayStart(new Date(now))) / 86_400_000);
  if (days === 0) return time(d);
  if (days === 1) return `tomorrow ${time(d)}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time(d)}`;
}
