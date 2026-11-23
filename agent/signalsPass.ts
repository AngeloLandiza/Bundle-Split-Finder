// Signals round 2: "tell the owner when a bundle is worth buying", whenever a bundle's estimate or completeness changes,
// not only at the end of a scan. The agent's hooks (agent/work.ts) call here after the drip's lookups and price pulls,
// after the catalog check confirms or removes a listing, after an owner's Review answer, Undo or confirmed price, and at
// start. The rules are the scan's (core/src/tracking/signals.ts bundleSignals, through retrackReport), and so is the
// bookkeeping: once per bundle, signal and day (freshSignals), through the notification policy (kinds, quiet hours,
// morning digest). An incomplete estimate never signals (bundleSignals: not confirmed, or no estimate).
//
// Also here: every Keepa product pull keeps its trend (keepingTrends), the report is built with those trends (Keepa's FBA
// fee per part, fees.fulfillmentSource), and the drip's sales pulls: a watched bundle's part whose listing Keepa was never
// asked about is pulled once (1 token, above the reserve, after the lookups), so its sales figure is not left missing.

import type { NotifyEvent } from '../core/src/api/contract';
import type { TokenBudget } from '../core/src/keepa/budget';
import { productTokenEstimate } from '../core/src/keepa/estimates';
import { keepingTrends, readPartTrend, readTrends, writePartTrend } from '../core/src/keepa/trends';
import type { KeepaTrackingDepth } from '../core/src/keepa/types';
import { buildReport } from '../core/src/scan/report';
import { savePrice } from '../core/src/scan/runner';
import type { ScanReport, ScanSettings, ScanStore } from '../core/src/scan/types';
import type { Cache, SearchResult } from '../core/src/serpapi/client';
import { parseAmazonProduct } from '../core/src/serpapi/parsers';
import { pairsBehindBest } from '../core/src/tracking/bogoPairs';
import type { TrendLookup } from '../core/src/tracking/signals';
import { freshSignals, retrackReport, type TrackingState } from '../core/src/tracking/state';
import { buildDigest } from './alerts';
import type { NotifyPolicy } from './notifyPolicy';
import type { Store } from './store';

/** One Keepa product pull as the agent makes it (keepa/fetchStep.ts keepaProductSearchResult). */
export type ProductPull = (asin: string, label: string, maxAgeMs?: number) => Promise<SearchResult>;

/** The pull, writing each product's trend (keepa:trend:<asin>) to the agent's cache as the scan's refreshes do. */
export function pullKeepingTrends(cache: Cache, pull: ProductPull): ProductPull {
  return keepingTrends(pull, (t) => writePartTrend(cache, t));
}

/** The report built from the scan's store with the Keepa trends stored for every matched listing (its FBA fee, referral). */
export async function reportWithTrends(store: ScanStore, settings: ScanSettings, cache: Cache): Promise<ScanReport> {
  const asins = (await store.listMatches()).flatMap((m) => (m.asin ? [m.asin] : []));
  return buildReport(store, settings, { trend: await readTrends(cache, asins) });
}

/** The stored trend of every part a way to sell holds. Reads only. */
export async function trendsOfReport(cache: Cache, report: Pick<ScanReport, 'bundles'>): Promise<TrendLookup> {
  return readTrends(cache, report.bundles.flatMap((b) => b.options.flatMap((o) => o.parts.flatMap((p) => (p.asin ? [p.asin] : [])))));
}

export interface SignalsDeps {
  store: Store;
  cache: Cache;
  now: () => number;
  policy: NotifyPolicy;
  /** Sends the text to Telegram when set up (with what waits), and records a failure. */
  telegram: (text: string | null) => Promise<void>;
  /** Whether a Keepa pull can be made now (a key, Keepa on): the "no sales data" words say what happens next. */
  keepa: () => boolean;
}

export interface SignalsOutcome {
  /** Bundles whose signals were judged again and came out new or changed. */
  evaluated: string[];
  /** The digest's text when one was made (also what Telegram got, unless the policy held it). */
  text: string | null;
}

/**
 * The signals judged again for `report` (retrackReport), stored, and the new buy signals (and margin falls, when the owner
 * asked for them) sent once per bundle, signal and day through the policy. `extra`: a line the caller wants in the same
 * message (the drip's "Keepa lookups between scans gave 2 new estimates"), sent even with no signal.
 */
