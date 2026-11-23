// What the agent's endpoints answer, built from the store (pure functions; the contract's shapes).

import type {
  ActivityResponse,
  AgentState,
  DealDetail,
  DealRow,
  DealsResponse,
  KeysPresence,
  ReviewAnswer,
  ReviewQuestion,
  ReviewResponse,
  SettingsResponse,
  SourceLink,
} from '../core/src/api/contract';
import type { StoredSuggestion } from '../core/src/assist/stored';
import { staleBundleDays } from '../core/src/deals/freshness';
import { limitCopy } from '../core/src/deals/limitCopy';
import { DEAL_SECTION_ORDER } from '../core/src/deals/sections';
import { DEAL_SORTS, sortDealRows, type DealSortKey } from '../core/src/deals/sort';
import { reviewSignature } from '../core/src/scan/answers';
import { matchState } from '../core/src/scan/matchState';
import { DEFAULT_SCAN_SETTINGS, partKey, type BundleRow, type ReportSection, type ReviewItem } from '../core/src/scan/types';
import type { AuditBundle, StoreData, StoredKeys } from './store';

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

function rowOf(b: BundleRow, needsAnswer: boolean): DealRow {
  return {
    id: b.key,
    bundle: { brand: b.brand, model: b.model, title: b.title, itemId: b.itemId || null, link: b.link },
    section: b.section,
    price: b.price,
    regularPrice: b.regularPrice,
    off: b.percentOff,
    matchState: matchState(b),
    profit: b.estimate?.profit ?? null,
    roi: b.estimate?.roi ?? null,
    roiRange: { low: b.range.lowest?.roi ?? null, high: b.range.highest?.roi ?? null },
    needsAnswer,
    updatedAt: new Date(b.seenAt).toISOString(),
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
  };
}

export function parseSort(v: string | null): DealSortKey {
  return DEAL_SORTS.some((s) => s.key === v) ? (v as DealSortKey) : 'profit';
}

export function parseSection(v: string | null): ReportSection | undefined {
  return (DEAL_SECTION_ORDER as readonly string[]).includes(v ?? '') ? (v as ReportSection) : undefined;
}

/** Every bundle as a row: the panel's rows, then audit-only bundles the panel does not have. */
function allRows(data: Pick<StoreData, 'deals' | 'review'>): DealRow[] {
  const need = bundlesNeedingAnswer(data.deals.bundles, data.review.questions);
  const rows = data.deals.bundles.map((b) => rowOf(b, need.has(b.key)));
  const have = new Set(rows.map((r) => r.id));
  for (const a of data.deals.auditBundles) {
    if (!have.has(a.key)) rows.push(rowOfAudit(a, need.has(a.key), data.deals.auditAt));
  }
  return rows;
}

export function dealsResponse(
  data: Pick<StoreData, 'deals' | 'review' | 'activity'>,
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
  const helper = data.activity.helper;
  const bundles = data.deals.bundles;
  const limit =
    helper?.lastJob && bundles.length
      ? limitCopy(
          { lastJob: helper.lastJob, searchesPerScan: helper.searchesPerScan, rateLimitPerHour: helper.rateLimitPerHour, now },
          bundles,
        )
      : null;
  return {
    at: data.deals.at ?? data.deals.auditAt,
    sort: query.sort,
    rows: ordered,
    staleDays: bundles.length ? staleBundleDays(bundles, now, DEFAULT_SCAN_SETTINGS.freshnessMs) : null,
    notices: { limit: limit ? { title: limit.title, text: limit.text } : null, ebay: helper?.lastJob?.ebayNotice ?? null },
  };
}

export function dealDetail(data: Pick<StoreData, 'deals' | 'review'>, id: string): DealDetail | null {
  const bundle = data.deals.bundles.find((b) => b.key === id);
  if (!bundle) return null;
  const need = bundlesNeedingAnswer([bundle], data.review.questions);
  const sources: SourceLink[] = [];
  if (bundle.link) sources.push({ label: `Home Depot: ${bundle.brand} ${bundle.model}`, url: bundle.link, source: 'homedepot' });
  for (const p of bundle.parts) {
    if (p.asin) sources.push({ label: `Amazon: ${p.model}`, url: amazonLink(p.asin), source: 'amazon' });
  }
  return { row: rowOf(bundle, need.has(bundle.key)), bundle, sources, estimateBasis: ESTIMATE_BASIS };
}

