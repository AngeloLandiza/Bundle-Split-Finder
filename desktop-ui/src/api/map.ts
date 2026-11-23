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
  AgentView,
  AiSuggestion,
  AppState,
  AutopilotEntry,
  Choice,
  DealDetail,
  DealPart,
  DealRow,
  DealsView,
  DealSort,
  Drip,
  FollowUp,
  SettledPart,
  Grade,
  KeyName,
  KeyProblems,
  LastScan,
  LookupBlock,
  PriceLine,
  Quote,
  ReviewBrief,
  ReviewQuestion,
  ReviewView,
  RoiRange,
  Run,
  ScanResult,
  Source,
  SplitEvidence,
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

/**
 * The fields the agent adds to its state for unread pages and an outdated helper. The contract may not name them
 * yet, so they are read as optional and only when they have the right type; an older agent simply lacks them.
 */
interface StateExtras {
  waitingLookups?: unknown;
  lookupsDone?: unknown;
  lookupsBlockedBy?: unknown;
  pagesUnread?: unknown;
  canReadPagesAgain?: unknown;
  outdated?: unknown;
  version?: unknown;
  matchKind?: unknown;
}
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

const BLOCKS: readonly string[] = ['keepa_tokens', 'search_cap', 'reserve', 'hourly_limit'];

/** The counts of the lookups the scan made, only when both are numbers. */
function lookupsDoneOf(v: unknown): LastScan['lookupsDone'] | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as { keepa?: unknown; serpapi?: unknown };
  const keepa = num(o.keepa);
  const serpapi = num(o.serpapi);
  return keepa !== undefined && serpapi !== undefined ? { keepa, serpapi } : undefined;
}

function lastScanOf(s: C.LastScanSummary): LastScan {
  const result = scanResult(s.status);
  const x = s as C.LastScanSummary & StateExtras;
  const pagesUnread = num(x.pagesUnread);
  const canReadPagesAgain = bool(x.canReadPagesAgain);
  const waitingLookups = num(x.waitingLookups);
  const lookupsDone = lookupsDoneOf(x.lookupsDone);
  const rawBlock: unknown = x.lookupsBlockedBy;
  const blocked: LookupBlock | null | undefined = typeof rawBlock === 'string' && BLOCKS.includes(rawBlock) ? (rawBlock as LookupBlock) : rawBlock === null ? null : undefined;
  return {
    at: s.at,
    result: result === 'running' ? 'finished' : result,
    newDeals: s.newDeals,
    searches: s.searchesUsed,
    message: s.stopMessage ?? (s.status === 'stopped' ? 'You stopped the scan. Prices found so far are kept.' : null),
    ...(pagesUnread !== undefined ? { pagesUnread } : {}),
    ...(canReadPagesAgain !== undefined ? { canReadPagesAgain } : {}),
    ...(waitingLookups !== undefined ? { waitingLookups } : {}),
    ...(lookupsDone ? { lookupsDone } : {}),
    ...(blocked !== undefined ? { lookupsBlockedBy: blocked } : {}),
    ...(s.status === 'stopped' && !s.stopMessage ? { userStopped: true } : {}),
  };
}