export async function evaluateSignals(d: SignalsDeps, report: Pick<ScanReport, 'bundles' | 'review'>, extra?: { text: string; count: number }): Promise<SignalsOutcome> {
  const { store } = d;
  const app = store.get('settings');
  const now = d.now();
  const trend = await trendsOfReport(d.cache, report);
  let evaluated: string[] = [];
  store.update('tracking', (t) => {
    const r = retrackReport(t as TrackingState, report, trend, app.alerts, now, { keepa: d.keepa() });
    evaluated = r.evaluated;
    return { ...t, watch: r.state.watch, history: r.state.history, signals: r.state.signals };
  });
  const tracking = store.get('tracking');
  const kinds = app.alerts.marginDownDigest ? (['buyNow', 'marginDown'] as const) : (['buyNow'] as const);
  const fresh = app.alerts.enabled && evaluated.length > 0 ? freshSignals(tracking, kinds, now, new Set(evaluated)) : { lines: [], notified: tracking.notified };
  const behind = pairsBehindBest(Object.values(tracking.derived.groups ?? {}));
  const digest = buildDigest({
    report: { bundles: [], review: [] }, alerts: app.alerts, notifiedDeals: store.get('runtime').notifiedDeals, notifiedQuestions: [], autopilotApplied: 0,
    verifiedWaiting: 0, trendLines: [],
    buyNow: fresh.lines.filter((l) => l.signal.kind === 'buyNow' && !behind.has(l.bundleKey)), marginDown: fresh.lines.filter((l) => l.signal.kind === 'marginDown'),
  });
  if (fresh.lines.length > 0) {
    store.update('runtime', (r) => ({ ...r, notifiedDeals: digest.notifiedDeals }));
    store.update('tracking', (t) => ({ ...t, notified: fresh.notified }));
  }
  const lines = [extra?.text ?? null, digest.text].filter((x): x is string => x !== null && x !== '');
  if (lines.length === 0) return { evaluated, text: null };
  const text = lines.join('\n');
  const event: Omit<NotifyEvent, 'id'> = digest.event
    ? { ...digest.event, body: text, count: (digest.event.count ?? 0) + (extra?.count ?? 0) }
    : { kind: 'deal', title: 'Split Finder', body: text, count: extra?.count ?? 0, route: '/' };
  await d.telegram(d.policy.digest(event, text));
  return { evaluated, text };
}

/**
 * The parts of watched bundles whose listing Keepa was never asked about (no stored trend), each listing once: their
 * sales figure is missing only for want of a pull. A listing Keepa was pulled for that gave no monthlySold is not here
 * (Keepa leaves it out for slow sellers; another pull would say the same).
 */
export function salesPullsWanted(tracking: Pick<TrackingState, 'watch' | 'signals'>): { asin: string; model: string }[] {
  const out = new Map<string, string>();
  for (const s of Object.values(tracking.signals)) {
    if (tracking.watch[s.bundleKey]?.watched !== true) continue;
    for (const o of s.options) {
      if (o.velocity.status !== 'no_data') continue;
      for (const p of o.velocity.parts) if (p.asin && p.monthlySold === null && p.pulledAt === null && !out.has(p.asin)) out.set(p.asin, p.model);
    }
  }
  return [...out].map(([asin, model]) => ({ asin, model }));
}

export interface SalesPullDeps {
  store: ScanStore;
  cache: Cache;
  keepaBudget: Pick<TokenBudget, 'blockReason'>;
  /** A pull that keeps trends (pullKeepingTrends). */
  pull: ProductPull;
  trackingDepth?: KeepaTrackingDepth;
  shouldStop: () => boolean;
}

/**
 * The sales pulls the drip makes after its lookups: each wanted listing pulled once while a pull's tokens are above the
 * reserve (1 token with stats, which carry the sales rank at no extra cost). The pull's price is saved as a refresh's is;
 * its trend is written by the pull. A listing that has a trend by now (a catalog check pulled it) is skipped. Throws what
 * Keepa throws: what was done before stays done.
 */
export async function pullSales(d: SalesPullDeps, wanted: { asin: string; model: string }[]): Promise<{ pulled: number; tokens: number }> {
  const done = { pulled: 0, tokens: 0 };
  const cost = productTokenEstimate(d.trackingDepth, 1);
  for (const w of wanted) {
    if (d.shouldStop() || d.keepaBudget.blockReason(cost) !== null) break;
    if (await readPartTrend(d.cache, w.asin).catch(() => undefined)) continue;
    const r = await d.pull(w.asin, `agent:drip:sales:${w.model}`);
    done.pulled += 1;
    if (r.source === 'network') done.tokens += r.keepaTokens ?? cost;
    const page = parseAmazonProduct(r.data, w.asin);
    if (page && page.asin === w.asin) await savePrice({ store: d.store }, w.asin, page, r.at);
  }
  return done;
}
