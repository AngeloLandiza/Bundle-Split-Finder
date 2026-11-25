// Keeping deals current between scans (Nov 25, the owner: "a deal marked Buy now is kept current by the app itself, so I
// never act on a stale price"). A Buy now deal, and every watched deal, has its Home Depot price read again (its own page,
// one free page through Home Depot's pace, between scans only) and each of its parts' Amazon prices pulled again (one Keepa
// product pull each, never a SerpApi search, never below the Keepa reserve) on a fixed cadence, Buy now more often. What a
// read changes goes through the scan's own report and signals; a verdict that flips says so in one sentence with the before
// and after. How old the prices are is always shown, and a Buy now whose prices could not be checked for too long says so.
// Pure: the agent (agent/work.ts) reads, pulls, stores and records. docs/decisions.md, "Keeping deals current".

import { HD_DRIP_PAGES_PER_DAY } from '../scan/hdPace';
import type { BundleRow, PartRow } from '../scan/types';
import { ENDED_RETRY_MS, priceEndsAt } from './buying';
import type { BundleSignals } from './signals';
import { dayOf } from './state';

const HOUR = 60 * 60_000;

/**
 * Home Depot's price of a Buy now deal is read again at most this often: 6 pages a day each. Home Depot changes prices
 * a few times a day at most (a promotion starting or ending), and 4 hours keeps the price he acts on from the same
 * morning or afternoon while costing three Buy now deals 18 of the drip's 240 pages a day.
 */
export const HD_RECHECK_BUY_NOW_MS = 4 * HOUR;
/** Home Depot's price of a watched deal (not Buy now) is read again at most this often: 2 pages a day each. */
export const HD_RECHECK_WATCHED_MS = 12 * HOUR;
/**
 * Amazon's price of each part of a Buy now deal is pulled from Keepa again at most this often: Amazon's New price moves
 * more often than Home Depot's (other sellers, the buy box), and a pull is 1 token: 12 a day a part.
 */
export const AMAZON_RECHECK_BUY_NOW_MS = 2 * HOUR;
/** Amazon's price of each part of a watched deal is pulled again at most this often: 2 tokens a day a part. */
export const AMAZON_RECHECK_WATCHED_MS = 12 * HOUR;
/**
 * Home Depot pages a day keeping deals current may take, of the drip's HD_DRIP_PAGES_PER_DAY (240): half, so the pages
 * bundles wait for (a set's items, a bundle's own page) always keep the other half.
 */
export const HD_KEEP_CURRENT_PAGES_PER_DAY = Math.floor(HD_DRIP_PAGES_PER_DAY / 2);
/**
 * Keepa tokens a day keeping deals current may take: a quarter of the day's refill (360 at the recorded 1 a minute), so
 * the lookups that find listings (11 tokens each) keep three quarters. Every pull also stays above the Keepa reserve.
 */
export const KEEPA_KEEP_CURRENT_SHARE = 0.25;
/**
 * A Buy now deal whose Home Depot price or any Amazon price was last checked longer ago than this says so on its row and
 * is not announced: twice the Buy now cadence of Home Depot's price, so one missed read is not enough to say it.
 */
export const PRICES_STALE_MS = 2 * HD_RECHECK_BUY_NOW_MS;
/** A Keepa answer the client cached this recently is reused for a refresh (no token); anything older is pulled again. */
export const KEEP_CURRENT_CACHE_MS = 15 * 60_000;

export type KeepTier = 'buyNow' | 'watched';

export const hdCadence = (tier: KeepTier): number => (tier === 'buyNow' ? HD_RECHECK_BUY_NOW_MS : HD_RECHECK_WATCHED_MS);
export const amazonCadence = (tier: KeepTier): number => (tier === 'buyNow' ? AMAZON_RECHECK_BUY_NOW_MS : AMAZON_RECHECK_WATCHED_MS);

export interface KeptPart {
  asin: string;
  model: string;
  /** When the part's Amazon price was last checked (PartRow.priceCheckedAt, else priceSeenAt); null when never. */
  checkedAt: number | null;
}

