// The mock agent for `VITE_MOCK=1`: the fixture-backed data in mockData.ts, kept in memory, with
// a short delay on every call and events pushed the way the real SSE stream pushes them. It answers
// in the same shapes as the real client (types.ts), so a screen cannot tell them apart.
// `?mock=real` is the owner's real data after two scans (mockReal.json, from fixtures/e2e-2026-11-23): 53 bundles waiting for
// lookups, 15 open questions with the AI's real suggestions, Keepa tokens, a rejected eBay key. `?mock=real-scanning` is the
// same app mid-scan, with a step in every state.
// `?mock=<scenario>` on the URL shows one state: nobuynow (no bundle is worth buying now), firstrun, empty, offline, chrome-closed, limit,
// scanning, paused, error, slow, pairing, unread (a scan stopped on unread Home Depot pages), helper-old. Nothing here touches the network.

import type { ApiClient } from './client';
import { words } from '../lib/platform';
import { mergePatch } from '../lib/patch';
import { confirmedSourceName } from '@core/scan/confirmed';
import { ACTIVITY, DEALS, DETAILS, QUESTIONS, SETTINGS, STATE, net } from './mockData';
import { mapReview, mapRow } from './map';
import real from './mockReal.json';
import { mockBogoView } from './mockTracking';
import { ApiError, type AgentEvent, type AppSettings, type AppState, type BogoRequest, type DealDetail, type DealRow, type FreeItem, type FreeItemBody, type PairedExtension, type PendingPairRequest, type PipelineView, type ReviewQuestion } from './types';

type Scenario = 'normal' | 'nobuynow' | 'firstrun' | 'empty' | 'offline' | 'chrome-closed' | 'limit' | 'scanning' | 'paused' | 'error' | 'slow' | 'pairing' | 'unread' | 'helper-old' | 'real' | 'real-scanning';

const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min: number): string => new Date(Date.now() + min * 60_000).toISOString();
const clone = <T>(x: T): T => structuredClone(x);

function scenario(): Scenario {
  if (typeof window === 'undefined') return 'normal';
  const s = new URLSearchParams(window.location.search).get('mock');
  const all: Scenario[] = ['nobuynow', 'firstrun', 'empty', 'offline', 'chrome-closed', 'limit', 'scanning', 'paused', 'error', 'slow', 'pairing', 'unread', 'helper-old', 'real', 'real-scanning'];
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
  let settings: AppSettings = clone(SETTINGS);
  let pairRequests: PendingPairRequest[] = [];
  let paired: PairedExtension[] = [{ extensionId: 'abcdefghijklmnopabcdefghijklmnop', pairedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), lastSeenAt: new Date(Date.now() - 60_000).toISOString() }];

  let ebayNotice: string | null = null;
  if (mode === 'real' || mode === 'real-scanning') {
    type RealRow = Parameters<typeof mapRow>[0] & { _parts: string[]; _evidence: NonNullable<DealDetail['splitEvidence']> };
    const rows = real.rows as unknown as RealRow[];
    deals = rows.map(mapRow);
    questions = mapReview(real.review as unknown as Parameters<typeof mapReview>[0]).questions;
    for (const r of rows) details[r.id] = realDetail(mapRow(r), r._parts, r._evidence);
    for (const q of questions) {
      const d = q.bundle.id ? details[q.bundle.id] : undefined;
      if (d) d.questionId = q.id;
    }
    state.counts = { review: questions.length, autopilotApplied: 2, newDeals: 0 };
    state.budget = { ...state.budget, serpLeft: 119, serpMonthly: 250, serpReserve: 100, serpPerScan: 18, keepaTokens: 57, keepaRefillPerMin: 1, aiSpentUsd: 0.7, aiCapUsd: 25 };
    state.keys = { serpapi: true, keepa: true, anthropic: true, openai: false, ebay: true, telegram: false };
    state.keyProblems = { ebay: 'eBay did not accept the App ID and Cert ID. Use the production keys from developer.ebay.com, not the sandbox pair.' };
    state.agent.nextScanAt = null;
    const waiting = deals.filter((d) => d.lookup).length;
    state.agent.drip = { active: true, waiting, nextAt: ahead(4), lastLookupAt: ago(7) };
    state.agent.lastScan = { at: ago(51), result: 'finished', newDeals: 0, searches: 1, message: null, waitingLookups: waiting, lookupsDone: { keepa: 0, serpapi: 1 }, lookupsBlockedBy: 'keepa_tokens' };
    ebayNotice = 'eBay did not accept the App ID and Cert ID, so eBay reference values were not checked.';
    activity.runs = activity.runs.slice(0, 3);
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
      d.estimate = { ...d.estimate, partsSellFor, afterFees, profit, roi, countedAtZero: d.parts.filter((p) => p.price === null).map((p) => (p.unnamed ? (p.title ?? p.model) : p.model)) };
      deals = deals.map((r) => (r.id === d.id ? { ...r, profit, roi } : r));
    }
  };

  const sync = () => {
    state.counts.review = questions.length;
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
    async downloadDealsCsv() {
      await online();
    },

    async review() {
      await online();
      if (mode === 'error') throw new ApiError('server', 'The agent could not read the questions. Try again.');
      return { questions: clone(questions) };
    },
    async answer(id) {
      await online();
      questions = questions.filter((q) => q.id !== id);
      deals = deals.map((d) => (questions.some((q) => q.bundle.id === d.id) ? d : { ...d, needsAnswer: false }));
      sync();
      emit({ type: 'review' });
    },
    async ask(id) {
      await online(1400);
      questions = questions.map((q) =>
        q.id === id && !q.suggestion && q.askCostUsd !== null
          ? { ...q, suggestion: { status: 'cannot_tell', choiceId: null, answer: '', reason: 'The listing title and page do not name the model.', quotes: [], costUsd: q.askCostUsd } }
          : q,
      );
      emit({ type: 'review' });
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
      let link = body.url.trim();
      if (body.kind === 'ebay-listing') {
        const chosen = p.confirm.ebay.find((c) => c.url === link);
        if (!chosen) throw new ApiError('server', 'That is not one of this part’s stored eBay listings.');
        price = chosen.price;
      } else {
        price = body.price;
      }
      link = new URL(link).toString();
      const note = body.note?.trim() || null;
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
      await online(400);
      if (name === 'serpapi' && (value as { key: string }).key.trim().length < 20) throw new ApiError('refused', 'SerpApi did not accept this key.');
      state.keys[name] = true;
      sync();
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
