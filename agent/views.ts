// What the agent's endpoints answer, built from the store (pure functions; the contract's shapes).

import { beingConfirmedWords } from '../core/src/scan/autoConfirm';
import { backlogSentence, dripPagesPerHour, HD_LIMITS, paceStateOf, pausedSentence } from '../core/src/scan/hdPace';
import { dayOf } from '../core/src/tracking/state';
import { keptDealOf, pricesChecked, staleSince } from '../core/src/tracking/keepCurrent';
import { keepCurrentView } from './keepCurrent';
import type { HomeDepotPaceState } from '../core/src/api/contract';
import type {
  ActivityResponse,
  VersionEntry,
  AgentState,
  AutopilotEntry,
  DripState,
  DealDetail,
  DealEstimate,
  EstimateListings,
  DealHistoryPoint,
  DealIncomplete,
  DealIncompleteEstimate,
  DealUnpricedPart,
  DealRow,
  DealSignals,
  EvidenceQuote,
  QuestionChoice,
  DealsResponse,
  KeyCheckRecord,
  KeyName,
  KeysPresence,
  NeedsLook,
  OutcomeEntry,
  ReviewAnswer,
  ReviewQuestion,
  ReviewResponse,
  RunRecord,
  SettingsResponse,
  SourceLink,
  WatchlistResponse,
  WatchRow,
  WatchState,
} from '../core/src/api/contract';
import type { BundleSignals, HistoryPoint } from '../core/src/tracking/signals';
import type { SanityFinding } from '../core/src/audit/sanity';
import { bogoTagOf, type BogoGroup } from '../core/src/tracking/bogoPairs';
import { DEFAULT_MIN_MONTHLY_SOLD } from '../core/src/settings';
import { estimatedQuestionCost } from '../core/src/assist/cost';
import { liveSuggestion, type StoredSuggestion } from '../core/src/assist/stored';
import { followUpView, followUpWorking, type FollowUpState, type ReviewFollowUp } from '../core/src/research/followUp';
import { waitingSentence } from './reverify';
import type { PipelineView } from '../core/src/scan/pipeline';
import { staleBundleDays } from '../core/src/deals/freshness';
import { limitCopy } from '../core/src/deals/limitCopy';
import { DEAL_SECTION_ORDER } from '../core/src/deals/sections';
import { DEAL_SORTS, sortDealRows, type DealSortKey } from '../core/src/deals/sort';
import { plainVerification } from '../core/src/assist/plain';
import { briefForQuestion, ebayBrief } from '../core/src/brief/view';
import { choicesOf, reviewSignature } from '../core/src/scan/answers';
import { matchState, WAITING_PAGE, WAITING_PARTS, waitingForText } from '../core/src/scan/matchState';
import { DEFAULT_SCAN_SETTINGS, partKey, type BundleRow, type PartRow, type ReportSection, type ReviewItem } from '../core/src/scan/types';
import { estimateBasis, fulfillmentGap } from '../core/src/scan/report';
import type { AuditBundle, StoreData, StoredKeys } from './store';

const monthStartMs = (now: number): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

/** The AI's dollars this calendar month: every suggestion asked, and the eBay judge's share of each run, each once. */

/** Fix round 3: a Home Depot set has no model number; it is named "Set <item id>" wherever a model is shown. */
export const setModel = (b: { model: string; itemId: string; setItems?: number }): string => (b.model === '' && b.setItems !== undefined ? `Set ${b.itemId}` : b.model);

export function aiSpentThisMonth(data: { suggestions: StoredSuggestion[]; runs: RunRecord[] }, now: number): number {
  const since = monthStartMs(now);
  const asks = data.suggestions.filter((s) => s.askedAt >= since).reduce((n, s) => n + (s.costUsd ?? 0), 0);
  // Step 16: a suggestion's brief is a model call of its own, counted in the month it was written.
  const briefs = data.suggestions.reduce((n, s) => n + (s.briefMeta && s.briefMeta.at >= since ? s.briefMeta.costUsd ?? 0 : 0), 0);
  const judge = data.runs.filter((r) => Date.parse(r.startedAt) >= since).reduce((n, r) => n + (r.judgeCostUsd ?? 0), 0);
  return asks + briefs + judge;
}

export const ESTIMATE_BASIS = 'Estimated from your fee settings, not your real Amazon fees.';

export function keysPresence(keys: StoredKeys): KeysPresence {
  return {
    serpapi: Boolean(keys.serpapi),
    keepa: Boolean(keys.keepa),
    anthropic: Boolean(keys.anthropic),
    openai: Boolean(keys.openai),
    ebay: Boolean(keys.ebay?.appId && keys.ebay.certId),
    telegram: Boolean(keys.telegram?.botToken && keys.telegram.chatId),
  };
}

export function settingsResponse(data: Pick<StoreData, 'settings' | 'keys'>): SettingsResponse {
  const { updatedAt, ...settings } = data.settings;
  return { updatedAt, settings, keys: keysPresence(data.keys) };
}