/** A deal kept current: watched, Buy now or not. */
export interface KeptDeal {
  key: string;
  model: string;
  tier: KeepTier;
  /** Home Depot's item id, by which its page is read; null when it has none. */
  itemId: string | null;
  link: string | null;
  /** When Home Depot's price was last seen (BundleRow.seenAt: a list read or a page read). */
  hdCheckedAt: number;
  /** Nov 25: the last moment of the promotion's last day, when Home Depot's page states it (buying.ts priceEndsAt); absent when not. */
  priceEndsAt?: number | null;
  /** Each matched part with an Amazon listing, once per listing. */
  parts: KeptPart[];
}

/** What the tracking state says about a deal: watched, and its Buy now signal. */
/** A way to sell's `notBuyNow` that is the page's "cannot be bought" alone (signals.ts: the reasons are joined by "; "). */
const CANNOT_BUY_ONLY = /^Home Depot's page says it (cannot be bought right now|is discontinued) \(read [^;]*\)\.$/;

export interface KeepTracking {
  watch: Readonly<Record<string, { watched: boolean } | undefined>>;
  signals: Readonly<Record<string, { buyNow?: unknown; options?: readonly { notBuyNow?: string | null }[] } | undefined>>;
}

const partsOf = (b: Pick<BundleRow, 'parts' | 'options'>): PartRow[] => [...b.parts, ...b.options.flatMap((o) => o.parts)];

/** The deal as it is kept current, or null when it is not watched. */
export function keptDealOf(b: BundleRow, t: KeepTracking): KeptDeal | null {
  if (t.watch[b.key]?.watched !== true) return null;
  const parts = new Map<string, KeptPart>();
  for (const p of partsOf(b)) {
    if (p.status !== 'matched' || !p.asin || parts.has(p.asin)) continue;
    parts.set(p.asin, { asin: p.asin, model: p.model, checkedAt: p.priceCheckedAt ?? p.priceSeenAt ?? null });
  }
  const sig = t.signals[b.key];
  // Nov 25: a deal held out of Buy now only because Home Depot's page says it cannot be bought is read as often as a Buy now
  // deal: it comes back by itself at the first read that says it can be bought, so that read should not wait 12 hours.
  const onlyPage = sig?.options?.some((o) => CANNOT_BUY_ONLY.test(o.notBuyNow ?? '')) === true;
  const buy = sig?.buyNow;
  return {
    key: b.key, model: b.model || `Set ${b.itemId}`, tier: (buy !== null && buy !== undefined) || onlyPage ? 'buyNow' : 'watched',
    itemId: b.itemId || null, link: b.link, hdCheckedAt: b.seenAt, parts: [...parts.values()],
    ...(b.buying ? { priceEndsAt: priceEndsAt(b.buying) } : {}),
  };
}

/** Every watched deal, Buy now first. */
export function keptDeals(bundles: readonly BundleRow[], t: KeepTracking): KeptDeal[] {
  const out = bundles.flatMap((b) => keptDealOf(b, t) ?? []);
  return out.sort((a, b) => Number(b.tier === 'buyNow') - Number(a.tier === 'buyNow'));
}

/**
 * What the agent keeps beside the store: today's pages and tokens spent keeping deals current, and when each was last
 * tried (`hd:<bundleKey>`, `amazon:<asin>`), so a read that gave no price is not asked again before its cadence.
 */
export interface KeepUsage {
  day: string;
  pages: number;
  tokens: number;
  tried: Record<string, number>;
}

/** The stored usage in its checked shape, today's (another day's counts start at 0; tries older than a day are dropped). */
export function keepUsageOf(v: unknown, now: number): KeepUsage {
  const s = v && typeof v === 'object' ? (v as Partial<KeepUsage>) : {};
  const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
  const today = dayOf(now);
  const tried: Record<string, number> = {};
  if (s.tried && typeof s.tried === 'object') {
    for (const [k, at] of Object.entries(s.tried)) if (typeof at === 'number' && Number.isFinite(at) && now - at < 24 * HOUR) tried[k] = at;
  }
  return s.day === today ? { day: today, pages: n(s.pages), tokens: n(s.tokens), tried } : { day: today, pages: 0, tokens: 0, tried };
}

