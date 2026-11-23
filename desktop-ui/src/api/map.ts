// The one place the agent's contract (core/src/api/contract.ts) becomes what the screens read
// (types.ts). Pure functions, no network. Where the contract is silent the view says so (a null,
// an empty list); nothing here fills a gap with a guess (CLAUDE.md rule 4), and a suggestion made
// for a question that has changed since is dropped, never shown as verified.

import type * as C from '@core/api/contract';
import { confirmedSourceName, confirmState, ebayListingChoices } from '@core/scan/confirmed';
import type { BundleRow, PartRow, PriceOption, PriceRange, UnnamedItem } from '@core/scan/types';
import { money } from '../lib/format';
import type {
  ActivityView,
  AgentEvent,
  AiSuggestion,
  AppState,
  AutopilotEntry,
  Choice,
  DealDetail,
  DealPart,
  DealRow,
  DealsView,
  DealSort,
  Grade,
  LastScan,
  PriceLine,
  Quote,
  ReviewQuestion,
  ReviewView,
  RoiRange,
  Run,
  ScanResult,
  Source,
  WayToSell,
} from './types';

const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------- state

const RESULTS: readonly string[] = ['finished', 'stopped', 'limit', 'failed'];

/** A run's or a scan's status as the screens word it; a status the agent never uses reads as failed. */
export function scanResult(status: string): ScanResult | 'running' {
  if (status === 'running') return 'running';
  return RESULTS.includes(status) ? (status as ScanResult) : 'failed';
}

function lastScanOf(s: C.LastScanSummary): LastScan {
  const result = scanResult(s.status);
  return {
    at: s.at,
    result: result === 'running' ? 'finished' : result,
    newDeals: s.newDeals,
    searches: s.searchesUsed,
    message: s.stopMessage ?? (s.status === 'stopped' ? 'You stopped the scan. Prices found so far are kept.' : null),
  };
}

export function mapState(s: C.AgentState): AppState {
  const a = s.agent;
  return {
    agent: {
      status: a.status === 'scanning' && a.busy === 'ask' ? 'asking' : a.status,
      pipeline: a.pipeline ?? null,
      step: a.step ?? null,
      nextScanAt: a.nextScanAt,
      lastScan: a.lastScan ? lastScanOf(a.lastScan) : null,
    },
    helper: { paired: s.helper.paired, connected: s.helper.connected, lastSeenAt: s.helper.lastSeenAt, jobsWaiting: s.helper.jobsWaiting ?? s.counts.jobsWaiting },
    budget: {
      serpLeft: s.budget.serpLeft,
      serpMonthly: s.budget.serpMonthly ?? null,
      serpReserve: s.budget.serpReserve,
      serpPerScan: s.budget.serpPerScan ?? 0,
      keepaTokens: s.budget.keepaTokens,
      aiSpentUsd: s.budget.aiSpentUsd,
      aiCapUsd: s.budget.aiCapUsd,
    },
    counts: { review: s.counts.review, autopilotApplied: s.counts.autopilotApplied, newDeals: s.counts.newDeals },
    keys: s.keys,
    firstRun: s.firstRun ?? false,
  };
}

// ---------------------------------------------------------------- deals

const rangeOf = (low: number | null, high: number | null): RoiRange | null => (low !== null && high !== null ? { low, high } : null);
const priceRangeOf = (r: PriceRange): RoiRange | null => rangeOf(r.lowest?.roi ?? null, r.highest?.roi ?? null);

export function mapRow(r: C.DealRow): DealRow {
  return {
    id: r.id,
    title: r.bundle.title,
    brand: r.bundle.brand,
    model: r.bundle.model,
    itemId: r.bundle.itemId,
    link: r.bundle.link,
    section: r.section,
    price: r.price,
    off: r.off,
    matchState: r.matchState,
    profit: r.profit,
    roi: r.roi,
    roiRange: rangeOf(r.roiRange.low, r.roiRange.high),
    needsAnswer: r.needsAnswer,
    updatedAt: r.updatedAt,
    lookup: r.lookup ?? null,
  };
}

export function mapDeals(r: C.DealsResponse): DealsView {
  return { rows: r.rows.map(mapRow), at: r.at, ebayNotice: r.notices.ebay, limitNotice: r.notices.limit, staleDays: r.staleDays };
}

/** The deals list's sort, in the agent's words (GET /api/deals/export.csv?sort=). */
export function csvSort(sort: DealSort): C.DealSortKey {
  return sort === 'roi' ? 'roi' : sort === 'off' ? 'discount' : 'profit';
}