function helperOf(s: C.AgentState): AppState['helper'] {
  const h = s.helper as C.AgentState['helper'] & StateExtras;
  const outdated = bool(h.outdated);
  const version = typeof h.version === 'string' ? h.version : undefined;
  return {
    paired: h.paired,
    connected: h.connected,
    lastSeenAt: h.lastSeenAt,
    jobsWaiting: h.jobsWaiting ?? s.counts.jobsWaiting,
    ...(outdated !== undefined ? { outdated } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

/** The agent's drip (lookups between scans), when it sends one and every field has its type. */
function dripOf(v: unknown): Drip | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const waiting = num(o.waiting);
  if (typeof o.active !== 'boolean' || waiting === undefined) return undefined;
  return { active: o.active, waiting, nextAt: typeof o.nextAt === 'string' ? o.nextAt : null, lastLookupAt: typeof o.lastLookupAt === 'string' ? o.lastLookupAt : null };
}

const KEYS_WITH_PROBLEMS: readonly KeyName[] = ['serpapi', 'keepa', 'anthropic', 'openai', 'ebay', 'telegram'];

/** The sentences the agent says about keys it holds but a service did not accept: only a non-empty sentence for a key it knows. */
export function keyProblemsOf(v: unknown): KeyProblems | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const out: KeyProblems = {};
  for (const name of KEYS_WITH_PROBLEMS) {
    const t = (v as Record<string, unknown>)[name];
    if (typeof t === 'string' && t.trim()) out[name] = t.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function mapState(s: C.AgentState): AppState {
  const a = s.agent;
  const drip = dripOf((a as { drip?: unknown }).drip);
  const refill = num((s.budget as { keepaRefillPerMin?: unknown }).keepaRefillPerMin);
  const problems = keyProblemsOf((s as { keyProblems?: unknown }).keyProblems);
  return {
    agent: {
      status: a.status === 'scanning' && a.busy === 'ask' ? 'asking' : a.status,
      pipeline: (a.pipeline as AgentView['pipeline']) ?? null,
      step: a.step ?? null,
      nextScanAt: a.nextScanAt,
      lastScan: a.lastScan ? lastScanOf(a.lastScan) : null,
      ...(drip ? { drip } : {}),
    },
    helper: helperOf(s),
    budget: {
      serpLeft: s.budget.serpLeft,
      serpMonthly: s.budget.serpMonthly ?? null,
      serpReserve: s.budget.serpReserve,
      serpPerScan: s.budget.serpPerScan ?? 0,
      keepaTokens: s.budget.keepaTokens,
      ...(refill !== undefined ? { keepaRefillPerMin: refill } : {}),
      aiSpentUsd: s.budget.aiSpentUsd,
      aiCapUsd: s.budget.aiCapUsd,
    },
    counts: {
      review: s.counts.review,
      autopilotApplied: s.counts.autopilotApplied,
      newDeals: s.counts.newDeals,
      // Questions the app is still checking itself; not in `review`. An older agent sends none.
      ...(num((s.counts as { reviewWorking?: unknown }).reviewWorking) !== undefined ? { reviewWorking: num((s.counts as { reviewWorking?: unknown }).reviewWorking)! } : {}),
    },
    keys: s.keys,
    firstRun: s.firstRun ?? false,
    ...(problems ? { keyProblems: problems } : {}),
  };
}

// ---------------------------------------------------------------- deals

const rangeOf = (low: number | null, high: number | null): RoiRange | null => (low !== null && high !== null ? { low, high } : null);
const priceRangeOf = (r: PriceRange): RoiRange | null => rangeOf(r.lowest?.roi ?? null, r.highest?.roi ?? null);

/** A bundle whose Home Depot page could not be read: the agent says so as the row's `matchKind`, or as its match state. */
function matchKindOf(r: C.DealRow): DealRow['matchKind'] {
  const kind: unknown = (r as { matchKind?: unknown }).matchKind;
  if (kind === 'waiting_page' || r.matchState === 'waiting_page') return 'waiting_page';
  // Its split waits for Home Depot's own pages of the parts (a free read); not a question, and not an Amazon lookup.
  if (kind === 'waiting_parts' || r.matchState === 'waiting_parts') return 'waiting_parts';
  return null;
}

export function mapRow(r: C.DealRow): DealRow {
  const matchKind = matchKindOf(r);
  return {
    id: r.id,
    title: r.bundle.title,
    brand: r.bundle.brand,
    model: r.bundle.model,
    itemId: r.bundle.itemId,
    link: r.bundle.link,
    watched: r.watched ?? false,
    buyNow: r.buyNow ?? false,
    signalNote: r.signalNote ?? null,
    beforeFulfillment: r.beforeFulfillment ?? null,
    bogo: r.bogo ?? null,
    bogoPair: r.bogoPair ?? null,
    bogoChoices: r.bogoChoices ?? null,
    section: r.section,
    price: r.price,
    off: r.off,
    // The agent's code for a waiting bundle is a state, not a sentence the row would print.
    matchState: matchKind ? null : r.matchState,
    profit: r.profit,
    roi: r.roi,
    roiRange: rangeOf(r.roiRange.low, r.roiRange.high),
    // Without its page the parts are not known, so there is no question to answer yet.
    needsAnswer: r.needsAnswer && matchKind === null,
    ...(matchKind ? { matchKind } : {}),
    updatedAt: r.updatedAt,
    lookup: r.lookup ?? null,
    ...(r.incomplete ? { incomplete: r.incomplete } : {}),
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
    ...(o.incomplete ? { incomplete: { priced: o.incomplete.priced, total: o.incomplete.total, breakEvenNet: o.incomplete.breakEvenNet } } : {}),
    ...(o.splitKits.length ? { soldAs: o.splitKits.map((k) => (o.kitParts?.[k] ? `Sold as ${k}'s ${o.kitParts[k]} parts` : `Sold as ${k}'s parts`)).join('; ') } : {}),
  };
}

const EVIDENCE_KINDS: readonly string[] = ['hd_part_page', 'bogo_pair', 'page_quote'];

/** How the split is known, each item only when it has a kind and a text; an address only when it is http(s). */
export function splitEvidenceOf(v: unknown): SplitEvidence[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SplitEvidence[] = [];
  for (const e of v as Record<string, unknown>[]) {
    if (typeof e !== 'object' || e === null || typeof e.text !== 'string' || !e.text.trim() || typeof e.kind !== 'string' || !EVIDENCE_KINDS.includes(e.kind)) continue;
    const url = typeof e.url === 'string' && /^https?:\/\//.test(e.url) ? e.url : undefined;
    out.push({ kind: e.kind as SplitEvidence['kind'], text: e.text.trim(), ...(url ? { url } : {}) });
  }
  return out.length ? out : undefined;
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
    ...(d.incompleteEstimate ? { incomplete: d.incompleteEstimate } : {}),
    noEstimate: e ? null : noEstimateSentence(b),
    ways: b.options.map(wayOf),
    parts,
    questionId,
    asins: parts.map((p) => p.asin).filter((a): a is string => a !== null),
    lookup: d.row.lookup ?? null,
    watch: d.watch ?? null,
    signals: d.signals ?? null,
    history: d.history ?? [],
    bogo: d.bogo ?? null,
    bogoGroup: d.bogoGroup ?? null,
    fbaEstimate: d.fbaEstimate ?? null,
    ...(splitEvidenceOf((d as { splitEvidence?: unknown }).splitEvidence) ? { splitEvidence: splitEvidenceOf((d as { splitEvidence?: unknown }).splitEvidence)! } : {}),
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

/** What a research run records of each source it read (the ledger): the id a quote names, its label and its page. */
type Ledger = ReadonlyMap<string, { label: string; url: string | null }>;
interface ClaimContext {
  bundleId: string | null;
  bundleLink: string | null;
  ledger: Ledger;
}

/**
 * A quote's source as the AI named it ("bundle", "hd-page:306554196", "catalog:pcl1600k2", "kit:PCL1200K2",
 * "listing:B0…", "hd-search:ryobi-p553") as a labelled link. A source with no page of its own (the catalog) is a plain
 * label: nothing here makes up an address (rule 4).
 */
export function claimSource(id: string, ctx: ClaimContext): Source {
  const known = ctx.ledger.get(id);
  const url = known?.url ?? null;
  const colon = id.indexOf(':');
  const kind = colon < 0 ? id : id.slice(0, colon);
  const rest = colon < 0 ? '' : id.slice(colon + 1);
  switch (kind) {
    case 'bundle':
      return { label: 'Home Depot bundle page', url: url ?? ctx.bundleLink };
    case 'hd-page': {
      const own = ctx.bundleId !== null && ctx.bundleId.endsWith(`:${rest}`);
      return { label: own ? 'Home Depot bundle page' : 'Home Depot part page', url: url ?? (own ? ctx.bundleLink : `https://www.homedepot.com/p/${rest}`) };
    }
    case 'kit':
      return { label: 'Home Depot kit page', url };
    case 'hd-search':
      return { label: 'Home Depot search', url };
    case 'catalog':
      return { label: 'Catalog entry', url: null };
    case 'listing':
      return { label: 'Amazon listing', url: rest ? `https://www.amazon.com/dp/${rest}` : url };
    default:
      return { label: known?.label ?? 'Source', url };
  }
}

interface ClaimShape {
  evidence?: { quote: string; source: string }[];
  quotes?: { quote: string; sourceId: string }[];
  parts?: { model: string; qty: number; quotes?: { quote: string; sourceId: string }[] }[];
  reason?: string;
  decision?: string;
  choiceIndex?: number | null;
  asin?: string | null;
}

/** The quotes a claim rests on, each with its source linked; a quote named twice once. */
function claimQuotes(claim: ClaimShape | null, research: ClaimShape | null, ctx: ClaimContext): Quote[] {
  const raw: { text: string; id: string }[] = [];
  for (const e of claim?.evidence ?? []) raw.push({ text: e.quote, id: e.source });
  if (raw.length === 0) {
    for (const e of research?.quotes ?? []) raw.push({ text: e.quote, id: e.sourceId });
    for (const part of research?.parts ?? []) for (const e of part.quotes ?? []) raw.push({ text: e.quote, id: e.sourceId });
  }
  const seen = new Set<string>();
  const out: Quote[] = [];
  for (const r of raw) {
    const key = `${r.id}|${r.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: r.text, source: claimSource(r.id, ctx) });
  }
  return out;
}

/**
 * The AI block of a question. A suggestion made for the question as it was is dropped when the question has since
 * changed (its signature differs): it was made for other choices and may not be applied to these (rule 4).
 * An answer the code could not confirm still names its choice when it names an offered one: the owner sees it
 * preselected and labelled Not verified (HAX G7-G9); only a verified one is ever applied without him.
 */
export function mapSuggestion(q: C.ReviewQuestion, choices: Choice[]): AiSuggestion | null {
  const rec = q.suggestion;
  if (!rec) return null;
  if (q.seen !== undefined && rec.seen !== q.seen) return null;
  const s = rec.suggestion;
  const costUsd = rec.costUsd ?? 0;
  const plainRaw = (q as C.ReviewQuestion & { suggestionPlain?: unknown }).suggestionPlain;
  const plain = typeof plainRaw === 'string' && plainRaw.trim() ? plainRaw.trim() : null;
  const quotes = q.suggestionQuotes && q.suggestionQuotes.length ? q.suggestionQuotes.map(quoteOf) : verifiedQuotes(s);
  const base = { notVerified: null, plain, costUsd };
  const noneFits = 'One quote cannot show that nothing fits.';
  switch (s.status) {
    case 'verified': {
      const a = s.answer;
      const reason = s.reason || null;
      if (a.decision === 'choose' && a.kind === 'split') return { ...base, status: 'verified', choiceId: choices[a.choiceIndex]?.id ?? `choice:${a.choiceIndex}`, answer: a.parts.join(' + '), reason, quotes };
      if (a.decision === 'choose') {
        const pick = choices.find((c) => c.asin === a.asin);
        return { ...base, status: 'verified', choiceId: pick?.id ?? null, answer: `${a.title} · ${a.asin}`, reason, quotes };
      }
      if (a.decision === 'parts') return { ...base, status: 'verified', choiceId: null, answer: a.parts.join(' + '), reason, quotes };
      // "None fits" is never verified (core/src/assist/types.ts); it is the AI's view only.
      return { ...base, status: 'unmatched', choiceId: null, answer: 'None of these fits', reason, quotes, notVerified: noneFits };
    }
    case 'unverified': {
      const claim = (s.claimed as ClaimShape | null | undefined) ?? null;
      const research = (s.researchClaim as ClaimShape | null | undefined) ?? null;
      const ledger = (s as { research?: { ledger?: { id: string; label: string; url: string | null }[] } }).research?.ledger ?? [];
      const ctx: ClaimContext = { bundleId: q.bundleId, bundleLink: q.sources.find((x) => x.source === 'homedepot')?.url ?? null, ledger: new Map(ledger.map((l) => [l.id, { label: l.label, url: l.url }])) };
      const claimQ = claimQuotes(claim, research, ctx);
      const reason = claim?.reason ?? research?.reason ?? null;
      const why = s.reasons.join(' ');
      const index = claim?.decision === 'choose' ? (claim.choiceIndex ?? null) : research?.decision === 'choose' ? (research.choiceIndex ?? null) : null;
      const asin = claim?.decision === 'choose' ? (claim.asin ?? null) : null;
      const pick = index !== null ? choices[index] : asin ? choices.find((c) => c.asin === asin) : undefined;
      if (pick) return { ...base, status: 'unverified', choiceId: pick.id, answer: pick.label, reason, quotes: claimQ, notVerified: why };
      const typed = research?.decision === 'parts' ? (research.parts ?? []) : [];
      // The parts it typed in may be exactly an offered reading (the same models, as many times each): that is the choice, compared exactly.
      const asModels = typed.flatMap((p) => Array.from({ length: Math.max(1, p.qty) }, () => p.model.toUpperCase())).sort();
      const same = typed.length ? choices.find((c) => c.models.length === asModels.length && [...c.models].map((m) => m.toUpperCase()).sort().every((m, i) => m === asModels[i])) : undefined;
      if (same) return { ...base, status: 'unverified', choiceId: same.id, answer: same.label, reason, quotes: claimQ, notVerified: why };
      const answer = typed.length ? typed.map((p) => (p.qty > 1 ? `${p.model} ×${p.qty}` : p.model)).join(' + ') : 'None of these fits';
      return { ...base, status: 'unmatched', choiceId: null, answer, reason, quotes: claimQ, notVerified: why };
    }
    case 'cannot_tell':
      return { ...base, status: 'cannot_tell', choiceId: null, answer: '', reason: s.reason, quotes };
    case 'none_suggested':
      return { ...base, status: 'unmatched', choiceId: null, answer: 'None of these fits', reason: s.reason, quotes, notVerified: noneFits };
    case 'not_suggested':
      return { ...base, status: 'cannot_tell', choiceId: null, answer: '', reason: s.reason, quotes: [] };
  }
}

/**
 * The agent's decision-card text, kept only when it has the schema's shape (a state it knows, at most three reasons,
 * strings where strings belong): anything else is dropped and the pane derives its own. Nothing is repaired or guessed.
 */
export function readBrief(raw: unknown): ReviewBrief | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string';
  const opt = (v: unknown): v is string | undefined => v === undefined || str(v);
  if (!str(b.ask) || !b.ask.trim()) return undefined;
  if (!(b.suggestion === null || str(b.suggestion))) return undefined;
  if (b.state !== 'verified' && b.state !== 'not_verified' && b.state !== 'cannot_tell' && b.state !== 'none') return undefined;
  if (b.writtenBy !== 'ai' && b.writtenBy !== 'rules') return undefined;
  if (!Array.isArray(b.reasons) || b.reasons.length > 3) return undefined;
  const reasons: ReviewBrief['reasons'] = [];
  for (const r of b.reasons) {
    const x = r as Record<string, unknown> | null;
    if (!x || !str(x.text) || !opt(x.quote) || !opt(x.sourceLabel) || !opt(x.url)) return undefined;
    reasons.push({ text: x.text, ...(x.quote ? { quote: x.quote } : {}), ...(x.sourceLabel ? { sourceLabel: x.sourceLabel } : {}), ...(x.url ? { url: x.url } : {}) });
  }
  let check: ReviewBrief['check'] = null;
  if (b.check !== null && b.check !== undefined) {
    const c = b.check as Record<string, unknown>;
    if (typeof c !== 'object' || !str(c.text) || !opt(c.url) || !opt(c.linkLabel)) return undefined;
    // `who` is the agent's word for who does this step; a value it does not know is dropped (the words decide then).
    const who = c.who === 'app' || c.who === 'owner' ? c.who : undefined;
    check = { text: c.text, ...(c.url ? { url: c.url } : {}), ...(c.linkLabel ? { linkLabel: c.linkLabel } : {}), ...(who ? { who } : {}) };
  }
  return { ask: b.ask, suggestion: b.suggestion, state: b.state, reasons, check, writtenBy: b.writtenBy };
}

/**
 * What the app did on its own about a question, kept only when it has the promised shape (a state it knows, a list of
 * steps with words, a whole number of rounds). Anything else is dropped: the card then behaves as before.
 */
export function readFollowUp(raw: unknown): FollowUp | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const f = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string';
  if (f.state !== 'queued' && f.state !== 'running' && f.state !== 'done' && f.state !== 'gave_up') return undefined;
  if (!Array.isArray(f.tried) || typeof f.roundsLeft !== 'number' || !Number.isFinite(f.roundsLeft)) return undefined;
  if (f.doing !== undefined && !str(f.doing)) return undefined;
  const tried: FollowUp['tried'] = [];
  for (const t of f.tried) {
    const x = t as Record<string, unknown> | null;
    if (!x || !str(x.what) || !str(x.result) || (x.url !== undefined && !str(x.url))) return undefined;
    tried.push({ what: x.what, result: x.result, ...(x.url ? { url: x.url } : {}) });
  }
  const doing = typeof f.doing === 'string' ? f.doing.trim() : '';
  return { state: f.state, ...(doing ? { doing } : {}), tried, roundsLeft: f.roundsLeft };
}

/** The settled/unsettled parts of a question as the agent sends them; each is dropped unless it is well formed. */
export function readSettled(q: { settledParts?: unknown; unsettledParts?: unknown }): { settledParts?: SettledPart[]; unsettledParts?: string[] } {
  const settledParts: SettledPart[] = [];
  if (Array.isArray(q.settledParts)) {
    for (const p of q.settledParts) {
      const x = p as Record<string, unknown> | null;
      if (!x || typeof x.model !== 'string' || !x.model.trim() || typeof x.what !== 'string') continue;
      const url = typeof x.url === 'string' && x.url.trim() ? x.url.trim() : undefined;
      settledParts.push({ model: x.model.trim(), what: x.what.trim(), ...(url ? { url } : {}) });
    }
  }
  const unsettledParts = Array.isArray(q.unsettledParts) ? q.unsettledParts.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map((m) => m.trim()) : [];
  return { ...(settledParts.length ? { settledParts } : {}), ...(unsettledParts.length ? { unsettledParts } : {}) };
}

export function mapQuestion(q: C.ReviewQuestion): ReviewQuestion {
  const brief = readBrief((q as C.ReviewQuestion & { brief?: unknown }).brief);
  const followUp = readFollowUp((q as C.ReviewQuestion & { followUp?: unknown }).followUp);
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
    ...(brief ? { brief } : {}),
    ...(followUp ? { followUp } : {}),
    ...readSettled(q),
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
    answers: (r.answers ?? []).map((a) => ({ id: a.id, questionId: a.questionId, title: a.title, answer: a.answer, at: a.at, undone: Boolean(a.undoneAt), undoable: !a.undoneAt && a.undoable })),
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
