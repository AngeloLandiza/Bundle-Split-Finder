// The mock agent for `VITE_MOCK=1`: the fixture-backed data in mockData.ts, kept in memory, with
// a short delay on every call and events pushed the way the real SSE stream pushes them. It answers
// in the same shapes as the real client (types.ts), so a screen cannot tell them apart.
// `?mock=real` is the owner's real data (mockReal.json, from fixtures/e2e-2026-11-23): since Nov 23, after his third scan
// (after-scan3: 59 deals through the agent's own views, 13 estimates and 39 missing a price, 10 open questions), with Keepa
// tokens and a rejected eBay key; the second scan's 53 bundles and 15 questions with real AI suggestions stay in the file. `?mock=real-scanning` is the
// same app mid-scan, with a step in every state; `real-problems` the same app with an outdated helper and unread pages besides the waiting lookups.
// `?mock=<scenario>` on the URL shows one state: nobuynow (no bundle is worth buying now), firstrun, empty, offline, chrome-closed, limit,
// scanning, paused, error, slow, pairing, unread (a scan stopped on unread Home Depot pages), helper-old. Nothing here touches the network.

import type { ApiClient } from './client';
import { words } from '../lib/platform';
import { mergePatch } from '../lib/patch';
import { confirmedSourceName } from '@core/scan/confirmed';
import { ACTIVITY, DEALS, DETAILS, QUESTIONS, SETTINGS, STATE, net } from './mockData';
import type * as C from '@core/api/contract';
import { mapDetail, mapReview, mapRow } from './map';
import { followUpVariants } from './mockFollowUp';
import real from './mockReal.json';
import { applyFees } from './mockFees';
import { mockBogoView } from './mockTracking';
import { parseListingLink } from '@core/scan/listingLink';
import { ApiError, isWorking, type AgentEvent, type AppSettings, type AppState, type BogoRequest, type KeyCheck, type KeyName, type DealDetail, type DealRow, type FollowUp, type FreeItem, type FreeItemBody, type PairedExtension, type PendingPairRequest, type PipelineView, type ReviewQuestion } from './types';

type Scenario = 'normal' | 'nobuynow' | 'firstrun' | 'empty' | 'offline' | 'chrome-closed' | 'limit' | 'scanning' | 'paused' | 'error' | 'slow' | 'pairing' | 'unread' | 'helper-old' | 'real' | 'real-ai' | 'real-scanning' | 'real-problems' | 'real-early';

const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min: number): string => new Date(Date.now() + min * 60_000).toISOString();
const clone = <T>(x: T): T => structuredClone(x);

/** The words each service gives for a key it refuses, as the agent says them (agent/keyChecks.ts). */
const REFUSED: Record<KeyName, string> = {
  serpapi: 'SerpApi did not accept this key (HTTP 401). Copy it again from serpapi.com › Manage API Key.',
  keepa: 'Keepa did not accept this key (HTTP 401). Copy the access key from keepa.com › Account › API access.',
  anthropic: 'Claude answered authentication_error: invalid x-api-key (HTTP 401). Copy the key from console.anthropic.com › Settings › API keys.',
  openai: "DeepSeek answered authentication_error: Authentication Fails (HTTP 401). Copy the key again from that service's API keys page.",
  ebay: 'eBay answered invalid_client: client authentication failed (HTTP 401). Copy the App ID (Client ID) and Cert ID (Client Secret) from the Production keyset at developer.ebay.com › Application Keys.',
  telegram: 'Telegram did not accept the bot token. Copy it again from BotFather in Keys. Telegram said: Unauthorized.',
};
const SERVICE: Record<KeyName, string> = { serpapi: 'SerpApi', keepa: 'Keepa', anthropic: 'Anthropic', openai: 'the model service', ebay: 'eBay', telegram: 'Telegram' };
const WORKS: Partial<Record<KeyName, string>> = { serpapi: '118 of 250 searches left', keepa: '60 tokens, 1 a minute', telegram: 'bot @split_finder_bot, chat found' };

function scenario(): Scenario {
  if (typeof window === 'undefined') return 'normal';
  const s = new URLSearchParams(window.location.search).get('mock');
  const all: Scenario[] = ['nobuynow', 'firstrun', 'empty', 'offline', 'chrome-closed', 'limit', 'scanning', 'paused', 'error', 'slow', 'pairing', 'unread', 'helper-old', 'real', 'real-ai', 'real-scanning', 'real-problems', 'real-early'];
  return all.find((x) => x === s) ?? 'normal';
}

const STEPS = ['Home Depot deals pages', 'Bundle pages', 'Home Depot part prices', 'eBay listings', 'Amazon lookups', 'Finish'];