/** The grade a part shows, in the order core's matchState reads a part: waiting, no listing, inactive, review, then the match grade. */
export function gradeOf(p: PartRow): Grade {
  if (p.status === 'waiting' || p.status === 'unmatched') return 'not_looked_up';
  if (p.status === 'none' || p.availability === 'missing') return 'missing';
  if (p.availability === 'inactive') return 'inactive';
  if (p.status === 'review') return 'needs_answer';
  if (p.grade === 'exact' || p.grade === 'strong') return 'verified';
  if (p.grade === 'probable') return 'title_match';
  return 'needs_answer';
}

function lineOf(o: PriceOption, part: PartRow): PriceLine {
  const base = { counted: !o.reference, seenAt: iso(o.seenAt) };
  const notes: string[] = [];
  if (o.reference) notes.push('not counted');
  if (o.soldAs) notes.push(`sold alone as ${o.soldAs}`);
  if (o.singleOffer) notes.push('the page’s only offer');
  switch (o.kind) {
    case 'amazon_new':
      return { ...base, label: part.packaging === 'bulk' ? 'Amazon · New · bulk packaging' : 'Amazon · New', amount: o.price, range: null, note: notes.join(' · ') || null, sources: o.link ? [{ label: 'Amazon listing', url: o.link }] : [] };
    case 'amazon_buybox':
      return { ...base, label: o.seller ? `Buy Box · ${o.seller}` : 'Buy Box', amount: o.price, range: null, note: notes.join(' · ') || null, sources: o.link ? [{ label: 'Amazon listing', url: o.link }] : [] };
    case 'confirmed':
      return {
        ...base,
        label: `Confirmed by you · ${confirmedSourceName(o.link)}`,
        amount: o.price,
        range: null,
        note: [o.note, ...notes].filter(Boolean).join(' · ') || null,
        sources: o.link ? [{ label: 'Open the listing', url: o.link }] : [],
        confirmed: true,
      };
    case 'amazon_list':
      return { ...base, label: 'List price', amount: o.price, range: null, note: notes.join(' · ') || null, sources: o.link ? [{ label: 'Amazon listing', url: o.link }] : [] };
    case 'homedepot':
      return { ...base, label: 'Home Depot', amount: o.price, range: null, note: notes.join(' · ') || null, sources: o.link ? [{ label: 'Home Depot page', url: o.link }] : [] };
    case 'ebay_sold_new': {
      const e = o.ebay;
      const tally = e ? `${e.listings} ${e.listings === 1 ? 'listing' : 'listings'}, ${e.unitsSold} sold, median ${money(e.medianPrice)}` : '';
      return {
        ...base,
        label: 'eBay · New',
        amount: e ? null : o.price,
        range: e ? { low: e.low, high: e.high } : null,
        note: [tally, ...notes].filter(Boolean).join(' · ') || null,
        // The numeral is the label; the pane writes "Listing 1".
        sources: (e?.links ?? []).map((url, i): Source => ({ label: String(i + 1), url })),
      };
    }
  }
}

function confirmOf(p: PartRow): DealPart['confirm'] {
  const own = p.prices.find((o) => o.kind === 'confirmed');
  return {
    state: confirmState(p),
    ebay: ebayListingChoices(p),
    confirmed: own && own.link ? { price: own.price, link: own.link, note: own.note ?? null } : null,
    inactive: p.availability === 'inactive',
  };
}

/** A kit's item with no model number: no listing, no lookup, priced only by a price he confirms. */
export function unnamedPartOf(u: UnnamedItem): DealPart {
  const line: PriceLine[] =
    u.price !== null && u.link !== null
      ? [{ label: `Confirmed by you · ${confirmedSourceName(u.link)}`, amount: u.price, range: null, counted: true, note: null, seenAt: null, sources: [{ label: 'Open the listing', url: u.link }], confirmed: true }]
      : [];
  return {
    model: u.model,
    qty: u.qty,
    title: u.name,
    grade: 'missing',
    asin: null,
    price: u.price,
    net: null,
    prices: line,
    verifySearches: null,
    unnamed: true,
    confirm: { state: 'open', ebay: [], confirmed: u.price !== null && u.link !== null ? { price: u.price, link: u.link, note: null } : null, inactive: false },
  };
}

function partOf(p: PartRow): DealPart {
  const grade = gradeOf(p);
  return {
    model: p.model,
    qty: p.qty,
    title: p.title,
    grade,
    asin: p.asin,
    price: p.price,
    // The contract holds the estimate's totals, not each part's net; nothing here works one out.
    net: null,
    prices: p.prices.map((o) => lineOf(o, p)),
    // Verify reads one listing's page: one search (agent/work.ts paidPlan).
    verifySearches: grade === 'title_match' && p.asin ? 1 : null,
    unnamed: false,
    confirm: confirmOf(p),
  };
}