export function amazonLink(asin: string): string {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin)}`;
}

/** Bundle keys an open question holds up: a split by its bundle, a match by every bundle with that part. */
function bundlesNeedingAnswer(bundles: readonly BundleRow[], questions: readonly ReviewItem[]): Set<string> {
  const open = questions.filter((q) => q.answer === null);
  const splits = new Set(open.filter((q) => q.kind === 'split').map((q) => q.subject));
  const parts = new Set(open.filter((q) => q.kind === 'match').map((q) => q.subject));
  const out = new Set<string>(splits);
  for (const b of bundles) {
    if (b.parts.some((p) => parts.has(partKey(b.brand, p.model)))) out.add(b.key);
  }
  return out;
}

type Tracking = StoreData['tracking'];
type WithTracking<K extends keyof StoreData> = Pick<StoreData, K> & Partial<Pick<StoreData, 'tracking'>>;

/** The automatic BOGO group a deal is a pair of, or the starter of; null when none. */
function bogoGroupOf(tracking: Tracking | undefined, key: string): BogoGroup | null {
  const groups = Object.values(tracking?.derived.groups ?? {});
  return groups.find((g) => g.choices.some((c) => c.key === key)) ?? groups.find((g) => g.starterKey === key) ?? null;
}

/** A sanity finding as the app shows it (contract NeedsLook). */
export function needsLookOf(f: SanityFinding): NeedsLook {
  return { kind: f.kind, severity: f.severity, sentence: f.sentence, part: f.part ?? null, asin: f.asin ?? null, links: f.links, clearKey: f.clearKey };
}

function rowOf(b: BundleRow, needsAnswer: boolean, lookups?: Record<string, number>, tracking?: Tracking, sanity?: readonly SanityFinding[]): DealRow {
  const hold = sanity?.find((f) => f.bundleId === b.key && f.severity === 'hold');
  const group = tracking ? bogoGroupOf(tracking, b.key) : null;
  const pair = tracking?.bogoPairs?.[b.key];
  const searches = lookups?.[b.key];
  const track = tracking
    ? {
        watched: tracking.watch[b.key]?.watched === true,
        buyNow: tracking.watch[b.key]?.watched === true && (tracking.signals[b.key]?.buyNow ?? null) !== null,
        ...(tracking.signals[b.key]?.buyPending ? { buyPending: { listings: tracking.signals[b.key]!.buyPending!.listings } } : {}),
        // Signals round 3: the verdict on every row with a complete estimate, watched or not (and on a watched one always).
        ...((tracking.watch[b.key]?.watched === true || b.estimate !== null) && tracking.signals[b.key]?.verdict ? { signalNote: tracking.signals[b.key]!.verdict! } : {}),
        bogo: tracking.bogo[b.key] ? (tracking.bogo[b.key]!.chosen.length > 0 ? ('chosen' as const) : ('choose' as const)) : null,
        bogoPair: pair ? bogoTagOf(pair) : null,
        bogoChoices: group ? { label: group.label, count: group.choices.length, bestId: group.best?.key ?? null, best: group.best?.key === b.key } : null,
      }
    : {};
  return {
    ...track,
    id: b.key,
    bundle: {
      brand: b.brand, model: setModel(b), title: b.title, itemId: b.itemId || null, link: b.link,
      ...(b.setItems !== undefined ? { setItems: b.setItems } : {}),
    },
    section: b.section,
    price: b.price,
    regularPrice: b.regularPrice,
    off: b.percentOff,
    // Nov 23: a bundle waiting for its own Home Depot page carries the code, and is no question for the owner.
    // Step 15: one waiting for Home Depot's part pages carries its code the same way.
    matchState: b.waitingPage ? WAITING_PAGE : b.waitingParts ? WAITING_PARTS : matchState(b),
    ...(b.waitingPage ? { matchKind: WAITING_PAGE } : b.waitingParts ? { matchKind: WAITING_PARTS } : {}),
    // Nov 24: what a split waiting for Home Depot's part pages waits for, named ("Waiting for Home Depot's page of DCB2460C").
    ...(b.waitingParts && b.waitingFor?.length ? { pageWait: `${waitingForText(b.waitingFor)}.` } : {}),
    profit: b.estimate?.profit ?? null,
    ...beforeFulfillmentOf(b),
    roi: b.estimate?.roi ?? null,
    roiRange: { low: b.range.lowest?.roi ?? null, high: b.range.highest?.roi ?? null },
    needsAnswer: needsAnswer && !b.waitingPage && !b.waitingParts,
    updatedAt: new Date(b.seenAt).toISOString(),
    lookup: searches === undefined ? null : { searches },
    ...(b.incomplete ? { incomplete: incompleteOf(b) } : {}),
    ...(hold ? { needsLook: needsLookOf(hold), buyNow: false } : {}),
  };
}

/** Signals round 3: how many of the estimate's counted parts it counts no fulfillment fee for; nothing when none. */
function beforeFulfillmentOf(b: BundleRow): Pick<DealRow, 'beforeFulfillment'> {
  if (!b.estimate) return {};
  const uncovered = new Set(b.uncovered);
  const gap = fulfillmentGap(b.parts.filter((p) => !uncovered.has(p.model)));
  return gap.before.length > 0 ? { beforeFulfillment: { parts: gap.before.length, of: gap.total } } : {};
}

/** Nov 23: the row's incomplete estimate (BundleRow.incomplete, the primary way's). */
function incompleteOf(b: BundleRow): DealIncomplete | null {
  const i = b.incomplete;
  if (!i) return null;
  return { priced: i.priced, total: i.total, pricedNet: i.pricedNet, breakEvenNet: i.breakEvenNet, breakEvenPrice: i.breakEvenPrice, unpriced: i.unpriced.map((u) => u.model) };
}

function rowOfAudit(a: AuditBundle, needsAnswer: boolean, at: string | null): DealRow {
  const section = (DEAL_SECTION_ORDER as readonly string[]).includes(a.section) ? (a.section as ReportSection) : 'split';
  return {
    id: a.key,
    bundle: { brand: a.brand, model: a.model, title: a.title, itemId: a.itemId === null ? null : String(a.itemId), link: null },
    section,
    price: null,
    regularPrice: null,
    off: null,
    matchState: null,
    profit: null,
    roi: null,
    roiRange: { low: null, high: null },
    needsAnswer,
    updatedAt: at ?? new Date(0).toISOString(),
    lookup: null,
  };
}

export function parseSort(v: string | null): DealSortKey {
  return DEAL_SORTS.some((s) => s.key === v) ? (v as DealSortKey) : 'profit';
}

export function parseSection(v: string | null): ReportSection | undefined {
  return (DEAL_SECTION_ORDER as readonly string[]).includes(v ?? '') ? (v as ReportSection) : undefined;
}

/** Every bundle as a row: the panel's rows, then audit-only bundles the panel does not have. */
function allRows(data: WithTracking<'deals' | 'review'>): DealRow[] {
  const need = bundlesNeedingAnswer(data.deals.bundles, data.review.questions);
  const rows = data.deals.bundles.map((b) => rowOf(b, need.has(b.key), data.deals.lookups, data.tracking, data.deals.sanity));
  const have = new Set(rows.map((r) => r.id));
  for (const a of data.deals.auditBundles) {
    if (!have.has(a.key)) rows.push(rowOfAudit(a, need.has(a.key), data.deals.auditAt));
  }
  return rows;
}

/** A queue whose next look is this far past is stale (the agent stopped): it no longer says "being confirmed". */
const QUEUE_STALE_MS = 15 * 60_000;

/** "PBP004 is listed under the brand TTI; PCG002 under the brand ONEAND", or "PBP004: no part number in Amazon's record". */
export function unconfirmableWords(items: { model: string; reason: string }[]): string {
  let listedSaid = false;
  return items.map(({ model, reason }) => {
    if (!reason.startsWith('listed under')) return `${model}: ${reason}`;
    const words = listedSaid ? `${model} ${reason.replace(/^listed /, '')}` : `${model} is ${reason}`;
    listedSaid = true;
    return words;
  }).join('; ');
}

/**
 * The listing ladder: a deal's counted listings that nobody confirmed, in words that say what is really happening, from
 * the agent's queue (AgentRuntime.autoConfirm): "2 listings are being confirmed — next check in about 4 min" only for
 * listings a rung that can run will read at a known time. Otherwise each listing's reason, from what was read: "2 listings
 * could not be confirmed: PBP004 is listed under the brand TTI; PCG002 under the brand ONEAND. Confirm or replace them."
 * and the row's buyPending says `blocked`. Never a claim with nothing behind it.
 */
export function confirmingNote(r: DealRow, data: WithTracking<'runtime'>, now: number): DealRow {
  const s = data.tracking?.signals[r.id];
  if (!s) return r;
  const unconfirmed = [...new Set(s.options.flatMap((o) => o.unconfirmed ?? []))];
  if (unconfirmed.length === 0) return r;
  const q = data.runtime.autoConfirm;
  const live = q?.nextAt !== undefined && q.nextAt !== null && q.nextAt >= now - QUEUE_STALE_MS;
  const queued = live ? unconfirmed.filter((a) => (q!.queue ?? []).includes(a)).length : 0;
  const n = unconfirmed.length;
  const reasons = unconfirmed.flatMap((a) => (q?.unconfirmable?.[a] ? [q.unconfirmable[a]!] : []));
  const words = queued > 0
    ? beingConfirmedWords(queued, q!.nextAt!, now)
    : reasons.length === n
      ? `${n} ${n === 1 ? 'listing' : 'listings'} could not be confirmed: ${unconfirmableWords(reasons)}. Confirm or replace ${n === 1 ? 'it' : 'them'}`
      : `${n} ${n === 1 ? 'listing' : 'listings'} could not be confirmed from Amazon's data — Confirm ${n === 1 ? 'it' : 'them'} (1 search each)`;
  const said = r.signalNote?.replace(/\d+ listings? (?:not confirmed yet|(?:is|are) being confirmed first)/, words);
  const blocked = queued === 0 && r.buyPending !== undefined;
  return {
    ...r,
    ...(said !== undefined ? { signalNote: said } : {}),
    ...(blocked ? { buyPending: { ...r.buyPending!, blocked: true } } : {}),
  };
}