/** The scan's stages as core's pipelineView words them, for a scan `tick` of `total` ticks in. The time shows once a rate is known. */
function pipelineAt(tick: number, total: number): PipelineView {
  const per = total / STEPS.length;
  const now = Math.min(STEPS.length - 1, Math.floor(tick / per));
  const done = (tick % per) * 6 + 3;
  const eta = (total - tick) * 14;
  return {
    current: { label: ['Fetching deals pages', 'Reading bundle pages', 'Reading part prices', 'Checking eBay listings', 'Looking up parts', 'Finishing up'][now]!, count: `${done} of 24` },
    estimateText: tick < 3 ? '' : eta < 60 ? 'under a minute' : `about ${Math.round(eta / 60)} min`,
    stepsDone: now,
    stepsTotal: STEPS.length,
    fraction: tick / total,
    ariaValueText: `Step ${now + 1} of ${STEPS.length}, ${STEPS[now]!.toLowerCase()}`,
    steps: STEPS.map((label, i) => ({ label, state: i < now ? ('done' as const) : i === now ? ('now' as const) : ('next' as const), figure: i < now ? '24 read' : i === now ? `${done} of 24` : '', ...(i === now ? { done, total: 24 } : {}) })),
  };
}

/** The real second scan, mid-way: every mark once. Home Depot part prices at 31 of 40; the listing check failed; eBay skipped. */
const REAL_PIPELINE: PipelineView = {
  current: { label: 'Reading part prices', count: '31 of 40' },
  estimateText: '',
  stepsDone: 3,
  stepsTotal: 8,
  fraction: 0.46,
  ariaValueText: 'Step 4 of 8, reading part prices, 31 of 40',
  steps: [
    { label: 'Home Depot deals pages', state: 'done', figure: '1 read' },
    { label: 'Bundle pages', state: 'done', figure: '16 read', done: 16, total: 16 },
    { label: 'Kit pages', state: 'done', figure: '3 read', done: 3, total: 3 },
    { label: 'Home Depot part prices', state: 'now', figure: '31 of 40', done: 31, total: 40 },
    { label: 'eBay listings', state: 'skipped', figure: 'key not accepted' },
    { label: 'Listing check (Claude)', state: 'failed', figure: 'Anthropic did not answer' },
    { label: 'Amazon lookups', state: 'next', figure: '' },
    { label: 'Finish', state: 'next', figure: '' },
  ],
};

/** The third scan's open questions, each with the AI answer the second scan recorded for the same question (`?mock=real-ai`). */
function withRecordedSuggestions(r: C.ReviewResponse): C.ReviewResponse {
  const earlier = (real as unknown as { review: C.ReviewResponse }).review.questions;
  return {
    ...r,
    questions: r.questions.map((q) => {
      if (q.model === 'PCL406424SB-A21701-A25RS51') {
        // The owner's own screen: the AI read the page and could not tell (docs/design.md, Review).
        const quote = { quote: 'Includes: 18V ONE+ Cordless Compact Router, (1) collet wrench, (1) vacuum Dust Chute, 18V 5" Random Orbit Sander, (3) Pieces of Sandpaper Assortment, Dust Collection Bag, and Operator\'s Manuals', sourceId: 'bundle', label: 'Home Depot page', url: q.sources[0]?.url ?? null, names: false };
        const reason = 'PCL406424SB looks like a special-buy set of two tools rather than a catalog kit, and Home Depot search failed, so the exact tool-only model numbers inside it could not be confirmed.';
        const suggestion = { key: `${q.id}|0`, questionId: q.id, seen: q.seen ?? '', askedAt: 0, suggestion: { status: 'cannot_tell', reason, quotes: [quote] }, costUsd: 0.06 };
        return { ...q, suggestion: suggestion as unknown as typeof q.suggestion };
      }
      const old = earlier.find((e) => e.id === q.id);
      return old?.suggestion ? { ...q, suggestion: old.suggestion, suggestionQuotes: old.suggestionQuotes, suggestionPlain: old.suggestionPlain } : q;
    }),
  };
}

/** The agent's counts: a question the app is still checking is not in `review` (it does not need him yet). */
function reviewCounts(questions: readonly ReviewQuestion[]): { review: number; reviewWorking: number } {
  const working = questions.filter((q) => isWorking(q.followUp)).length;
  return { review: questions.length - working, reviewWorking: working };
}

/** A real bundle row as a deal's detail: no estimate yet, the parts as the scan split them, how the split is known. */
function realDetail(row: DealRow, parts: string[], evidence: NonNullable<DealDetail['splitEvidence']>): DealDetail {
  return {
    id: row.id, title: row.title, brand: row.brand, model: row.model, section: row.section, price: row.price, off: row.off, seenAt: row.updatedAt, link: row.link,
    estimate: null,
    noEstimate: row.needsAnswer ? 'No estimate yet: what is inside this bundle is not settled.' : `No estimate yet: ${parts.length} ${parts.length === 1 ? 'part still needs' : 'parts still need'} an Amazon lookup.`,
    ways: [], questionId: null, asins: [], lookup: row.lookup, watch: null, signals: null, history: [], bogo: null, bogoGroup: null, fbaEstimate: null,
    parts: parts.map((m) => ({ model: m, qty: 1, title: null, grade: 'not_looked_up' as const, asin: null, price: null, net: null, prices: [], verifySearches: null, unnamed: false, confirm: { state: 'look-up-first' as const, ebay: [], confirmed: null, inactive: false } })),
    ...(evidence.length ? { splitEvidence: evidence } : {}),
  };
}