/** The items the kits list with no model number, once each, across the bundle's ways to sell. */
function unnamedOf(b: BundleRow): DealPart[] {
  const seen = new Map<string, UnnamedItem>();
  for (const o of b.options) for (const u of o.unnamed ?? []) if (!seen.has(u.model.toUpperCase())) seen.set(u.model.toUpperCase(), u);
  return [...seen.values()].map(unnamedPartOf);
}

/** Why a bundle has no estimate, from what its own row says. */
export function noEstimateSentence(b: BundleRow): string {
  if (b.status === 'needs_review') return 'No estimate yet: what is inside this bundle is not settled.';
  if (b.price === null) return 'No estimate yet: Home Depot shows no price for this bundle.';
  const waiting = b.parts.filter((p) => p.status === 'waiting' || p.status === 'unmatched').length;
  if (waiting > 0) return `No estimate yet: ${waiting} ${waiting === 1 ? 'part still needs' : 'parts still need'} an Amazon lookup.`;
  return 'No estimate yet.';
}

function wayOf(o: BundleRow['options'][number], i: number): WayToSell {
  return {
    id: o.id,
    label: o.label || 'Sell every part',
    primary: i === 0,
    profit: o.estimate?.profit ?? null,
    roi: o.estimate?.roi ?? null,
    roiRange: priceRangeOf(o.range),
    leaves: o.leftovers,
  };
}

/** `questionId`: the open Review question on this bundle, from GET /api/review (the detail does not carry it). */
export function mapDetail(d: C.DealDetail, questionId: string | null): DealDetail {
  const b = d.bundle;
  const e = d.estimate ?? null;
  const parts = [...b.parts.map(partOf), ...unnamedOf(b)];
  return {
    id: d.row.id,
    title: b.title,
    brand: b.brand,
    model: b.model,
    section: b.section,
    price: b.price,
    off: b.percentOff,
    seenAt: iso(b.seenAt),
    link: b.link,
    estimate: e ? { profit: e.profit, roi: e.roi, roiRange: priceRangeOf(b.range), cost: e.cost, partsSellFor: e.partsSellFor, afterFees: e.afterFees, basis: e.basis, countedAtZero: e.countedAtZero } : null,
    noEstimate: e ? null : noEstimateSentence(b),
    ways: b.options.map(wayOf),
    parts,
    questionId,
    asins: parts.map((p) => p.asin).filter((a): a is string => a !== null),
    lookup: d.row.lookup ?? null,
  };
}

// ---------------------------------------------------------------- review

const quoteOf = (q: C.EvidenceQuote): Quote => ({ text: q.text, source: { label: q.source.label, url: q.source.url } });

const EBAY_CHOICES: Choice[] = [
  { id: 'yes', label: 'Yes', models: [], asin: null, source: null },
  { id: 'no', label: 'No', models: [], asin: null, source: null },
];

type Stored = NonNullable<C.ReviewQuestion['suggestion']>;

function verifiedQuotes(s: Stored['suggestion']): Quote[] {
  if (s.status !== 'verified' && s.status !== 'cannot_tell' && s.status !== 'none_suggested') return [];
  return s.quotes.map((q) => ({ text: q.quote, source: { label: q.label, url: q.url } }));
}

/**
 * The AI block of a question. A suggestion made for the question as it was is dropped when the question has since
 * changed (its signature differs): it was made for other choices and may not be applied to these (rule 4).
 */
export function mapSuggestion(q: C.ReviewQuestion, choices: Choice[]): AiSuggestion | null {
  const rec = q.suggestion;
  if (!rec) return null;
  if (q.seen !== undefined && rec.seen !== q.seen) return null;
  const s = rec.suggestion;
  const costUsd = rec.costUsd ?? 0;
  const quotes = q.suggestionQuotes ? q.suggestionQuotes.map(quoteOf) : verifiedQuotes(s);
  switch (s.status) {
    case 'verified': {
      const a = s.answer;
      if (a.decision === 'choose' && a.kind === 'split') return { status: 'verified', choiceId: `choice:${a.choiceIndex}`, answer: a.parts.join(' + '), reason: null, quotes, costUsd };
      if (a.decision === 'choose') {
        const pick = choices.find((c) => c.asin === a.asin);
        return { status: 'verified', choiceId: pick?.id ?? null, answer: `${a.title} · ${a.asin}`, reason: null, quotes, costUsd };
      }
      if (a.decision === 'parts') return { status: 'verified', choiceId: null, answer: a.parts.join(' + '), reason: null, quotes, costUsd };
      // "None fits" is never verified (core/src/assist/types.ts); read here as the AI's view only.
      return { status: 'unverified', choiceId: null, answer: 'None of these fits', reason: s.reason, quotes, costUsd };
    }
    case 'unverified': {
      const claimed = s.claimed;
      const pick = claimed?.choiceIndex != null ? choices[claimed.choiceIndex] : claimed?.asin ? choices.find((c) => c.asin === claimed.asin) : undefined;
      return { status: 'unverified', choiceId: null, answer: pick ? pick.label : '', reason: s.reasons.join(' '), quotes, costUsd };
    }
    case 'cannot_tell':
      return { status: 'cannot_tell', choiceId: null, answer: '', reason: s.reason, quotes, costUsd };
    case 'none_suggested':
      return { status: 'unverified', choiceId: null, answer: 'None of these fits', reason: s.reason, quotes, costUsd };
    case 'not_suggested':
      return { status: 'cannot_tell', choiceId: null, answer: '', reason: s.reason, quotes: [], costUsd };
  }
}