/**
 * Home Depot's pace for the state and the waiting rows: what the agent last counted waiting (runtime.hdBacklog) and the
 * pace's own state (runtime.hdPace), in figures and in the words built from them. Null before anything was counted and
 * while reading is not paused.
 */
export function homeDepotView(data: Pick<StoreData, 'runtime'>, now: number): HomeDepotPaceState | null {
  const b = data.runtime.hdBacklog;
  const s = paceStateOf(data.runtime.hdPace);
  const paused = s.pausedUntil !== null && s.pausedUntil > now ? s.pausedUntil : null;
  if (!b && paused === null) return null;
  const pages = b?.pages ?? 0;
  return {
    pausedUntil: paused === null ? null : new Date(paused).toISOString(),
    pagesWaiting: pages, setsWaiting: b?.sets ?? 0, bundlesWaiting: b?.bundles ?? 0,
    perHour: dripPagesPerHour(), perDay: HD_LIMITS.dripPagesPerDay, perScan: HD_LIMITS.pagesPerScan,
    readToday: s.day === dayOf(now) ? s.dripPages : 0,
    sentence: backlogSentence({ pages, sets: b?.sets ?? 0, bundles: b?.bundles ?? 0, pausedUntil: paused }) ?? (paused !== null ? pausedSentence(paused) : null),
  };
}

/**
 * Keeping deals current: a watched row says when its Home Depot price and its Amazon prices were last checked, and a Buy
 * now row whose prices are older than the stated limit since when (core/src/tracking/keepCurrent.ts). Never replaced by
 * the verdict: a separate field the row and the inspector show beside it.
 */
export function keptNote(r: DealRow, data: Pick<StoreData, 'deals'> & Partial<Pick<StoreData, 'tracking'>>, now: number): DealRow {
  const b = data.tracking ? data.deals.bundles.find((x) => x.key === r.id) : undefined;
  const d = b && data.tracking ? keptDealOf(b, data.tracking) : null;
  if (!d) return r;
  const c = pricesChecked(d);
  const stale = staleSince(d, now);
  return { ...r, pricesChecked: { homeDepotAt: iso(c.homeDepotAt), amazonAt: c.amazonAt === null ? null : iso(c.amazonAt), ...(stale !== null ? { staleSince: iso(stale) } : {}) } };
}

