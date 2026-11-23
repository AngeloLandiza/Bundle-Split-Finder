// The mock agent for `VITE_MOCK=1`: the fixture-backed data in mockData.ts, kept in memory, with
// a short delay on every call and events pushed the way the real SSE stream will push them.
// `?mock=<scenario>` on the URL shows one state: firstrun, empty, offline, chrome-closed, limit,
// scanning, paused, error, slow. Nothing here touches the network.

import type { ApiClient } from './client';
import { ACTIVITY, DEALS, DETAILS, QUESTIONS, SETTINGS, STATE } from './mockData';
import { ApiError, type AgentEvent, type AppState, type ReviewQuestion, type Settings } from './types';

type Scenario = 'normal' | 'firstrun' | 'empty' | 'offline' | 'chrome-closed' | 'limit' | 'scanning' | 'paused' | 'error' | 'slow';

const clone = <T>(x: T): T => structuredClone(x);

function scenario(): Scenario {
  if (typeof window === 'undefined') return 'normal';
  const s = new URLSearchParams(window.location.search).get('mock');
  const all: Scenario[] = ['firstrun', 'empty', 'offline', 'chrome-closed', 'limit', 'scanning', 'paused', 'error', 'slow'];
  return all.find((x) => x === s) ?? 'normal';
}

const STEPS = ['Reading Home Depot bundle pages', 'Searching Amazon for parts', 'Checking Keepa prices', 'Checking eBay listings', 'Asking AI about open questions'];

export function createMockClient(): ApiClient {
  const mode = scenario();
  const wait = (ms = mode === 'slow' ? 2400 : 220) => new Promise((r) => setTimeout(r, ms));
  const listeners = new Set<(e: AgentEvent) => void>();
  const emit = (e: AgentEvent) => listeners.forEach((l) => l(e));

  const state: AppState = clone(STATE);
  let deals = clone(DEALS);
  let questions: ReviewQuestion[] = clone(QUESTIONS);
  const activity = clone(ACTIVITY);
  let settings: Settings = clone(SETTINGS);
  let lastAsk: string | null = null;

  if (mode === 'firstrun') {
    state.firstRun = true;
    state.keys = { serpapi: false, keepa: false, anthropic: false, openai: false, ebay: false, telegram: false };
    state.helper = { paired: false, connected: false, lastSeenAt: null, jobsWaiting: 0 };
    state.agent.lastScan = null;
    state.budget.aiSpentUsd = 0;
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
      const i = Math.min(STEPS.length - 1, Math.floor(tick / 4));
      state.agent.step = { name: STEPS[i]!, index: i + 1, of: STEPS.length, done: (tick % 4) * 6 + 3, total: 24 };
      state.agent.progress = { fraction: tick / total, etaSeconds: tick < 2 ? null : (total - tick) * 14, searchesUsed: Math.min(5, Math.ceil(tick / 3)), aiSpentUsd: Math.max(0, (tick - 14) * 0.06) };
    };
    set();
    sync();
    timer = setInterval(() => {
      tick += 1;
      if (tick >= total) {
        stopTimer();
        state.agent = { ...state.agent, status: 'idle', step: null, progress: null, lastScan: { at: new Date().toISOString(), result: 'finished', newDeals: 1, searches: 5, message: null } };
        state.budget.serpLeft -= 5;
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
      return { rows: clone(deals), at: deals.length ? new Date(Date.now() - 47 * 60_000).toISOString() : null, ebayNotice: null };
    },
    async deal(id) {
      await online();
      const d = DETAILS[id];
      if (!d) throw new ApiError('server', 'This bundle is no longer in the deals. The last scan dropped it.');
      return clone(d);
    },
    dealsCsvUrl: () => 'data:text/csv;charset=utf-8,mock',

    async review() {
      await online();
      if (mode === 'error') throw new ApiError('server', 'The agent could not read the questions. Try again.');
      return { questions: clone(questions), lastAsk };
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
      state.agent.step = { name: 'Asking AI', index: 1, of: 1, done: 0, total: 2 };
      state.agent.progress = { fraction: 0, etaSeconds: 40, searchesUsed: 0, aiSpentUsd: 0 };
      sync();
      setTimeout(() => {
        state.agent = { ...state.agent, status: 'idle', step: null, progress: null };
        lastAsk = 'Asked 2 questions: none verified, 2 left for you. Cost $0.20.';
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
      return { approved: ok.length, refused: ids.length - ok.length };
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
      state.agent = { ...state.agent, status: 'idle', step: null, progress: null, lastScan: { at: new Date().toISOString(), result: 'stopped', newDeals: 0, searches: 2, message: 'You stopped the scan. Prices found so far are kept.' } };
      sync();
    },
    async pause() {
      await online();
      stopTimer();
      state.agent = { ...state.agent, status: 'paused', step: null, progress: null };
      sync();
    },
    async resume() {
      await online();
      state.agent.status = 'idle';
      sync();
    },
    async lookUp(id) {
      await online(900);
      deals = deals.map((d) => (d.id === id ? { ...d, lookup: null } : d));
      state.budget.serpLeft -= 2;
      sync();
      emit({ type: 'deals' });
    },
    async verify() {
      await online(900);
      state.budget.serpLeft -= 1;
      sync();
    },

    async settings() {
      await online();
      return clone(settings);
    },
    async patchSettings(patch) {
      await online(150);
      settings = {
        ...settings,
        ...patch,
        fees: { ...settings.fees, ...patch.fees },
        ai: { ...settings.ai, ...patch.ai, pipelines: { ...settings.ai.pipelines, ...patch.ai?.pipelines } },
        alerts: { ...settings.alerts, ...patch.alerts },
      } as Settings;
      if (patch.searchesPerScan) state.budget.serpPerScan = patch.searchesPerScan;
      if (patch.reserve !== undefined) state.budget.serpReserve = patch.reserve;
      if (patch.ai?.monthlyCapUsd !== undefined) state.budget.aiCapUsd = patch.ai.monthlyCapUsd;
      sync();
      return clone(settings);
    },
    async putKey(name, value) {
      await online(400);
      if (name === 'serpapi' && value.trim().length < 20) throw new ApiError('refused', 'SerpApi did not accept this key.');
      state.keys[name] = true;
      sync();
    },
    async deleteKey(name) {
      await online();
      state.keys[name] = false;
      sync();
    },
    async approvePairing() {
      await online(600);
      state.helper = { paired: true, connected: true, lastSeenAt: new Date().toISOString(), jobsWaiting: 0 };
      sync();
    },
    async revokePairing() {
      await online();
      state.helper = { paired: false, connected: false, lastSeenAt: null, jobsWaiting: 0 };
      sync();
    },

    subscribe(onEvent, onDown) {
      if (mode === 'offline') {
        const t = setTimeout(onDown, 50);
        return () => clearTimeout(t);
      }
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },
  };
}