export function mapQuestion(q: C.ReviewQuestion): ReviewQuestion {
  const choices: Choice[] = q.kind === 'ebay' ? EBAY_CHOICES : (q.choices ?? []).map((c) => ({ id: c.id, label: c.label, models: c.models, asin: c.asin, source: c.source ? { label: c.source.label, url: c.source.url } : null }));
  return {
    id: q.id,
    kind: q.kind,
    bundle: {
      id: q.bundleId,
      title: q.title ?? `${q.brand} ${q.model}`,
      brand: q.brand,
      model: q.model,
      link: q.sources.find((s) => s.source === 'homedepot')?.url ?? null,
    },
    subject: q.model,
    prompt: q.prompt ?? q.reason,
    reason: q.reason,
    evidence: (q.evidence ?? []).map(quoteOf),
    choices,
    allowNone: q.kind !== 'ebay',
    allowTyped: q.kind === 'split',
    suggestion: mapSuggestion(q, choices),
    askCostUsd: q.askCostUsd ?? null,
    openedAt: iso(q.item.question.openedAt),
    seen: q.seen ?? null,
  };
}

export function mapReview(r: C.ReviewResponse): ReviewView {
  return { questions: r.questions.map(mapQuestion) };
}

// ---------------------------------------------------------------- activity

function runOf(r: C.RunRecord): Run {
  return {
    id: r.id,
    kind: r.kind,
    byYou: r.trigger === 'manual',
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    searches: r.searchesUsed,
    keepaTokens: r.keepaTokensUsed,
    aiUsd: r.aiCostUsd,
    result: scanResult(r.status),
    summary: r.summary,
    error: r.error ?? null,
    steps: r.steps ?? [],
  };
}

/** `titles`: bundle id to its title and model, from the deals (the activity does not carry them). */
export function mapActivity(r: C.ActivityResponse, titles: ReadonlyMap<string, { title: string; model: string }>): ActivityView {
  return {
    runs: r.runs.map(runOf),
    autopilot: r.autopilot.map((e): AutopilotEntry => {
      const bundle = e.bundleId ? titles.get(e.bundleId) : undefined;
      const undone = e.undoneAt !== null;
      return {
        id: e.id,
        at: e.at,
        bundleId: e.bundleId ?? null,
        title: bundle?.title ?? 'A bundle the deals no longer hold',
        model: bundle?.model ?? null,
        kind: e.questionId.startsWith('match:') ? 'match' : 'split',
        applied: e.applied,
        verifiedBy: e.verifiedBy,
        by: e.model ?? null,
        undone,
        undoable: !undone && e.undoable !== false,
      };
    }),
    errors: r.errors ?? [],
    month: { searches: r.spend.serpSearches, keepaTokens: r.spend.keepaTokens, aiUsd: r.spend.aiUsd },
  };
}

// ---------------------------------------------------------------- events

/** One server-sent event (`event:` name, `data:` JSON that also says its own `type`) as the screens take it; null for one they do not use. */
export function mapEvent(name: string, data: unknown): AgentEvent | null {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const type = typeof d.type === 'string' ? d.type : name;
  switch (type) {
    case 'state': {
      const state = (d.state ?? d) as C.AgentState;
      return state && typeof state === 'object' && 'agent' in state && 'budget' in state ? { type: 'state', state: mapState(state) } : null;
    }
    case 'deals':
    case 'review':
    case 'activity':
      return { type };
    case 'notify':
      return { type: 'notify', title: String(d.title ?? ''), body: String(d.body ?? '') };
    default:
      return null;
  }
}