/** The newest suggestion asked for a question, or null. */
export function latestSuggestion(suggestions: readonly StoredSuggestion[], questionId: string): StoredSuggestion | null {
  let best: StoredSuggestion | null = null;
  for (const s of suggestions) if (s.questionId === questionId && (!best || s.askedAt > best.askedAt)) best = s;
  return best;
}

export function reviewResponse(data: Pick<StoreData, 'review' | 'suggestions' | 'deals'>): ReviewResponse {
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
    questions.push({
      id: q.id,
      kind: q.kind,
      bundleId,
      brand: q.brand,
      model: q.model,
      title: q.title,
      reason: q.reason,
      sources,
      suggestion: latestSuggestion(data.suggestions, q.id),
      item: { kind: q.kind, question: q },
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
    });
  }
  return { at: data.review.at, questions };
}

export function openReviewCount(review: StoreData['review']): number {
  return review.questions.filter((q) => q.answer === null).length + review.ebayQuestions.length;
}

/**
 * The answer approving a question's suggestion would save, or why it cannot be approved. Only a
 * suggestion the code verified, for the question as it is now, is ever applied (rule 4).
 */
export function answerFromSuggestion(q: ReviewItem, s: StoredSuggestion | null): { answer: ReviewAnswer } | { reason: string } {
  if (!s) return { reason: 'No AI suggestion for this question.' };
  if (s.seen !== reviewSignature(q)) return { reason: 'The question changed since the AI was asked.' };
  const sug = s.suggestion;
  if (sug.status !== 'verified') return { reason: 'The suggestion is not verified.' };
  const a = sug.answer;
  if (a.decision === 'parts') return { answer: { parts: a.parts } };
  if (a.decision !== 'choose') return { reason: 'The suggestion is not an answer.' };
  if (a.kind === 'split') return { answer: { choice: a.choiceIndex } };
  const index = q.candidates.findIndex((c) => c.asin === a.asin);
  return index >= 0 ? { answer: { choice: index } } : { reason: 'The suggested listing is no longer offered.' };
}

export function activityResponse(data: Pick<StoreData, 'activity' | 'autopilot' | 'suggestions'>, sinceIso: string): ActivityResponse {
  const since = Date.parse(sinceIso);
  const runs = data.activity.runs.filter((r) => Date.parse(r.startedAt) >= since);
  const aiFromSuggestions = data.suggestions.filter((s) => s.askedAt >= since).reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
  return {
    runs: [...data.activity.runs].reverse(),
    spend: {
      serpSearches: runs.reduce((n, r) => n + r.searchesUsed, 0),
      keepaTokens: runs.reduce((n, r) => n + r.keepaTokensUsed, 0),
      aiUsd: Math.round((runs.reduce((n, r) => n + r.aiCostUsd, 0) + aiFromSuggestions) * 100) / 100,
      since: sinceIso,
    },
    autopilot: [...data.autopilot].reverse(),
  };
}

export function agentState(
  data: StoreData,
  live: { connected: boolean; lastSeenAt: string | null; jobsWaiting: number; monthStart: string },
): AgentState {
  const helper = data.activity.helper;
  const scanning = helper?.scanRunning === true;
  const since = Date.parse(live.monthStart);
  const aiSpent = data.suggestions.filter((s) => s.askedAt >= since).reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
  return {
    agent: {
      status: data.agent.paused ? 'paused' : scanning ? 'scanning' : 'idle',
      nextScanAt: null,
      lastScan: data.activity.lastScan,
    },
    helper: { paired: data.pairing.extensions.length > 0, connected: live.connected, lastSeenAt: live.lastSeenAt },
    budget: {
      serpLeft: helper?.searchesLeft ?? null,
      serpReserve: data.settings.settings.reserve,
      keepaTokens: helper?.keepaTokensLeft ?? null,
      aiSpentUsd: Math.round(aiSpent * 100) / 100,
      aiCapUsd: null,
    },
    counts: {
      review: openReviewCount(data.review),
      autopilotApplied: data.autopilot.filter((e) => e.undoneAt === null).length,
      newDeals: data.activity.lastScan?.newDeals ?? 0,
      jobsWaiting: live.jobsWaiting,
    },
    keys: keysPresence(data.keys),
  };
}