const tierRank = (t: KeepTier): number => (t === 'buyNow' ? 0 : 1);

/**
 * The deals whose Home Depot price is due to be read again: its cadence passed since it was last seen and since it was
 * last tried. Buy now first, then the oldest checked, then by key.
 */
export function hdDue(deals: readonly KeptDeal[], now: number, tried: Readonly<Record<string, number>> = {}): KeptDeal[] {
  return deals
    .filter((d) => d.itemId !== null && (endedUnread(d, now)
      ? now - (tried[`hd:${d.key}`] ?? 0) >= ENDED_RETRY_MS
      : now - Math.max(d.hdCheckedAt, tried[`hd:${d.key}`] ?? 0) >= hdCadence(d.tier)))
    .sort((a, b) => Number(endedUnread(b, now)) - Number(endedUnread(a, now)) || tierRank(a.tier) - tierRank(b.tier) || a.hdCheckedAt - b.hdCheckedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Nov 25: the deal's Home Depot promotion has ended (the page said when) and its price has not been read since. Such a deal's
 * price is read first, whatever its cadence (at most every ENDED_RETRY_MS while a read gives no price), and a Buy now one is
 * not announced until a read confirms the price (agent/keepCurrent.ts staleBuyKeys).
 */
export function endedUnread(d: Pick<KeptDeal, 'priceEndsAt' | 'hdCheckedAt'>, now: number): boolean {
  return d.priceEndsAt != null && now > d.priceEndsAt && d.hdCheckedAt <= d.priceEndsAt;
}

export interface AmazonDue {
  asin: string;
  model: string;
  /** Buy now when any Buy now deal holds the listing. */
  tier: KeepTier;
  checkedAt: number | null;
}

/** Each listing of the kept deals once, at the best tier of the deals that hold it. */
export function keptListings(deals: readonly KeptDeal[]): AmazonDue[] {
  const out = new Map<string, AmazonDue>();
  for (const d of deals) {
    for (const p of d.parts) {
      const had = out.get(p.asin);
      if (!had) out.set(p.asin, { asin: p.asin, model: p.model, tier: d.tier, checkedAt: p.checkedAt });
      else if (d.tier === 'buyNow') had.tier = 'buyNow';
    }
  }
  return [...out.values()];
}

/**
 * The listings whose Amazon price is due to be pulled again: never checked, or its cadence passed since it was checked and
 * since it was last tried. Buy now first, then the oldest checked (never checked first), then by ASIN.
 */
export function amazonDue(deals: readonly KeptDeal[], now: number, tried: Readonly<Record<string, number>> = {}): AmazonDue[] {
  return keptListings(deals)
    .filter((l) => now - Math.max(l.checkedAt ?? 0, tried[`amazon:${l.asin}`] ?? 0) >= amazonCadence(l.tier))
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || (a.checkedAt ?? 0) - (b.checkedAt ?? 0) || (a.asin < b.asin ? -1 : a.asin > b.asin ? 1 : 0));
}

/** What keeping the deals current costs a day at these cadences, and what is set aside for it. */
export interface KeepCost {
  buyNow: number;
  watched: number;
  /** Distinct Amazon listings of the Buy now deals, and of the other watched deals. */
  listingsBuyNow: number;
  listingsWatched: number;
  pagesPerDay: number;
  tokensPerDay: number;
  /** Pages a day set aside (HD_KEEP_CURRENT_PAGES_PER_DAY). */
  pageShare: number;
  /** Tokens a day set aside, from the refill; null when the refill is not known yet. */
  tokenShare: number | null;
}

/**
 * The daily cost from the real constants and the deals: one Home Depot page a deal each cadence, one Keepa pull (`tokensPerPull`)
 * a listing each cadence. Not a promise: Chrome closed, a refusal or no tokens means fewer.
 */
export function keepCost(deals: readonly KeptDeal[], o: { tokensPerPull: number; refillPerMin: number | null }): KeepCost {
  const day = 24 * HOUR;
  const listings = keptListings(deals);
  const pages = deals.filter((d) => d.itemId !== null).reduce((n, d) => n + day / hdCadence(d.tier), 0);
  const tokens = listings.reduce((n, l) => n + (day / amazonCadence(l.tier)) * o.tokensPerPull, 0);
  return {
    buyNow: deals.filter((d) => d.tier === 'buyNow').length,
    watched: deals.filter((d) => d.tier === 'watched').length,
    listingsBuyNow: listings.filter((l) => l.tier === 'buyNow').length,
    listingsWatched: listings.filter((l) => l.tier === 'watched').length,
    pagesPerDay: Math.round(pages), tokensPerDay: Math.round(tokens),
    pageShare: HD_KEEP_CURRENT_PAGES_PER_DAY,
    tokenShare: o.refillPerMin === null || !(o.refillPerMin > 0) ? null : Math.floor(o.refillPerMin * 24 * 60 * KEEPA_KEEP_CURRENT_SHARE),
  };
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const hours = (ms: number): number => Math.round(ms / HOUR);

/**
 * The honest words for the Agent panel: what keeping the watched deals current costs a day, from the constants and the
 * deals, against what is set aside; and when it does not fit, that the oldest-checked go first and how many wait now.
 * "Keeping 3 Buy now deals and 31 watched deals current: about 80 Home Depot pages a day (Buy now every 4 hours, the
 * others every 12; up to 120 of the 240 read between scans) and about 148 Keepa tokens a day (every 2 and 12 hours; up
 * to 360, a quarter of the refill)." Null when nothing is watched.
 */
export function keepSentence(c: KeepCost, w: { pagesWaiting: number; pullsWaiting: number; keepa: boolean; perHour?: number; fullPerHour?: number }): string | null {
  if (c.buyNow + c.watched === 0) return null;
  const who = [...(c.buyNow > 0 ? [plural(c.buyNow, 'Buy now deal', 'Buy now deals')] : []), ...(c.watched > 0 ? [plural(c.watched, c.buyNow > 0 ? 'other watched deal' : 'watched deal', c.buyNow > 0 ? 'other watched deals' : 'watched deals')] : [])].join(' and ');
  const hd = `about ${plural(c.pagesPerDay, 'Home Depot page', 'Home Depot pages')} a day (Buy now every ${hours(HD_RECHECK_BUY_NOW_MS)} hours, the others every ${hours(HD_RECHECK_WATCHED_MS)}; up to ${c.pageShare} of the ${HD_DRIP_PAGES_PER_DAY} read between scans, free)`;
  const keepa = !w.keepa
    ? 'Amazon prices are not refreshed between scans: Keepa is off or has no key'
    : `about ${plural(c.tokensPerDay, 'Keepa token', 'Keepa tokens')} a day for ${plural(c.listingsBuyNow + c.listingsWatched, 'Amazon price', 'Amazon prices')} (Buy now every ${hours(AMAZON_RECHECK_BUY_NOW_MS)} hours, the others every ${hours(AMAZON_RECHECK_WATCHED_MS)}${c.tokenShare !== null ? `; up to ${c.tokenShare}, a quarter of the refill` : ''}, above your reserve)`;
  const parts = [`Keeping ${who} current: ${hd}${w.keepa ? ` and ${keepa}` : ''}.`];
  if (!w.keepa) parts.push(`${keepa}.`);
  const over: string[] = [];
  if (c.pagesPerDay > c.pageShare) over.push(`${c.pagesPerDay} Home Depot pages a day is more than the ${c.pageShare} set aside`);
  if (w.keepa && c.tokenShare !== null && c.tokensPerDay > c.tokenShare) over.push(`${c.tokensPerDay} Keepa tokens a day is more than the ${c.tokenShare} set aside`);
  if (over.length > 0) parts.push(`${over.join('; ')}: the oldest-checked go first.`);
  const waits = [
    ...(w.pagesWaiting > 0 ? [`${plural(w.pagesWaiting, 'Home Depot price waits', 'Home Depot prices wait')}`] : []),
    ...(w.keepa && w.pullsWaiting > 0 ? [`${plural(w.pullsWaiting, 'Amazon price waits', 'Amazon prices wait')}`] : []),
  ];
  if (waits.length > 0) parts.push(`${waits.join(' and ')} for today's share; they go first tomorrow.`);
  // Home Depot's adaptive ceiling (scan/hdPace.ts dripCeiling): below the full one, Buy now first, the others after the backlog.
  if (w.perHour !== undefined && w.fullPerHour !== undefined && w.perHour < w.fullPerHour) {
    parts.push(`Home Depot's ceiling is ${w.perHour} pages an hour today: Buy now deals are read first, the other watched deals after the pages bundles wait for.`);
  }
  return parts.join(' ');
}

/** When the deal's prices were last checked: Home Depot's, and the oldest of its Amazon prices (null with none checked). */
export function pricesChecked(d: KeptDeal): { homeDepotAt: number; amazonAt: number | null } {
  const ats = d.parts.map((p) => p.checkedAt).filter((x): x is number => x !== null);
  return { homeDepotAt: d.hdCheckedAt, amazonAt: ats.length > 0 ? Math.min(...ats) : null };
}

/**
 * When a Buy now deal's prices were last all checked, when that is longer ago than PRICES_STALE_MS (the oldest of Home
 * Depot's and its Amazon prices); null for a deal that is not Buy now or is current. A part never checked counts as its
 * deal's Home Depot time (it was priced by the scan that read it).
 */
export function staleSince(d: KeptDeal, now: number): number | null {
  if (d.tier !== 'buyNow') return null;
  const c = pricesChecked(d);
  const oldest = Math.min(c.homeDepotAt, c.amazonAt ?? c.homeDepotAt);
  return now - oldest > PRICES_STALE_MS ? oldest : null;
}

// ---------------------------------------------------------------- the verdict, before and after a refresh

/** What a deal's verdict rests on, before and after a refresh. */
export interface DealSnapshot {
  key: string;
  model: string;
  link: string | null;
  buyNow: boolean;
  price: number | null;
  profit: number | null;
  roi: number | null;
  parts: { model: string; asin: string; price: number | null }[];
  /** Why it is not worth buying now (failingOf), when it is not and the signals say; absent otherwise. */
  failing?: string;
}

export function snapshotOf(b: BundleRow, buyNow: boolean, failing?: string | null): DealSnapshot {
  const parts = new Map<string, { model: string; asin: string; price: number | null }>();
  for (const p of partsOf(b)) if (p.asin && !parts.has(p.asin)) parts.set(p.asin, { model: p.model, asin: p.asin, price: p.availability === 'active' ? p.price : null });
  return {
    key: b.key, model: b.model || `Set ${b.itemId}`, link: b.link, buyNow, price: b.price,
    profit: b.estimate?.profit ?? null, roi: b.estimate?.roi ?? null, parts: [...parts.values()],
    ...(failing ? { failing } : {}),
  };
}

/**
 * The condition that fails now, as the signals word it for the way to sell the verdict is about (the one held back for
 * its listings, else the primary one), in mid-sentence form: "est. $16.73 is below your $20 and 17% ROI below your 20%".
 * Null when nothing fails or nothing was judged.
 */
export function failingOf(s: Pick<BundleSignals, 'options' | 'buyPending'> | undefined): string | null {
  if (!s) return null;
  const o = s.options.find((x) => x.optionId === s.buyPending?.optionId) ?? s.options[0];
  const t = o?.notBuyNow?.replace(/\.$/, '');
  if (!t) return null;
  // "Est." and "No sales data" read on after a colon in lower case; a model ("DCS382B sells …") keeps its capitals.
  // "Home Depot's page says it cannot be bought" keeps its capitals too (a name).
  return /^[A-Z][a-z]/.test(t) && !t.startsWith('Home Depot') ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

const usd = (n: number): string => (n < 0 ? `-$${(-n).toFixed(2)}` : `$${n.toFixed(2)}`);
const amazonLink = (asin: string): string => `https://www.amazon.com/dp/${asin}`;

/** Each price that moved, in words with its source link. */
function priceMoves(a: DealSnapshot, b: DealSnapshot): string[] {
  const out: string[] = [];
  if (a.price !== b.price) {
    const where = b.link ? ` (${b.link})` : '';
    out.push(a.price !== null && b.price !== null ? `Home Depot's price went from ${usd(a.price)} to ${usd(b.price)}${where}` : b.price === null ? `Home Depot shows no price now${where}` : `Home Depot's price is ${usd(b.price)} now${where}`);
  }
  for (const p of b.parts) {
    const was = a.parts.find((x) => x.asin === p.asin);
    if (!was || was.price === p.price) continue;
    const where = ` (${amazonLink(p.asin)})`;
    out.push(was.price !== null && p.price !== null ? `Amazon's price of ${p.model} went from ${usd(was.price)} to ${usd(p.price)}${where}` : p.price === null ? `${p.model} has no Amazon New price now${where}` : `Amazon's price of ${p.model} is ${usd(p.price)} now${where}`);
  }
  return out;
}

/** "Est. profit $13.19, was $43.19 (an estimate from your fee settings)." */
function profitWords(a: DealSnapshot, b: DealSnapshot): string {
  if (b.profit === null) return 'No estimate now (it needs a price for every part).';
  const was = a.profit !== null ? `, was ${usd(a.profit)}` : '';
  return `Est. profit ${usd(b.profit)}${was} (an estimate from your fee settings, not your real fees).`;
}

/**
 * What a refresh did to each watched deal's Buy now state, with the before and after and the source links. Nov 25: Buy now
 * is a state, so a flip here is a real change of state.
 * - Left the state (once, as it happens): "PSK1212SB-PCL515B is no longer worth buying: est. $16.73 is below your $20 and
 *   17% ROI below your 20%. Amazon's price of PCL515B went from $79.99 to $53.00 (https://…). Est. profit $16.73, was
 *   $43.19 (an estimate from your fee settings, not your real fees)."
 * - Entered it with a price that moved: "… is worth buying now: Home Depot's price went from …". An entry no price
 *   explains (a listing confirmed, a sales figure or a fee that came) is the signals' own to say.
 * - Stayed in it while its estimate moved (`quiet`, for Activity at most once a day, never sent): "PSK1212SB-PCL633B is
 *   still worth buying: est. profit $35.67, was $38.79 (an estimate from your fee settings)."
 */
export function verdictChanges(before: ReadonlyMap<string, DealSnapshot>, after: readonly DealSnapshot[]): { key: string; sentence: string; better: boolean; quiet?: true }[] {
  const out: { key: string; sentence: string; better: boolean; quiet?: true }[] = [];
  for (const b of after) {
    const a = before.get(b.key);
    if (!a) continue;
    if (a.buyNow && b.buyNow) {
      if (a.profit !== null && b.profit !== null && Math.abs(a.profit - b.profit) >= 0.005) {
        out.push({ key: b.key, sentence: `${b.model} is still worth buying: est. profit ${usd(b.profit)}, was ${usd(a.profit)} (an estimate from your fee settings).`, better: b.profit > a.profit, quiet: true });
      }
      continue;
    }
    if (a.buyNow === b.buyNow) continue;
    const moves = priceMoves(a, b);
    if (b.buyNow) {
      if (moves.length > 0) out.push({ key: b.key, sentence: `${b.model} is worth buying now: ${moves.join('; ')}. ${profitWords(a, b)}`, better: true });
      continue;
    }
    if (!b.failing && moves.length === 0) continue;
    const cause = b.failing ? `${b.failing}.${moves.length > 0 ? ` ${moves.join('; ')}.` : ''}` : `${moves.join('; ')}.`;
    out.push({ key: b.key, sentence: `${b.model} is no longer worth buying: ${cause} ${profitWords(a, b)}`, better: false });
  }
  return out;
}