export function createMockClient(): ApiClient {
  const mode = scenario();
  const wait = (ms = mode === 'slow' ? 2400 : 220) => new Promise((r) => setTimeout(r, ms));
  const listeners = new Set<(e: AgentEvent) => void>();
  const emit = (e: AgentEvent) => listeners.forEach((l) => l(e));

  const state: AppState = clone(STATE);
  let deals = clone(DEALS);
  const details: Record<string, DealDetail> = clone(DETAILS);
  let questions: ReviewQuestion[] = clone(QUESTIONS);
  const activity = clone(ACTIVITY);
  /** The questions he answered, by answer id, for Undo. */
  const kept = new Map<string, ReviewQuestion>();
  let settings: AppSettings = clone(SETTINGS);
  let pairRequests: PendingPairRequest[] = [];
  let paired: PairedExtension[] = [{ extensionId: 'abcdefghijklmnopabcdefghijklmnop', pairedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), lastSeenAt: new Date(Date.now() - 60_000).toISOString() }];

  let ebayNotice: string | null = null;
  if (mode === 'real' || mode === 'real-ai' || mode === 'real-scanning' || mode === 'real-problems' || mode === 'real-early') {
    type RealRow = Parameters<typeof mapRow>[0] & { _parts: string[]; _evidence: NonNullable<DealDetail['splitEvidence']> };
    const scan3 = (real as unknown as { scan3?: { deals: C.DealsResponse; details: Record<string, C.DealDetail>; review: C.ReviewResponse } }).scan3;
    if (scan3) {
      // Nov 23: the owner's data after his third scan, every deal and detail as the agent's own views give them.
      deals = scan3.deals.rows.map(mapRow);
      // `real-ai`: the same ten questions with the AI answers the second scan recorded for them (a suggestion made for other
      // choices is dropped by mapSuggestion, as in the app), and the "could not tell" the owner saw on PCL406424SB.
      questions = mapReview(mode === 'real-ai' ? withRecordedSuggestions(scan3.review) : scan3.review).questions;
      // `real-ai` also shows the app's own follow-up in each of its four states, copies of the owner's PCL406424SB question.
      if (mode === 'real-ai') questions = questions.flatMap((q) => [q, ...followUpVariants(q)]);
      for (const [id, d] of Object.entries(scan3.details)) details[id] = mapDetail(d, questions.find((q) => q.bundle.id === id)?.id ?? null);
    } else {
      const rows = real.rows as unknown as RealRow[];
      deals = rows.map(mapRow);
      questions = mapReview(real.review as unknown as Parameters<typeof mapReview>[0]).questions;
      for (const r of rows) details[r.id] = realDetail(mapRow(r), r._parts, r._evidence);
    }
    for (const q of questions) {
      const d = q.bundle.id ? details[q.bundle.id] : undefined;
      // The follow-up copies (`~` in the id) show a state; the deal's own question is the real one.
      if (d && !q.id.includes('~')) d.questionId = q.id;
    }
    state.counts = { ...reviewCounts(questions), autopilotApplied: 2, newDeals: 0 };
    if (!state.counts.reviewWorking) delete state.counts.reviewWorking;
    state.budget = { ...state.budget, serpLeft: 119, serpMonthly: 250, serpReserve: 100, serpPerScan: 18, keepaTokens: 57, keepaRefillPerMin: 1, aiSpentUsd: 0.7, aiCapUsd: 25 };
    state.keys = { serpapi: true, keepa: true, anthropic: true, openai: false, ebay: true, telegram: false };
    state.keyProblems = { ebay: 'eBay did not accept the App ID and Cert ID. Use the production keys from developer.ebay.com, not the sandbox pair.' };
    state.agent.nextScanAt = null;
    const waiting = deals.filter((d) => d.lookup).length;
    // After-scan3 with fees counted per part (docs/decisions.md, Signals round 3): the replay's figures, 24 fee pulls waiting, 13 tokens.
    applyFees(deals, details, mode === 'real-early' ? 'early' : 'replay');
    state.budget = { ...state.budget, keepaTokens: 13 };
    state.agent.drip = { active: true, waiting, nextAt: ahead(4), lastLookupAt: ago(7), feesWaiting: 24 };
    state.agent.lastScan = { at: ago(51), result: 'finished', newDeals: 0, searches: 1, message: null, waitingLookups: waiting, lookupsDone: { keepa: 0, serpapi: 1 }, lookupsBlockedBy: 'keepa_tokens' };
    ebayNotice = 'eBay did not accept the App ID and Cert ID, so eBay reference values were not checked.';
    activity.runs = activity.runs.slice(0, 3);
  }
  if (mode === 'real-problems') {
    // Three things true at once: an outdated helper, a scan that left pages unread, lookups waiting (one banner, "2 more").
    state.helper = { ...state.helper, outdated: true, version: '0.4.1' };
    state.agent.lastScan = { ...state.agent.lastScan!, result: 'stopped', message: 'Home Depot refused a page (HTTP 200); the rest are read next scan.', pagesUnread: 6, canReadPagesAgain: true };
  }
  if (mode === 'real-scanning') {
    state.agent.status = 'scanning';
    state.agent.pipeline = REAL_PIPELINE;
  }
  if (mode === 'firstrun') {
    state.firstRun = true;
    state.keys = { serpapi: false, keepa: false, anthropic: false, openai: false, ebay: false, telegram: false };
    state.helper = { paired: false, connected: false, lastSeenAt: null, jobsWaiting: 0 };
    state.agent.lastScan = null;
    state.budget.aiSpentUsd = 0;
    paired = [];
  }
  if (mode === 'firstrun' || mode === 'empty') {
    deals = [];
    questions = [];
    activity.runs = [];
    activity.autopilot = [];
    activity.errors = [];
    state.counts = { review: 0, autopilotApplied: 0, newDeals: 0 };
  }
  if (mode === 'nobuynow') {
    deals = deals.map((d) => ({ ...d, buyNow: false }));
    for (const d of Object.values(details)) if (d.signals) d.signals = { ...d.signals, buyNow: null, signals: d.signals.signals.filter((x) => x.kind !== 'buyNow'), options: d.signals.options.map((o) => ({ ...o, buyNow: false, notBuyNow: o.notBuyNow ?? 'Still above your thresholds, but no better than the last scan.' })) };
  }
  if (mode === 'chrome-closed') state.helper = { paired: true, connected: false, lastSeenAt: new Date(Date.now() - 3 * 3600_000).toISOString(), jobsWaiting: 4 };
  if (mode === 'limit') {
    state.budget.serpLeft = 20;
    state.agent.lastScan = { at: new Date(Date.now() - 20 * 60_000).toISOString(), result: 'limit', newDeals: 1, searches: 3, message: 'The scan stopped at your reserve of 20 searches. Scans start again when the plan renews on Dec 1.' };
  }
  if (mode === 'paused') state.agent.status = 'paused';
  if (mode === 'unread') {
    // The first scan stopped on a Home Depot page read: the bundles whose page was not read wait, they are not questions.
    const unread = deals.filter((d) => d.needsAnswer).slice(0, 4);
    const ids = new Set(unread.map((d) => d.id));
    deals = deals.map((d) => (ids.has(d.id) ? { ...d, needsAnswer: false, matchKind: 'waiting_page' as const, matchState: null, profit: null, roi: null, roiRange: null } : d));
    questions = questions.filter((q) => !q.bundle.id || !ids.has(q.bundle.id));
    state.agent.lastScan = { at: new Date(Date.now() - 5 * 60_000).toISOString(), result: 'stopped', newDeals: 0, searches: 3, message: 'Home Depot refused a page (HTTP 200); the rest are read next scan.', pagesUnread: 16, canReadPagesAgain: true };
  }
  if (mode === 'helper-old') state.helper = { ...state.helper, outdated: true, version: '0.4.1' };
  if (mode === 'pairing') {
    pairRequests = [{ requestId: 'pair-1', extensionId: 'ponmlkjihgfedcbaponmlkjihgfedcba', code: '482913', requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }];
  }

  /** The estimate after a confirmed price changes: the same fee rule as the seed (mockData.ts). */
  const recount = (d: DealDetail) => {
    const counted = d.parts.filter((p) => p.price !== null);
    if (d.estimate) {
      const partsSellFor = Math.round(counted.reduce((sum, p) => sum + (p.price ?? 0) * p.qty, 0) * 100) / 100;
      const afterFees = Math.round(counted.reduce((sum, p) => sum + net(p.price ?? 0) * p.qty, 0) * 100) / 100;
      const profit = Math.round((afterFees - d.estimate.cost) * 100) / 100;
      const roi = Math.round((profit / d.estimate.cost) * 10000) / 10000;
      d.estimate = { ...d.estimate, partsSellFor, afterFees, profit, roi, countedAtZero: d.parts.filter((p) => p.price === null && p.unnamed).map((p) => p.title ?? p.model) };
      deals = deals.map((r) => (r.id === d.id ? { ...r, profit, roi } : r));
    } else if (d.incomplete) {
      // Nov 23: a confirmed price fills an unpriced part; once every model part is priced the deal has its estimate.
      const i = d.incomplete;
      const afterFees = Math.round(counted.reduce((sum, p) => sum + net(p.price ?? 0) * p.qty, 0) * 100) / 100;
      const left = i.parts.filter((u) => d.parts.find((p) => p.model === u.model)?.price == null);
      if (left.length === 0) {
        const partsSellFor = Math.round(counted.reduce((sum, p) => sum + (p.price ?? 0) * p.qty, 0) * 100) / 100;
        const profit = Math.round((afterFees - i.cost) * 100) / 100;
        const roi = Math.round((profit / i.cost) * 10000) / 10000;
        d.estimate = { profit, roi, roiRange: null, cost: i.cost, partsSellFor, afterFees, basis: i.basis, countedAtZero: i.notCounted };
        d.incomplete = null;
        deals = deals.map((r) => (r.id === d.id ? { ...r, profit, roi, incomplete: null } : r));
      } else {
        const breakEvenNet = Math.max(0, Math.round((i.cost - afterFees) * 100) / 100);
        const next = { ...i, priced: i.total - left.length, pricedNet: afterFees, breakEvenNet, breakEvenPrice: null, unpriced: left.map((u) => u.model), parts: left };
        d.incomplete = next;
        deals = deals.map((r) => (r.id === d.id ? { ...r, incomplete: { priced: next.priced, total: next.total, pricedNet: afterFees, breakEvenNet, breakEvenPrice: null, unpriced: next.unpriced } } : r));
      }
    }
  };

  const sync = () => {
    state.counts = { ...state.counts, ...reviewCounts(questions) };
    if (!state.counts.reviewWorking) delete state.counts.reviewWorking;
    emit({ type: 'state', state: clone(state) });
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  const runScan = () => {
    state.agent.status = 'scanning';
    let tick = 0;
    const total = STEPS.length * 4;
    const set = () => {
      state.agent.pipeline = pipelineAt(tick, total);
    };
    set();
    sync();
    timer = setInterval(() => {
      tick += 1;
      if (tick >= total) {
        stopTimer();
        state.agent = { ...state.agent, status: 'idle', pipeline: null, step: null, lastScan: { at: new Date().toISOString(), result: 'finished', newDeals: 1, searches: 5, message: null } };
        state.budget.serpLeft = (state.budget.serpLeft ?? 0) - 5;
        state.firstRun = false;
        if (deals.length === 0) deals = clone(DEALS);
        sync();
        emit({ type: 'deals' });
        emit({ type: 'notify', title: 'Scan finished', body: '1 new deal above 25% ROI.' });
        return;
      }
      set();
      sync();
    }, 1500);
  };
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  if (mode === 'scanning') runScan();

  const online = async (ms?: number) => {
    await wait(ms);
    if (mode === 'offline') throw new ApiError('offline', `The agent is not running. Open Split Finder from the ${words.trayPlace} to start it.`);
  };

  /** What the key's own service says, and what the agent records of it (keyProblems, keyChecks). */
  const checked = (name: KeyName, typed: string, context: 'save' | 'recheck'): KeyCheck => {
    const at = new Date().toISOString();
    if (/offline/i.test(typed)) {
      const problem = `Could not reach ${SERVICE[name]} to check it just now`;
      return { ok: false, kind: 'network', problem: context === 'save' ? `Saved. ${problem} — it is checked again at the next scan.` : `${problem}. Try again in a moment.` };
    }
    if (/bad/i.test(typed)) {
      state.keyProblems = { ...state.keyProblems, [name]: REFUSED[name] };
      state.keyChecks = { ...state.keyChecks, [name]: { ok: false, at } };
      sync();
      return { ok: false, kind: 'rejected', problem: REFUSED[name] };
    }
    const detail = WORKS[name];
    if (state.keyProblems) delete state.keyProblems[name];
    state.keyChecks = { ...state.keyChecks, [name]: { ok: true, at, ...(detail ? { detail } : {}) } };
    sync();
    return { ok: true, ...(detail ? { detail } : {}) };
  };

  return {
    async state() {
      await online(120);
      return clone(state);
    },
    async deals() {
      await online();
      if (mode === 'error') throw new ApiError('server', 'The agent could not read the deals. Try again.');
      return { rows: clone(deals), at: deals.length ? new Date(Date.now() - 47 * 60_000).toISOString() : null, ebayNotice, limitNotice: null, staleDays: null };
    },
    async deal(id) {
      await online();
      const d = details[id];
      if (!d) throw new ApiError('server', 'This bundle is no longer in the deals. The last scan dropped it.');
      return clone(d);
    },
    async downloadAudit() {
      await online();
    },
    async resetScanData() {
      await online();
      return { backup: '/Users/you/Library/Application Support/Split Finder/backup-before-reset-2026-11-23T12-00-00-000Z' };
    },
    async downloadDealsCsv() {
      await online();
    },

    async review() {
      await online();
      if (mode === 'error') throw new ApiError('server', 'The agent could not read the questions. Try again.');
      return { questions: clone(questions) };
    },
    async answer(id, a) {
      await online();
      const q = questions.find((x) => x.id === id);
      questions = questions.filter((x) => x.id !== id);
      deals = deals.map((d) => (questions.some((x) => x.bundle.id === d.id) ? d : { ...d, needsAnswer: false }));
      sync();
      emit({ type: 'review' });
      if (!q || 'ebay' in a) return { answerId: null };
      const answerId = `oa-${Date.now()}-${kept.size}`;
      kept.set(answerId, q);
      const said = 'none' in a ? 'None of these' : 'parts' in a ? a.parts.join(', ') : (q.choices.find((c) => 'choiceId' in a && c.id === a.choiceId)?.label ?? 'the answer');
      activity.answers = [{ id: answerId, questionId: id, title: q.bundle.title, answer: said, at: new Date().toISOString(), undone: false, undoable: true }, ...activity.answers];
      emit({ type: 'activity' });
      return { answerId };
    },
    async undoAnswer(answerId) {
      await online();
      const q = kept.get(answerId);
      const entry = activity.answers.find((x) => x.id === answerId);
      if (!q || !entry || entry.undone) throw new ApiError('refused', 'That answer was undone already.');
      questions = [q, ...questions];
      deals = deals.map((d) => (d.id === q.bundle.id ? { ...d, needsAnswer: true } : d));
      activity.answers = activity.answers.map((x) => (x.id === answerId ? { ...x, undone: true, undoable: false } : x));
      sync();
      emit({ type: 'review' });
      emit({ type: 'activity' });
      return { questionId: q.id };
    },
    async askAi(id, o) {
      await online(700);
      const q = questions.find((x) => x.id === id);
      if (!q) throw new ApiError('refused', 'That question is not open any more.');
      if (isWorking(q.followUp)) return { queued: false, reason: 'The app is already working on this one.', canForce: false };
      if (q.askCostUsd === null) return { queued: false, reason: 'There is nothing more the AI could read for this question.', canForce: false };
      if (q.suggestion && !o?.force) return { queued: false, reason: 'Nothing new to read since the last answer.', canForce: true, costUsd: q.askCostUsd };
      // The app takes it: queued, then running with what it is doing, then done with what it tried (invented here).
      const tried = q.followUp?.tried ?? [];
      const set = (followUp: FollowUp, suggestion = q.suggestion) => {
        questions = questions.map((x) => (x.id === id ? { ...x, followUp, suggestion } : x));
        sync();
        emit({ type: 'review' });
      };
      set({ state: 'queued', tried, roundsLeft: 2 });
      setTimeout(() => set({ state: 'running', doing: `Reading Home Depot's page for ${q.subject}`, tried, roundsLeft: 2 }), 1500);
      setTimeout(() => {
        const next: FollowUp = { state: 'done', tried: [...tried, { what: `Read Home Depot's page for ${q.subject}`, result: 'the Includes list names the same parts as before', ...(q.bundle.link ? { url: q.bundle.link } : {}) }], roundsLeft: 1 };
        set(next, q.askCostUsd === null ? q.suggestion : { status: 'cannot_tell', choiceId: null, answer: '', reason: 'The listing title and page do not name the model.', quotes: [], costUsd: q.askCostUsd });
      }, 4000);
      return { queued: true };
    },
    async askAll() {
      await online();
      state.agent.status = 'asking';
      state.agent.step = 'Asking the AI';
      sync();
      setTimeout(() => {
        state.agent = { ...state.agent, status: 'idle', pipeline: null, step: null };
        sync();
        emit({ type: 'review' });
      }, 3000);
    },
    async approve(ids) {
      await online();
      const ok = questions.filter((q) => ids.includes(q.id) && q.suggestion?.status === 'verified');
      questions = questions.filter((q) => !ok.includes(q));
      sync();
      emit({ type: 'review' });
      return { approved: ok.length, skipped: ids.filter((i) => !ok.some((q) => q.id === i)).map((id) => ({ id, reason: 'Only a verified suggestion can be approved.' })) };
    },

    async activity() {
      await online();
      return clone(activity);
    },
    async undo(id) {
      await online();
      activity.autopilot = activity.autopilot.map((a) => (a.id === id ? { ...a, undone: true } : a));
      emit({ type: 'activity' });
    },
    async retry(id) {
      await online();
      activity.errors = activity.errors.filter((e) => e.id !== id);
      emit({ type: 'activity' });
      runScan();
    },

    async scan() {
      await online();
      if (state.agent.status === 'scanning') throw new ApiError('refused', 'A scan is already running.');
      runScan();
    },
    async readPagesAgain() {
      await online(400);
      const last = state.agent.lastScan;
      if (!last?.pagesUnread) return { started: false, reason: 'No pages are waiting to be read.' };
      state.agent.lastScan = { ...last, pagesUnread: 0, canReadPagesAgain: false, message: null, result: 'finished' };
      deals = deals.map((d) => (d.matchKind === 'waiting_page' ? { ...d, matchKind: null } : d));
      sync();
      emit({ type: 'deals' });
      return { started: true };
    },
    async runLookups(body) {
      await online(500);
      if (state.agent.status === 'scanning') return { started: false, reason: 'A scan is running. Look up when it has finished.', viaKeepa: 0, viaSerpapi: 0 };
      const waiting = deals.filter((d) => d.lookup);
      const viaKeepa = Math.min(waiting.length, Math.floor((state.budget.keepaTokens ?? 0) / 10));
      const viaSerpapi = Math.min(Math.max(0, waiting.length - viaKeepa), body?.maxSearches ?? 0);
      if (viaKeepa + viaSerpapi === 0) return { started: false, reason: 'Nothing can be looked up now: Keepa has no tokens to spare and no searches are allowed.', viaKeepa: 0, viaSerpapi: 0 };
      const done = new Set(waiting.slice(0, viaKeepa + viaSerpapi).map((d) => d.id));
      setTimeout(() => {
        deals = deals.map((d) => (done.has(d.id) ? { ...d, lookup: null } : d));
        const left = deals.filter((d) => d.lookup).length;
        state.budget.keepaTokens = Math.max(0, (state.budget.keepaTokens ?? 0) - viaKeepa * 10);
        state.budget.serpLeft = (state.budget.serpLeft ?? 0) - viaSerpapi;
        if (state.agent.drip) state.agent.drip = { ...state.agent.drip, waiting: left };
        if (state.agent.lastScan) state.agent.lastScan = { ...state.agent.lastScan, waitingLookups: left };
        sync();
        emit({ type: 'deals' });
      }, 1500);
      return { started: true, viaKeepa, viaSerpapi };
    },
    async reloadHelper() {
      await online(400);
      state.helper = { ...state.helper, outdated: false };
      sync();
    },
    async stop() {
      await online();
      stopTimer();
      state.agent = { ...state.agent, status: 'idle', pipeline: null, step: null, lastScan: { at: new Date().toISOString(), result: 'stopped', newDeals: 0, searches: 2, message: 'You stopped the scan. Prices found so far are kept.' } };
      sync();
    },
    async pause() {
      await online();
      stopTimer();
      state.agent = { ...state.agent, status: 'paused', pipeline: null, step: null };
      sync();
    },
    async resume() {
      await online();
      state.agent.status = 'idle';
      sync();
    },
    async lookupQuote(id) {
      await online(80);
      return deals.find((d) => d.id === id)?.lookup?.searches ?? 0;
    },
    async lookUp(id) {
      await online(900);
      deals = deals.map((d) => (d.id === id ? { ...d, lookup: null } : d));
      state.budget.serpLeft = (state.budget.serpLeft ?? 0) - 2;
      sync();
      emit({ type: 'deals' });
    },
    async verify() {
      await online(900);
      state.budget.serpLeft = (state.budget.serpLeft ?? 0) - 1;
      sync();
    },
    async confirmPrice(id, model, body) {
      await online(300);
      const d = details[id];
      const p = d?.parts.find((x) => x.model === model);
      if (!d || !p) throw new ApiError('server', 'No such part in this deal.');
      if (p.confirm.state === 'answer-first') throw new ApiError('refused', 'Answer its question first. A price counts only after its Amazon listing is chosen.');
      if (p.confirm.state === 'look-up-first') throw new ApiError('refused', 'Look this part up on Amazon first.');
      if (p.confirm.state === 'amazon-counts' && !p.confirm.confirmed) throw new ApiError('refused', 'This part counts at its Amazon price. A price you confirm counts only when the listing is not for sale.');
      let price: number;
      // The mock holds no suggestion's evidence: a suggested price links eBay's search for the part.
      let link = body.kind === 'suggested' ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(model)}` : body.url.trim();
      if (body.kind === 'ebay-listing') {
        const chosen = p.confirm.ebay.find((c) => c.url === link);
        if (!chosen) throw new ApiError('server', 'That is not one of this part’s stored eBay listings.');
        price = chosen.price;
      } else if (body.kind === 'suggested') {
        price = body.suggestion.price;
      } else {
        price = body.price;
      }
      link = new URL(link).toString();
      const note = body.kind === 'suggested' ? null : body.note?.trim() || null;
      const line = { label: `Confirmed by you · ${confirmedSourceName(link)}`, amount: price, range: null, counted: true, note, seenAt: new Date().toISOString(), sources: [{ label: 'Open the listing', url: link }], confirmed: true };
      p.prices = [line, ...p.prices.filter((x) => !x.confirmed)];
      p.price = price;
      p.net = net(price);
      p.confirm = { ...p.confirm, confirmed: { price, link, note } };
      recount(d);
      emit({ type: 'deals' });
    },
    async watch(id, watch) {
      await online(200);
      deals = deals.map((d) => (d.id === id ? { ...d, watched: watch, buyNow: watch ? d.buyNow : false } : d));
      const d = details[id];
      if (d) {
        d.watch = { watched: watch, by: 'owner', since: d.watch?.since ?? new Date().toISOString() };
        // A scan judges a watched bundle; until the next one there is nothing to say about a bundle just watched.
        if (!watch) d.signals = null;
      }
      emit({ type: 'deals' });
    },
    async setBogo(id, body) {
      await online(350);
      const d = details[id];
      if (!d) throw new ApiError('server', 'No such deal.');
      if (d.bogoGroup) throw new ApiError('refused', 'Home Depot lists this bundle as a BOGO pair: its free tool is already in it.');
      const prior = d.bogo;
      const toItem = (x: FreeItemBody): FreeItem => ({ brand: (x.brand?.trim() || d.brand).toUpperCase(), model: x.model.trim().toUpperCase(), title: x.title?.trim() || null, itemId: x.itemId ?? null, link: x.link?.trim() || null, parts: x.parts ?? null });
      const eligible = 'eligible' in body ? (body.eligible ? body.eligible.map(toItem) : null) : (prior?.eligible ?? null);
      const chosen = 'chosen' in body ? (body.chosen ?? []).map(toItem) : (prior?.chosen ?? []);
      const freeCount = body.freeCount ?? prior?.freeCount ?? 1;
      if (chosen.some((c) => !/^[A-Z0-9][A-Z0-9-./]{0,39}$/.test(c.model))) throw new ApiError('refused', 'Each free item needs a model number.');
      if (chosen.length > freeCount) throw new ApiError('refused', `Choose at most ${freeCount} free ${freeCount === 1 ? 'item' : 'items'}.`);
      const off = eligible ? chosen.find((c) => !eligible.some((e) => e.model === c.model)) : undefined;
      if (off) throw new ApiError('refused', `${off.model} is not on this promotion's eligible list.`);
      const link = 'link' in body ? (body.link ?? null) : (prior?.link ?? null);
      d.bogo = mockBogoView(d, { eligible, chosen, freeCount, link });
      deals = deals.map((r) => (r.id === id ? { ...r, bogo: d.bogo!.status } : r));
      emit({ type: 'deals' });
      return clone(d.bogo);
    },
    async removeBogo(id) {
      await online(250);
      const d = details[id];
      if (d) d.bogo = null;
      deals = deals.map((r) => (r.id === id ? { ...r, bogo: null } : r));
      emit({ type: 'deals' });
    },
    async priceFromLink(url) {
      await online(700);
      const link = parseListingLink(url);
      if (link.site === 'ebay' && link.id) {
        return { found: true, price: 74.99, currency: 'USD', title: 'DEWALT DCF887B 20V MAX XR Brushless Impact Driver Tool Only', condition: 'New', shipping: 8.5, source: 'eBay', url, readAt: new Date().toISOString() };
      }
      return { found: false, reason: link.site === 'other' ? 'Split Finder cannot read this site. Type the price you see.' : 'That link does not name one listing. Type the price you see.' };
    },
    async markNotSold() {
      await online(250);
      emit({ type: 'deals' });
    },
    async forgetFact() {
      await online(250);
      emit({ type: 'deals' });
      emit({ type: 'review' });
    },
    async removePrice(id, model) {
      await online(300);
      const d = details[id];
      const p = d?.parts.find((x) => x.model === model);
      if (!d || !p || !p.confirm.confirmed) throw new ApiError('server', 'This part has no confirmed price.');
      p.prices = p.prices.filter((x) => !x.confirmed);
      p.price = null;
      p.net = null;
      p.confirm = { ...p.confirm, confirmed: null };
      recount(d);
      emit({ type: 'deals' });
    },

    async settings() {
      await online();
      return clone(settings);
    },
    async testNotification() {
      await online(300);
    },
    async testTelegram() {
      await online(400);
      return state.keys.telegram ? { ok: true } : { ok: false, problem: 'Telegram is not set up. Add a bot token and chat id in Keys first.' };
    },
    async patchSettings(patch) {
      await online(150);
      const before = settings;
      settings = mergePatch(settings, patch as AppSettings);
      // The agent takes trust back to its measured list when a model's identity changes (agent/app.ts aiPipelinePatch).
      for (const p of ['judge', 'assist', 'research'] as const) {
        const a = before.ai[p];
        const b = settings.ai[p];
        const changed = a.provider !== b.provider || a.model !== b.model || (a.baseUrl ?? '') !== (b.baseUrl ?? '');
        if (changed && !(patch.ai?.[p] && 'trusted' in patch.ai[p]!)) settings.ai[p] = { ...b, trusted: b.provider === 'anthropic' };
      }
      state.budget.serpPerScan = settings.settings.searchesPerScan;
      state.budget.serpReserve = settings.settings.reserve;
      state.budget.aiCapUsd = settings.ai.monthlyCapUsd;
      sync();
      return clone(settings);
    },
    async putKey(name, value) {
      // The agent saves, then asks the key's own service (agent/keyChecks.ts). The mock answers by what was typed:
      // "bad" is refused, "offline" cannot reach the service, anything else works.
      state.keys[name] = true;
      if (state.keyProblems) delete state.keyProblems[name];
      if (state.keyChecks) delete state.keyChecks[name];
      sync();
      await online(1300);
      return checked(name, JSON.stringify(value), 'save');
    },
    async checkKey(name) {
      await online(900);
      return checked(name, '', 'recheck');
    },
    async deleteKey(name) {
      await online();
      state.keys[name] = false;
      sync();
    },

    async pairRequests() {
      await online(80);
      return clone(pairRequests);
    },
    async decidePairing(requestId, allow) {
      await online(400);
      const req = pairRequests.find((r) => r.requestId === requestId);
      pairRequests = pairRequests.filter((r) => r.requestId !== requestId);
      if (allow && req) {
        paired = [{ extensionId: req.extensionId, pairedAt: new Date().toISOString(), lastSeenAt: null }];
        state.helper = { paired: true, connected: true, lastSeenAt: new Date().toISOString(), jobsWaiting: 0 };
      }
      sync();
    },
    async pairedExtensions() {
      await online(80);
      return clone(paired);
    },
    async revokeExtension(extensionId) {
      await online();
      paired = paired.filter((p) => p.extensionId !== extensionId);
      if (paired.length === 0) state.helper = { paired: false, connected: false, lastSeenAt: null, jobsWaiting: 0 };
      sync();
    },
    async installExtension() {
      await online(600);
      return { ok: true, extensionDir: '/Users/you/Documents/split-finder', extensionReady: true, extensionMessage: 'Ready for Load unpacked in Chrome.', zipAvailable: true, lane: 'D' };
    },

    subscribe(onEvent, onStatus) {
      if (mode === 'offline') {
        const t = setTimeout(() => onStatus('down'), 50);
        return () => clearTimeout(t);
      }
      listeners.add(onEvent);
      onStatus('live');
      return () => listeners.delete(onEvent);
    },
  };
}
