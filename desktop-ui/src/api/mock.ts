// The mock agent for `VITE_MOCK=1`: the fixture-backed data in mockData.ts, kept in memory, with
// a short delay on every call and events pushed the way the real SSE stream pushes them. It answers
// in the same shapes as the real client (types.ts), so a screen cannot tell them apart.
// `?mock=<scenario>` on the URL shows one state: firstrun, empty, offline, chrome-closed, limit,
// scanning, paused, error, slow, pairing. Nothing here touches the network.

import type { PipelineView } from '@core/scan/pipeline';
import type { ApiClient } from './client';
import { mergePatch } from '../lib/patch';
import { confirmedSourceName } from '@core/scan/confirmed';
import { ACTIVITY, DEALS, DETAILS, QUESTIONS, SETTINGS, STATE, net } from './mockData';
import { ApiError, type AgentEvent, type AppSettings, type AppState, type DealDetail, type PairedExtension, type PendingPairRequest, type ReviewQuestion } from './types';

type Scenario = 'normal' | 'firstrun' | 'empty' | 'offline' | 'chrome-closed' | 'limit' | 'scanning' | 'paused' | 'error' | 'slow' | 'pairing';

const clone = <T>(x: T): T => structuredClone(x);

function scenario(): Scenario {
  if (typeof window === 'undefined') return 'normal';
  const s = new URLSearchParams(window.location.search).get('mock');
  const all: Scenario[] = ['firstrun', 'empty', 'offline', 'chrome-closed', 'limit', 'scanning', 'paused', 'error', 'slow', 'pairing'];
  return all.find((x) => x === s) ?? 'normal';
}

const STEPS = ['Home Depot deals pages', 'Bundle pages', 'Home Depot part prices', 'eBay listings', 'Amazon lookups', 'Finish'];

/** The scan's stages as core's pipelineView words them, for a scan `tick` of `total` ticks in. */
function pipelineAt(tick: number, total: number): PipelineView {
  const per = total / STEPS.length;
  const now = Math.min(STEPS.length - 1, Math.floor(tick / per));
  const done = (tick % per) * 6 + 3;
  const eta = (total - tick) * 14;
  return {
    current: { label: ['Fetching deals pages', 'Reading bundle pages', 'Reading part prices', 'Checking eBay listings', 'Looking up parts', 'Finishing up'][now]!, count: `${done} of 24` },
    estimateText: tick < 2 ? 'estimating' : eta < 60 ? 'under a minute' : `about ${Math.round(eta / 60)} min`,
    stepsDone: now,
    stepsTotal: STEPS.length,
    fraction: tick / total,
    ariaValueText: `Step ${now + 1} of ${STEPS.length}, ${STEPS[now]!.toLowerCase()}`,
    steps: STEPS.map((label, i) => ({ label, state: i < now ? 'done' : i === now ? 'now' : 'next', figure: i < now ? '24 read' : i === now ? `${done} of 24` : '' })),
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
  if (mode === 'chrome-closed') state.helper = { paired: true, connected: false, lastSeenAt: new Date(Date.now() - 3 * 3600_000).toISOString(), jobsWaiting: 4 };
  if (mode === 'limit') {
    state.budget.serpLeft = 20;
    state.agent.lastScan = { at: new Date(Date.now() - 20 * 60_000).toISOString(), result: 'limit', newDeals: 1, searches: 3, message: 'The scan stopped at your reserve of 20 searches. Scans start again when the plan renews on Dec 1.' };
  }
  if (mode === 'paused') state.agent.status = 'paused';
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
    if (mode === 'offline') throw new ApiError('offline', 'The agent is not running. Open Split Finder from the menu bar to start it.');
  };

  return {
    async state() {
      await online(120);
      return clone(state);
    },
    async deals() {
      await online();
      if (mode === 'error') throw new ApiError('server', 'The agent could not read the deals. Try again.');
      return { rows: clone(deals), at: deals.length ? new Date(Date.now() - 47 * 60_000).toISOString() : null, ebayNotice: null, limitNotice: null, staleDays: null };
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
