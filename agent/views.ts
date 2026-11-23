// What the agent's endpoints answer, built from the store (pure functions; the contract's shapes).

import type {
  ActivityResponse,
  AgentState,
  AutopilotEntry,
  DripState,
  DealDetail,
  DealEstimate,
  DealHistoryPoint,
  DealRow,
  DealSignals,
  EvidenceQuote,
  QuestionChoice,
  DealsResponse,
  KeysPresence,
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
import { bogoTagOf, type BogoGroup } from '../core/src/tracking/bogoPairs';
import { DEFAULT_MIN_MONTHLY_SOLD } from '../core/src/settings';
import { estimatedQuestionCost } from '../core/src/assist/cost';
import { liveSuggestion, type StoredSuggestion } from '../core/src/assist/stored';
import type { PipelineView } from '../core/src/scan/pipeline';
import { staleBundleDays } from '../core/src/deals/freshness';
import { limitCopy } from '../core/src/deals/limitCopy';
import { DEAL_SECTION_ORDER } from '../core/src/deals/sections';
import { DEAL_SORTS, sortDealRows, type DealSortKey } from '../core/src/deals/sort';
import { plainVerification } from '../core/src/assist/plain';
import { choicesOf, reviewSignature } from '../core/src/scan/answers';
import { matchState, WAITING_PAGE, WAITING_PARTS } from '../core/src/scan/matchState';
import { DEFAULT_SCAN_SETTINGS, partKey, type BundleRow, type ReportSection, type ReviewItem } from '../core/src/scan/types';
import type { AuditBundle, StoreData, StoredKeys } from './store';

const monthStartMs = (now: number): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

/** The AI's dollars this calendar month: every suggestion asked, and the eBay judge's share of each run, each once. */
export function aiSpentThisMonth(data: { suggestions: StoredSuggestion[]; runs: RunRecord[] }, now: number): number {
  const since = monthStartMs(now);
  const asks = data.suggestions.filter((s) => s.askedAt >= since).reduce((n, s) => n + (s.costUsd ?? 0), 0);
  const judge = data.runs.filter((r) => Date.parse(r.startedAt) >= since).reduce((n, r) => n + (r.judgeCostUsd ?? 0), 0);
  return asks + judge;
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

function rowOf(b: BundleRow, needsAnswer: boolean, lookups?: Record<string, number>, tracking?: Tracking): DealRow {
  const group = tracking ? bogoGroupOf(tracking, b.key) : null;
  const pair = tracking?.bogoPairs?.[b.key];
  const searches = lookups?.[b.key];
  const track = tracking
    ? {
        watched: tracking.watch[b.key]?.watched === true,
        buyNow: tracking.watch[b.key]?.watched === true && (tracking.signals[b.key]?.buyNow ?? null) !== null,
        bogo: tracking.bogo[b.key] ? (tracking.bogo[b.key]!.chosen.length > 0 ? ('chosen' as const) : ('choose' as const)) : null,
        bogoPair: pair ? bogoTagOf(pair) : null,
        bogoChoices: group ? { label: group.label, count: group.choices.length, bestId: group.best?.key ?? null, best: group.best?.key === b.key } : null,
      }
    : {};
  return {
    ...track,
    id: b.key,
    bundle: { brand: b.brand, model: b.model, title: b.title, itemId: b.itemId || null, link: b.link },
    section: b.section,
    price: b.price,
    regularPrice: b.regularPrice,
    off: b.percentOff,
    // Nov 23: a bundle waiting for its own Home Depot page carries the code, and is no question for the owner.
    // Step 15: one waiting for Home Depot's part pages carries its code the same way.
    matchState: b.waitingPage ? WAITING_PAGE : b.waitingParts ? WAITING_PARTS : matchState(b),
    ...(b.waitingPage ? { matchKind: WAITING_PAGE } : b.waitingParts ? { matchKind: WAITING_PARTS } : {}),
    profit: b.estimate?.profit ?? null,
    roi: b.estimate?.roi ?? null,
    roiRange: { low: b.range.lowest?.roi ?? null, high: b.range.highest?.roi ?? null },
    needsAnswer: needsAnswer && !b.waitingPage && !b.waitingParts,
    updatedAt: new Date(b.seenAt).toISOString(),
    lookup: searches === undefined ? null : { searches },
  };
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
  const rows = data.deals.bundles.map((b) => rowOf(b, need.has(b.key), data.deals.lookups, data.tracking));
  const have = new Set(rows.map((r) => r.id));
  for (const a of data.deals.auditBundles) {
    if (!have.has(a.key)) rows.push(rowOfAudit(a, need.has(a.key), data.deals.auditAt));
  }
  return rows;
}

export function dealsResponse(
  data: WithTracking<'deals' | 'review' | 'runtime' | 'settings'>,
  query: { sort: DealSortKey; section?: ReportSection },
  now: number,
): DealsResponse {
  const rows = allRows(data).filter((r) => !query.section || r.section === query.section);
  const ordered = DEAL_SECTION_ORDER.flatMap((s) =>
    sortDealRows(
      rows.filter((r) => r.section === s).map((r) => ({ r, percentOff: r.off, profit: r.profit, roi: r.roi, roiLowest: r.roiRange.low, roiHighest: r.roiRange.high })),
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

const pct = (rate: number): string => `${Math.round(rate * 10_000) / 100}%`;
const usd = (n: number): string => `$${n.toFixed(2)}`;

/** The fee settings in one sentence (rule 5: the estimate says what it rests on). */
export function feeBasis(fees: StoreData['settings']['settings']['fees']): string {
  return `${pct(fees.referralRate)} referral (at least ${usd(fees.minReferral)}), ${usd(fees.fulfillmentFee)} fulfillment, ${pct(fees.salesTaxRate)} tax, ${usd(fees.inboundCost)} inbound. An estimate from your fee settings, not your real Amazon fees.`;
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
    basis: feeBasis(fees),
    // DEFAULT_SCAN_SETTINGS.liquidationRate is 0: a part no priced listing covers counts at $0.
    countedAtZero: DEFAULT_SCAN_SETTINGS.liquidationRate === 0 ? [...b.uncovered] : [],
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function watchStateOf(tracking: Tracking | undefined, key: string): WatchState | null {
  const w = tracking?.watch[key];
  return w ? { watched: w.watched, by: w.by, since: iso(w.since) } : null;
}

export function signalsView(s: BundleSignals | undefined): DealSignals | null {
  return s ? { at: iso(s.at), buyNow: s.buyNow, signals: s.signals, options: s.options } : null;
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
    .map((b) => ({ row: rowOf(b, need.has(b.key), data.deals.lookups, t), watch: watchStateOf(t, b.key)!, signals: signalsView(t.signals[b.key]) }));
  rows.sort((x, y) => Number(y.row.buyNow) - Number(x.row.buyNow) || (y.row.profit ?? -Infinity) - (x.row.profit ?? -Infinity));
  const ats = Object.values(t.signals).map((s) => s.at);
  return { at: ats.length ? iso(Math.max(...ats)) : null, rows, thresholds };
}

export function dealDetail(data: WithTracking<'deals' | 'review' | 'settings'>, id: string): DealDetail | null {
  const bundle = data.deals.bundles.find((b) => b.key === id);
  if (!bundle) return null;
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
  if (group) sources.push({ label: `Home Depot: the BOGO starter ${group.starterModel}`, url: group.starterLink, source: 'homedepot' });
  return {
    row: rowOf(bundle, need.has(bundle.key), data.deals.lookups, t),
    bundle,
    sources,
    estimateBasis: ESTIMATE_BASIS,
    estimate: estimateOf(bundle, data.settings.settings.fees),
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
  };
}

/** The newest suggestion asked for a question, or null. */
export function latestSuggestion(suggestions: readonly StoredSuggestion[], questionId: string): StoredSuggestion | null {
  let best: StoredSuggestion | null = null;
  for (const s of suggestions) if (s.questionId === questionId && (!best || s.askedAt > best.askedAt)) best = s;
  return best;
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
    for (const c of q.candidates) if (c.asin) sources.push({ label: `Amazon: ${c.title || c.asin}`, url: amazonLink(c.asin), source: 'amazon' });
    const live = liveSuggestion(data.suggestions, q) ?? null;
    const shown = live ?? latestSuggestion(data.suggestions, q.id);
    // Step 15, rule 5: a suggestion the code did not verify says why in one plain sentence; the reasons stay for Activity.
    const plain = shown && shown.suggestion.status === 'unverified' ? plainVerification(shown.suggestion.reasons, q.kind) : null;
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
    });
  }
  for (const e of data.review.ebayQuestions) {
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
    });
  }
  return { at: data.review.at, questions };
}

export function openReviewCount(review: StoreData['review']): number {
  return review.questions.filter((q) => q.answer === null).length + review.ebayQuestions.length;
}

export function activityResponse(data: Pick<StoreData, 'activity' | 'autopilot' | 'suggestions'>, sinceIso: string, now: number): ActivityResponse {
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
}

/** Nov 23: the last scan, with whether Read again can start now (some page unread, Chrome connected, nothing running). */
function lastScanOf(data: StoreData, live: LiveView): AgentState['agent']['lastScan'] {
  const last = data.activity.lastScan;
  if (!last) return null;
  const unread = last.pagesUnread ?? 0;
  return { ...last, canReadPagesAgain: unread > 0 && live.connected && live.busy === null && !live.stopping };
}

export function agentState(data: StoreData, live: LiveView): AgentState {
  const status = live.stopping ? 'stopping' : live.busy ? 'scanning' : data.agent.paused ? 'paused' : 'idle';
  const view = live.pipeline;
  return {
    agent: {
      status,
      ...(view ? { step: view.current.count ? `${view.current.label} · ${view.current.count}` : view.current.label, progress: { done: view.stepsDone, total: view.stepsTotal }, pipeline: view } : {}),
      busy: live.busy === 'paid' ? 'scan' : live.busy,
      nextScanAt: live.nextScanAt,
      lastScan: lastScanOf(data, live),
      ...(data.agent.problem ? { problem: data.agent.problem } : {}),
      ...(live.drip ? { drip: live.drip } : {}),
    },
    helper: {
      paired: data.pairing.extensions.length > 0, connected: live.connected, lastSeenAt: live.lastSeenAt, jobsWaiting: live.jobsWaiting,
      ...(live.helperOutdated ? { outdated: true } : {}),
      ...(live.helperVersion ? { version: live.helperVersion } : {}),
    },
    budget: {
      serpLeft: data.runtime.serp?.left ?? null,
      serpMonthly: data.runtime.serp?.perMonth ?? null,
      serpPerScan: data.settings.settings.searchesPerScan,
      serpReserve: data.settings.settings.reserve,
      keepaTokens: data.runtime.keepa?.tokensLeft ?? null,
      keepaRefillPerMin: data.runtime.keepa?.refillRate ?? null,
      aiSpentUsd: Math.round(aiSpentThisMonth({ suggestions: data.suggestions, runs: data.activity.runs }, live.now) * 100) / 100,
      aiCapUsd: data.settings.ai.monthlyCapUsd,
    },
    counts: {
      review: openReviewCount(data.review),
      autopilotApplied: data.autopilot.filter((e) => e.undoneAt === null).length,
      newDeals: data.activity.lastScan?.newDeals ?? 0,
      jobsWaiting: live.jobsWaiting,
    },
    keys: keysPresence(data.keys),
    ...(data.runtime.keyProblems && Object.keys(data.runtime.keyProblems).length > 0 ? { keyProblems: { ...data.runtime.keyProblems } } : {}),
    firstRun: data.activity.lastScan === null && data.deals.bundles.length === 0,
    settingsAt: data.settings.updatedAt,
  };
}