/** Home Depot's pace: a row waiting for its Home Depot page says how many pages wait in all and when they are read. */
export function pageWaitNote(r: DealRow, hd: HomeDepotPaceState | null): DealRow {
  return r.matchKind === WAITING_PAGE && hd?.sentence ? { ...r, pageWait: hd.sentence } : r;
}

export function dealsResponse(
  data: WithTracking<'deals' | 'review' | 'runtime' | 'settings'>,
  query: { sort: DealSortKey; section?: ReportSection },
  now: number,
): DealsResponse {
  const hd = homeDepotView(data, now);
  const rows = allRows(data).filter((r) => !query.section || r.section === query.section).map((r) => keptNote(pageWaitNote(confirmingNote(r, data, now), hd), data, now));
  const ordered = DEAL_SECTION_ORDER.flatMap((s) =>
    sortDealRows(
      rows.filter((r) => r.section === s).map((r) => ({
        r, percentOff: r.off, profit: r.profit, roi: r.roi, roiLowest: r.roiRange.low, roiHighest: r.roiRange.high, breakEven: r.incomplete?.breakEvenNet ?? null,
        beforeFulfillment: (r.beforeFulfillment?.parts ?? 0) > 0,
      })),
      query.sort,
    ).map((x) => x.r),
  );
  const lastJob = data.runtime.lastJob;
  const bundles = data.deals.bundles;
  const limit =
    lastJob && bundles.length
      ? limitCopy(
          { lastJob, searchesPerScan: data.settings.settings.searchesPerScan, rateLimitPerHour: data.runtime.serp?.rateLimitPerHour ?? null, now, keepaRefillPerMin: data.runtime.keepa?.refillRate ?? null },
          bundles,
        )
      : null;
  return {
    at: data.deals.at ?? data.deals.auditAt,
    sort: query.sort,
    rows: ordered,
    staleDays: bundles.length ? staleBundleDays(bundles, now, DEFAULT_SCAN_SETTINGS.freshnessMs) : null,
    notices: { limit: limit ? { title: limit.title, text: limit.text } : null, ebay: lastJob?.ebayNotice ?? null },
  };
}

/**
 * The fees an estimate rests on in one sentence (rule 5). Signals round 2: with Keepa's FBA fee on, which parts took it and
 * which took the flat fee (core's estimateBasis); `parts` are the counted parts, each with the fees the estimate used.
 */
export function feeBasis(fees: StoreData['settings']['settings']['fees'], parts: Pick<PartRow, 'model' | 'qty' | 'fees'>[] = []): string {
  return estimateBasis(fees, parts);
}

function estimateOf(b: BundleRow, fees: StoreData['settings']['settings']['fees']): DealEstimate | null {
  if (!b.estimate) return null;
  const uncovered = new Set(b.uncovered);
  const partsSellFor = b.parts.reduce((sum, p) => sum + (p.price !== null && !uncovered.has(p.model) ? p.price * p.qty : 0), 0);
  return {
    profit: b.estimate.profit,
    roi: b.estimate.roi,
    cost: b.estimate.cost,
    partsSellFor: Math.round(partsSellFor * 100) / 100,
    afterFees: b.estimate.netRevenue,
    basis: feeBasis(fees, b.parts.filter((p) => !uncovered.has(p.model))),
    // Nov 23: an estimate exists only when every model part is priced, so only items with no model number are left
    // here; DEFAULT_SCAN_SETTINGS.liquidationRate is 0, so they are not counted until the owner confirms a price.
    countedAtZero: DEFAULT_SCAN_SETTINGS.liquidationRate === 0 ? [...b.uncovered] : [],
    ...listingsOf(b.parts.filter((p) => !uncovered.has(p.model))),
  };
}

/**
 * Catalog check: the estimate's parts by what their listing rests on. Verified: a listing graded exact or strong (Amazon's
 * catalog, a product page's part number or barcode) or the owner's choice; a title match: graded probable. A part priced
 * only by a confirmed price, with no listing, is neither.
 */
export function listingsOf(parts: Pick<BundleRow['parts'][number], 'grade' | 'verifiedBy' | 'asin'>[]): { listings?: EstimateListings } {
  const listed = parts.filter((p) => p.asin !== null);
  const verified = listed.filter((p) => p.grade === 'exact' || p.grade === 'strong' || p.verifiedBy === 'owner').length;
  const titleMatches = listed.filter((p) => p.grade === 'probable' && p.verifiedBy !== 'owner').length;
  if (verified + titleMatches === 0) return {};
  const noun = (n: number) => (n === 1 ? 'part' : 'parts');
  const said = [
    ...(verified > 0 ? [`${verified} ${noun(verified)} on ${verified === 1 ? 'a verified listing' : 'verified listings'}`] : []),
    ...(titleMatches > 0 ? [`${titleMatches}${verified > 0 ? '' : ` ${noun(titleMatches)}`} on ${titleMatches === 1 ? 'a title match' : 'title matches'}`] : []),
  ];
  return { listings: { verified, titleMatches, label: `${said.join(', ')}.` } };
}

const ACTION_OF: Record<DealUnpricedPart['state'], DealUnpricedPart['action']> = {
  waiting: 'look_up', review: 'answer', no_listing: 'confirm_price', inactive: 'confirm_price',
};

/**
 * Nov 23: the deal's incomplete estimate, each unpriced part with its state and the one action that moves it forward;
 * for a kit, whether its page is read and how many parts it lists. `questionOf`: the open match question of a part key.
 */
function incompleteEstimateOf(
  b: BundleRow, fees: StoreData['settings']['settings']['fees'], questionOf: (key: string) => string | null,
): DealIncompleteEstimate | null {
  const i = b.incomplete;
  if (!i) return null;
  const primary = b.options[0];
  const parts = i.unpriced.map((u): DealUnpricedPart => {
    const way = b.options.find((o) => o.splitKits.includes(u.model));
    const unread = b.kitsNotRead.includes(u.model);
    const kit = way
      ? { pageRead: true, parts: way.kitParts?.[u.model] ?? null, waiting: way.parts.filter((p) => p.status === 'waiting' || p.status === 'unmatched').length }
      : unread ? { pageRead: false, parts: null, waiting: 0 } : undefined;
    const questionId = u.state === 'review' ? questionOf(partKey(b.brand, u.model)) : null;
    const row = primary?.parts.find((p) => p.model === u.model);
    return {
      model: u.model, qty: u.qty, state: u.state, action: ACTION_OF[u.state], questionId, ...(kit ? { kit } : {}),
      ...(row?.priceSuggestion ? { priceSuggestion: row.priceSuggestion } : {}),
      ...(row?.fact ? { fact: row.fact } : {}),
    };
  });
  const sold = (primary?.splitKits ?? []).map((k) => `Sold as ${k}'s ${primary?.kitParts?.[k] ?? 'listed'} parts`);
  return {
    ...incompleteOf(b)!,
    cost: i.cost,
    basis: feeBasis(fees, (primary?.parts ?? []).filter((p) => p.fees !== undefined)),
    parts,
    notCounted: (primary?.unnamed ?? []).filter((x) => x.price === null).map((x) => x.name),
    soldAs: sold.length ? sold.join('; ') : null,
    ...(i.ifAccepted ? { ifAccepted: i.ifAccepted } : {}),
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function watchStateOf(tracking: Tracking | undefined, key: string): WatchState | null {
  const w = tracking?.watch[key];
  return w ? { watched: w.watched, by: w.by, since: iso(w.since) } : null;
}

export function signalsView(s: BundleSignals | undefined): DealSignals | null {
  return s ? { at: iso(s.at), ...(s.verdict ? { verdict: s.verdict } : {}), buyNow: s.buyNow, signals: s.signals, options: s.options } : null;
}

export function historyView(points: readonly HistoryPoint[] | undefined): DealHistoryPoint[] {
  return (points ?? []).map((p) => ({
    at: iso(p.at), section: p.section, price: p.price, amazonNew: p.amazonNew,
    profit: p.options[0]?.profit ?? null, roiPercent: p.options[0]?.roiPercent ?? null,
    monthlySold: p.monthlySold, salesRank: p.salesRank, offers: p.offers,
  }));
}

/** GET /api/watchlist: the watched bundles, those worth buying now first, then by estimated profit. */
export function watchlistResponse(data: WithTracking<'deals' | 'review' | 'settings'>): WatchlistResponse {
  const t = data.tracking;
  const a = data.settings.alerts;
  const thresholds = { minProfit: a.minProfit, minRoiPercent: a.minRoiPercent, minMonthlySold: a.minMonthlySold ?? DEFAULT_MIN_MONTHLY_SOLD, floorProfit: a.floorProfit ?? a.minProfit };
  if (!t) return { at: null, rows: [], thresholds };
  const need = bundlesNeedingAnswer(data.deals.bundles, data.review.questions);
  const rows: WatchRow[] = data.deals.bundles
    .filter((b) => t.watch[b.key]?.watched)
    .map((b) => ({ row: rowOf(b, need.has(b.key), data.deals.lookups, t, data.deals.sanity), watch: watchStateOf(t, b.key)!, signals: signalsView(t.signals[b.key]) }));
  rows.sort((x, y) => Number(y.row.buyNow) - Number(x.row.buyNow) || (y.row.profit ?? -Infinity) - (x.row.profit ?? -Infinity));
  const ats = Object.values(t.signals).map((s) => s.at);
  return { at: ats.length ? iso(Math.max(...ats)) : null, rows, thresholds };
}

export function dealDetail(data: WithTracking<'deals' | 'review' | 'settings'> & Partial<Pick<StoreData, 'runtime'>>, id: string, now?: number): DealDetail | null {
  const found = data.deals.bundles.find((b) => b.key === id);
  if (!found) return null;
  // The listing ladder, round 2: each counted listing no automatic rung will read says why (PartRow.confirmNote).
  const notes = data.runtime?.autoConfirm?.unconfirmable ?? {};
  // The app replaces a wrong listing itself: a part being re-checked says what was withdrawn and tried (PartRow.recheck).
  const bundle = {
    ...found,
    parts: found.parts.map((p) => (p.recheck ? { ...p, confirmNote: p.recheck.sentence } : p.asin && notes[p.asin] ? { ...p, confirmNote: notes[p.asin]!.reason } : p)),
  };
  const t = data.tracking;
  const need = bundlesNeedingAnswer([bundle], data.review.questions);
  const sources: SourceLink[] = [];
  if (bundle.link) sources.push({ label: `Home Depot: ${bundle.brand} ${bundle.model}`, url: bundle.link, source: 'homedepot' });
  for (const p of bundle.parts) {
    if (p.asin) sources.push({ label: `Amazon: ${p.model}`, url: amazonLink(p.asin), source: 'amazon' });
  }
  const bogo = t?.bogo[id] ? t.derived.bogo[id] : undefined;
  if (bogo?.link) sources.push({ label: 'Home Depot: the BOGO promotion', url: bogo.link, source: 'homedepot' });
  for (const c of bogo?.chosen ?? []) if (c.link) sources.push({ label: `Home Depot: free ${c.model}`, url: c.link, source: 'homedepot' });
  for (const c of bogo?.counted ?? []) if (c.asin) sources.push({ label: `Amazon: free ${c.model}`, url: amazonLink(c.asin), source: 'amazon' });
  const group = t ? bogoGroupOf(t, id) : null;
  const looks = (data.deals.sanity ?? []).filter((f) => f.bundleId === id).map(needsLookOf);
  if (group) sources.push({ label: `Home Depot: the BOGO starter ${group.starterModel}`, url: group.starterLink, source: 'homedepot' });
  return {
    row: keptNote(
      data.runtime ? confirmingNote(rowOf(bundle, need.has(bundle.key), data.deals.lookups, t, data.deals.sanity), { runtime: data.runtime, tracking: t }, now ?? Date.now()) : rowOf(bundle, need.has(bundle.key), data.deals.lookups, t, data.deals.sanity),
      data, now ?? Date.now(),
    ),
    bundle,
    sources,
    estimateBasis: ESTIMATE_BASIS,
    estimate: estimateOf(bundle, data.settings.settings.fees),
    ...(bundle.incomplete
      ? {
          incompleteEstimate: incompleteEstimateOf(bundle, data.settings.settings.fees, (key) =>
            data.review.questions.find((q) => q.answer === null && q.kind === 'match' && q.subject === key)?.id ?? null),
        }
      : {}),
    ...(t
      ? {
          watch: watchStateOf(t, id),
          signals: t.watch[id]?.watched ? signalsView(t.signals[id]) : null,
          history: historyView(t.history[id]),
          bogo: bogo ?? null,
          bogoGroup: group,
          fbaEstimate: t.derived.fba[id] ?? null,
        }
      : {}),
    ...(bundle.splitEvidence && bundle.splitEvidence.length > 0 ? { splitEvidence: bundle.splitEvidence } : {}),
    ...(bundle.otherBrands && bundle.otherBrands.length > 0 ? { setContents: bundle.otherBrands } : {}),
    ...(looks.length > 0 ? { needsLook: looks } : {}),
  };
}

/** The newest suggestion asked for a question, or null. */
export function latestSuggestion(suggestions: readonly StoredSuggestion[], questionId: string): StoredSuggestion | null {
  let best: StoredSuggestion | null = null;
  for (const s of suggestions) if (s.questionId === questionId && (!best || s.askedAt > best.askedAt)) best = s;
  return best;
}

/**
 * A "Which listing" question the re-check opened (core/src/scan/recheck.ts): each listing the app tried and why it was not
 * taken, shown as what the app already did (the card's checked list), so the owner starts where the app stopped.
 */
export function recheckFollowUp(q: ReviewItem): ReviewFollowUp | undefined {
  if (!q.tried || q.tried.length === 0) return undefined;
  return {
    state: 'gave_up',
    tried: q.tried.map((t) => ({ what: `Tried ${t.asin}`, result: t.passed ? `passes the app's checks: ${t.reason}` : t.reason, url: amazonLink(t.asin) })),
    roundsLeft: 0,
  };
}

/** The question in a sentence. */
function promptOf(q: ReviewItem): string {
  return q.kind === 'split' ? `What is inside the ${q.brand} ${q.model}?` : `Which Amazon listing is the ${q.brand} ${q.model}?`;
}

function choicesFor(q: ReviewItem): QuestionChoice[] {
  if (q.kind === 'split') {
    return choicesOf(q).map((parts, i) => ({ id: `choice:${i}`, label: parts.join(', '), models: [...parts], asin: null, source: null }));
  }
  return q.candidates.map((c, i) => ({
    id: `choice:${i}`, label: c.title || c.asin, models: [], asin: c.asin, source: { label: 'Amazon listing', url: amazonLink(c.asin) },
  }));
}

function quotesOf(s: StoredSuggestion | null): EvidenceQuote[] {
  if (!s) return [];
  const sug = s.suggestion;
  if (sug.status !== 'verified' && sug.status !== 'cannot_tell' && sug.status !== 'none_suggested') return [];
  return sug.quotes.map((q) => ({ text: q.quote, source: { label: q.label, url: q.url } }));
}

export function reviewResponse(data: Pick<StoreData, 'review' | 'suggestions' | 'deals' | 'settings'>): ReviewResponse {
  const ai = data.settings.ai;
  const questions: ReviewQuestion[] = [];
  const bundleOfPart = (subject: string): string | null =>
    data.deals.bundles.find((b) => b.parts.some((p) => partKey(b.brand, p.model) === subject))?.key ?? null;
  for (const q of data.review.questions) {
    if (q.answer !== null) continue;
    const bundleId = q.kind === 'split' ? q.subject : bundleOfPart(q.subject);
    const bundle = data.deals.bundles.find((b) => b.key === bundleId);
    const sources: SourceLink[] = [];
    if (bundle?.link) sources.push({ label: `Home Depot: ${bundle.brand} ${bundle.model}`, url: bundle.link, source: 'homedepot' });
    // A listing question: Home Depot's page of the part sold alone too, beside its price (the price guard compares the two).
    const hdPart = q.kind === 'match' ? bundle?.parts.find((p) => p.model === q.model)?.prices.find((o) => o.kind === 'homedepot' && o.link) : undefined;
    if (hdPart?.link) sources.push({ label: `Home Depot: ${q.brand} ${q.model} sold alone, $${hdPart.price}`, url: hdPart.link, source: 'homedepot' });
    for (const c of q.candidates) if (c.asin) sources.push({ label: `Amazon: ${c.title || c.asin}`, url: amazonLink(c.asin), source: 'amazon' });
    const live = liveSuggestion(data.suggestions, q) ?? null;
    const shown = live ?? latestSuggestion(data.suggestions, q.id);
    // Step 15, rule 5: a suggestion the code did not verify says why in one plain sentence; the reasons stay for Activity.
    const plain = shown && shown.suggestion.status === 'unverified' ? plainVerification(shown.suggestion.reasons, q.kind) : null;
    // Step 16: an unverified answer waiting for Home Depot's page of a model it names (agent/reverify.ts).
    const waiting = live && live.suggestion.status === 'unverified' ? waitingSentence(live.waitingFor) : null;
    // Step 16: what the app is doing or did about it (the follow-up loop), and the check line that says so.
    const state = followUpStateOf(data.review, data.suggestions, q);
    const followUp = state ? followUpView(state) : recheckFollowUp(q);
    // Step 16 (round 2): when Home Depot's pages confirmed some parts and not others, the question is about those only: from the
    // scan's own part readings (rule 2), else from the follow-up loop's reads.
    const narrow = q.kind === 'split' ? (q.unsettledParts?.length ? { settled: q.settledParts ?? [], unsettled: q.unsettledParts } : state?.parts) : undefined;
    questions.push({
      id: q.id,
      kind: q.kind,
      bundleId,
      brand: q.brand,
      model: q.model,
      title: q.title,
      reason: q.reason,
      sources,
      suggestion: shown,
      item: { kind: q.kind, question: q },
      seen: reviewSignature(q),
      prompt: promptOf(q),
      evidence: data.review.evidence?.[q.id] ?? [],
      choices: choicesFor(q),
      askCostUsd: q.kind === 'match' && q.candidates.length === 0 ? null : estimatedQuestionCost(q.kind, (q.kind === 'split' ? ai.research : ai.assist).model),
      suggestionQuotes: quotesOf(live),
      ...(plain !== null ? { suggestionPlain: plain } : {}),
      brief: briefForQuestion(q, live, data.review.evidence?.[q.id] ?? [], sources, followUp, narrow),
      ...(narrow ? { unsettledParts: narrow.unsettled.map((p) => p.model), settledParts: narrow.settled.map((p) => ({ model: p.model, what: p.what, ...(p.url ? { url: p.url } : {}) })) } : {}),
      ...(waiting !== null ? { waitingFor: waiting } : {}),
      ...(followUp ? { followUp } : {}),
    });
  }
  // Nov 23: eBay identity questions are in Review only when the owner asked for them (ebaySettings.askAboutListings); else
  // the listing is left out of the part's eBay reference range and stays answerable by its id under the part.
  for (const e of asksAboutEbay(data.settings) ? data.review.ebayQuestions : []) {
    questions.push({
      id: e.id,
      kind: 'ebay',
      bundleId: bundleOfPart(e.key),
      brand: e.brand,
      model: e.model,
      title: e.title,
      reason: e.reasons.join(' '),
      sources: e.url ? [{ label: `eBay: ${e.title}`, url: e.url, source: 'ebay' }] : [],
      suggestion: null,
      item: { kind: 'ebay', question: e },
      prompt: `Is this eBay listing the ${e.brand} ${e.model}?`,
      evidence: e.url ? [{ text: e.title, source: { label: 'eBay listing', url: e.url } }] : [],
      choices: [],
      askCostUsd: null,
      suggestionQuotes: [],
      brief: ebayBrief(e),
    });
  }
  return { at: data.review.at, questions };
}

/** Nov 23: whether eBay identity questions go to Review (off by default; a stored install without the field is off). */
export const asksAboutEbay = (settings: Pick<StoreData['settings'], 'ebaySettings'>): boolean => settings.ebaySettings?.askAboutListings === true;

/** Open questions; eBay identity questions only when the owner asks about them (`ebay`, default off). */
export function openReviewCount(review: StoreData['review'], ebay = false): number {
  return review.questions.filter((q) => q.answer === null).length + (ebay ? review.ebayQuestions.length : 0);
}

/** Step 16: open questions the app is working on (a follow-up queued or running): not counted in "Needs you". */
export function workingReviewCount(review: StoreData['review'], suggestions: StoreData['suggestions']): number {
  return review.questions.filter((q) => q.answer === null && followUpWorking(followUpStateOf(review, suggestions, q))).length;
}

/**
 * Step 16: the follow-up loop's state of an open question: on its live suggestion, or (round 2) for a question the AI has not
 * answered, the free reads kept in the review collection for the question as it reads now.
 */
export function followUpStateOf(review: StoreData['review'], suggestions: StoreData['suggestions'], q: ReviewItem): FollowUpState | undefined {
  const live = liveSuggestion(suggestions, q);
  if (live) return live.followUp;
  const kept = review.followUps?.[q.id];
  return kept && kept.seen === reviewSignature(q) ? kept.state : undefined;
}

/** Outcomes: two stored records are the same when they serialize alike (what Undo compares). */
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Activity and GET /api/outcomes list this many of the owner's recorded changes. */
export const LISTED_OUTCOME_ENTRIES = 50;

/** The outcome entries as the contract lists them, newest first, with whether Undo still works. */
export function entriesView(data: StoreData['outcomes']): OutcomeEntry[] {
  return [...data.entries]
    .reverse()
    .slice(0, LISTED_OUTCOME_ENTRIES)
    .map((e) => {
      const current = data.purchases.find((p) => p.id === e.purchaseId) ?? null;
      return { id: e.id, at: e.at, purchaseId: e.purchaseId, sentence: e.sentence, undoneAt: e.undoneAt, undoable: e.undoneAt === null && same(current, e.after) };
    });
}

export function activityResponse(data: Pick<StoreData, 'activity' | 'autopilot' | 'suggestions'> & Partial<Pick<StoreData, 'answers' | 'outcomes'>> & { versions?: VersionEntry[] }, sinceIso: string, now: number): ActivityResponse {
  const since = Date.parse(sinceIso);
  const runs = data.activity.runs.filter((r) => Date.parse(r.startedAt) >= since);
  const autopilot: AutopilotEntry[] = data.autopilot.map((e) => ({
    id: e.id, at: e.at, questionId: e.questionId, applied: e.applied, verifiedBy: e.verifiedBy, undoneAt: e.undoneAt,
    answer: e.answer, provider: e.provider, model: e.model, bundleId: e.bundleId ?? null, undoable: e.undoneAt === null && e.undoable !== false,
  }));
  return {
    runs: [...data.activity.runs].reverse(),
    spend: {
      serpSearches: runs.reduce((n, r) => n + r.searchesUsed, 0),
      keepaTokens: runs.reduce((n, r) => n + r.keepaTokensUsed, 0),
      // Asks are counted from their suggestions and the eBay judge from its runs, each once.
      aiUsd: Math.round(aiSpentThisMonth({ suggestions: data.suggestions, runs: data.activity.runs }, now) * 100) / 100,
      since: sinceIso,
    },
    autopilot: autopilot.reverse(),
    // The owner's own answers (ownerAnswers.ts), newest first; what Undo needs stays in the agent.
    answers: (data.answers ?? [])
      .map((a) => ({ id: a.id, questionId: a.questionId, title: a.title, answer: a.answer, at: a.at, undoable: a.undoneAt === null && a.undoable, undoneAt: a.undoneAt }))
      .reverse(),
    ...(data.outcomes ? { outcomes: entriesView(data.outcomes) } : {}),
    // Nov 25: the new versions the app told him about, newest first.
    ...(data.versions && data.versions.length > 0 ? { versions: [...data.versions].reverse() } : {}),
    errors: (data.activity.errors ?? [])
      .filter((e) => e.resolvedAt === null)
      .map((e) => ({ id: e.id, at: e.at, sentence: e.sentence, retry: e.retry ? { label: e.retry.label, searches: e.retry.searches, usd: e.retry.usd } : null }))
      .reverse(),
  };
}

/** What the agent is doing now (work.ts), for the state. */
export interface LiveView {
  connected: boolean;
  lastSeenAt: string | null;
  jobsWaiting: number;
  now: number;
  busy: 'scan' | 'ask' | 'paid' | null;
  stopping: boolean;
  pipeline: PipelineView | null;
  nextScanAt: string | null;
  /** Nov 23: the helper's build, from its heartbeat, and whether it is not the one this app ships. */
  helperVersion?: string | null;
  helperOutdated?: boolean;
  /** Step 15: the drip of Keepa lookups between scans (work.ts dripState). */
  drip?: DripState;
  /**
   * Searches left now: the last account check less the ledger rows written after it (core/src/serpapi/balance.ts). Absent:
   * the last check's own figure (a state built without the agent's ledger).
   */
  serpLeft?: number | null;
}

/** Nov 23: the last scan, with whether Read again can start now (some page unread, Chrome connected, nothing running). */
function lastScanOf(data: StoreData, live: LiveView): AgentState['agent']['lastScan'] {
  const last = data.activity.lastScan;
  if (!last) return null;
  const unread = last.pagesUnread ?? 0;
  return { ...last, canReadPagesAgain: unread > 0 && live.connected && live.busy === null && !live.stopping };
}

/** Nov 23: when each saved key last got a verdict from its own service. A check of a key that is gone is stale and left out. */
function keyChecksOf(data: StoreData): Partial<Record<KeyName, KeyCheckRecord>> | null {
  const out: Partial<Record<KeyName, KeyCheckRecord>> = {};
  for (const [name, rec] of Object.entries(data.runtime.keyChecks ?? {}) as [KeyName, KeyCheckRecord][]) {
    if (data.keys[name] !== undefined && rec) out[name] = { ...rec };
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function agentState(data: StoreData, live: LiveView): AgentState {
  const status = live.stopping ? 'stopping' : live.busy ? 'scanning' : data.agent.paused ? 'paused' : 'idle';
  const view = live.pipeline;
  const keyChecks = keyChecksOf(data) ?? undefined;
  return {
    agent: {
      status,
      ...(view ? { step: view.current.count ? `${view.current.label} · ${view.current.count}` : view.current.label, progress: { done: view.stepsDone, total: view.stepsTotal }, pipeline: view } : {}),
      busy: live.busy === 'paid' ? 'scan' : live.busy,
      nextScanAt: live.nextScanAt,
      lastScan: lastScanOf(data, live),
      ...(data.agent.problem ? { problem: data.agent.problem } : {}),
      ...(live.drip ? { drip: live.drip } : {}),
      ...(homeDepotView(data, live.now) ? { homeDepot: homeDepotView(data, live.now)! } : {}),
      ...(keepCurrentView(data, live.now) ? { keepCurrent: keepCurrentView(data, live.now)! } : {}),
    },
    helper: {
      paired: data.pairing.extensions.length > 0, connected: live.connected, lastSeenAt: live.lastSeenAt, jobsWaiting: live.jobsWaiting,
      ...(live.helperOutdated ? { outdated: true } : {}),
      ...(live.helperVersion ? { version: live.helperVersion } : {}),
    },
    budget: {
      serpLeft: live.serpLeft !== undefined ? live.serpLeft : data.runtime.serp?.left ?? null,
      serpMonthly: data.runtime.serp?.perMonth ?? null,
      serpPerScan: data.settings.settings.searchesPerScan,
      serpReserve: data.settings.settings.reserve,
      keepaTokens: data.runtime.keepa?.tokensLeft ?? null,
      keepaRefillPerMin: data.runtime.keepa?.refillRate ?? null,
      aiSpentUsd: Math.round(aiSpentThisMonth({ suggestions: data.suggestions, runs: data.activity.runs }, live.now) * 100) / 100,
      aiCapUsd: data.settings.ai.monthlyCapUsd,
    },
    counts: {
      review: openReviewCount(data.review, asksAboutEbay(data.settings)) - workingReviewCount(data.review, data.suggestions),
      ...(workingReviewCount(data.review, data.suggestions) > 0 ? { reviewWorking: workingReviewCount(data.review, data.suggestions) } : {}),
      autopilotApplied: data.autopilot.filter((e) => e.undoneAt === null).length,
      newDeals: data.activity.lastScan?.newDeals ?? 0,
      jobsWaiting: live.jobsWaiting,
    },
    keys: keysPresence(data.keys),
    ...(data.runtime.keyProblems && Object.keys(data.runtime.keyProblems).length > 0 ? { keyProblems: { ...data.runtime.keyProblems } } : {}),
    ...(keyChecks ? { keyChecks } : {}),
    firstRun: data.activity.lastScan === null && data.deals.bundles.length === 0,
    settingsAt: data.settings.updatedAt,
  };
}
