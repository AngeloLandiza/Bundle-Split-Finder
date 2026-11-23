// The agent's HTTP surface (step 13): checks, routes, store, worker jobs, events and the agent's work (work.ts),
// wired together. server.ts only listens. Tests build one on a temp data dir.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  KEY_NAMES,
  WORKER_JOB_KINDS,
  WORKER_LONG_POLL_MS,
  type AgentEventName,
  type AiPipelineSetting,
  type AnswerResponse,
  type KeyName,
  type NotifyEvent,
  type PaidResponse,
  type PairClaimResponse,
  type PauseResponse,
  type QueuedResponse,
  type ReviewAnswer,
  type WorkerJobInputs,
  type WorkerJobKind,
  type WorkerNextResponse,
  type WorkerResultBody,
} from '../core/src/api/contract';
import { dealListSections } from '../core/src/deals/sections';
import { AnswerRefused } from '../core/src/scan/answers';
import { bundlesCsv } from '../core/src/scan/csv';
import { ebaySettingsProblem, validateSettings } from '../core/src/settings';
import { Auth, type PairError } from './auth';
import { checkEbayKeysApp } from './checkEbayKeysApp';
import { checkSerpApiKey } from './checkSerpKey';
import { EventHub } from './events';
import { HANDLED, HttpError, readJsonBody, reply, Router, runHandler, sendError, type Ctx } from './http';
import { extensionInstallDir, extensionZipSource, installExtensionFromZip, setupStatus } from './setup';
import { COLLECTIONS, Store, type StoreData, type StoredKeys } from './store';
import { tryServeUi, uiIndexExists } from './uiStatic';
import { activityResponse, agentState, dealDetail, dealsResponse, openReviewCount, parseSection, parseSort, reviewResponse, settingsResponse } from './views';
import { AgentWork, extensionSettingsOf, WorkRefused, type WorkDeps } from './work';
import { WorkerJobs } from './workerJobs';

/** A paired extension counts as connected this long after it was last heard from. */
export const HELPER_CONNECTED_MS = 90_000;

export interface AgentOptions {
  dataDir: string;
  port: number;
  extraUiOrigins?: string[];
  now?: () => number;
  /** Tests turn the background timers (and the scheduler) off. */
  timers?: boolean;
  /** Every paid call's fetch (SerpApi, Keepa, eBay, models, Telegram). Tests pass a fake; default the global fetch. */
  fetchFn?: typeof fetch;
  /** Tests: the scan itself, reader timeouts, SerpApi's address. */
  work?: Pick<Partial<WorkDeps>, 'runScan' | 'readerTimeouts' | 'serpBaseUrl'>;
}

export interface Agent {
  handle(req: IncomingMessage, res: ServerResponse): void;
  store: Store;
  auth: Auth;
  jobs: WorkerJobs;
  events: EventHub;
  work: AgentWork;
  notify(n: Omit<NotifyEvent, 'id'>): NotifyEvent;
  close(): void;
}

// ---------------------------------------------------------------- body checks

function obj(v: unknown, what = 'The body'): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError('bad_request', `${what} must be a JSON object.`);
  return v as Record<string, unknown>;
}

function text(v: unknown, field: string, max = 4096): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError('bad_request', `${field} is needed.`);
  if (v.length > max) throw new HttpError('bad_request', `${field} is too long.`);
  return v.trim();
}

type AgentAnswer = { choice: number } | { none: true } | { parts: string[] } | { ebay: 'yes' | 'no' };

function parseAnswer(v: unknown): AgentAnswer {
  const a = obj(v, 'answer') as ReviewAnswer & Record<string, unknown>;
  if (typeof a.choice === 'number' && Number.isInteger(a.choice) && a.choice >= 0) return { choice: a.choice };
  if (typeof a.choiceId === 'string' && /^choice:\d{1,3}$/.test(a.choiceId)) return { choice: Number(a.choiceId.slice(7)) };
  if (a.none === true) return { none: true };
  if (Array.isArray(a.parts) && a.parts.length >= 1 && a.parts.length <= 8 && a.parts.every((p) => typeof p === 'string' && p.trim())) {
    return { parts: (a.parts as string[]).map((p) => p.trim()) };
  }
  if (a.ebay === 'yes' || a.ebay === 'no') return { ebay: a.ebay };
  throw new HttpError('bad_request', 'answer must be a choice, none, parts, or an eBay yes or no.');
}

function parseKey(name: KeyName, body: Record<string, unknown>): Partial<StoredKeys> {
  switch (name) {
    case 'ebay':
      return { ebay: { appId: text(body.appId, 'appId'), certId: text(body.certId, 'certId') } };
    case 'telegram':
      return { telegram: { botToken: text(body.botToken, 'botToken'), chatId: text(body.chatId, 'chatId') } };
    default:
      // `value` is the desktop UI's name for it (W2); `key` the contract's.
      return { [name]: text(body.key ?? body.value, 'key') };
  }
}

function parseJobInput(kind: WorkerJobKind, v: unknown): WorkerJobInputs[WorkerJobKind] {
  const o = obj(v, 'input');
  switch (kind) {
    case 'page':
      if (!Array.isArray(o.itemIds) || !o.itemIds.length || o.itemIds.length > 50) throw new HttpError('bad_request', 'itemIds must list 1 to 50 item ids.');
      return { itemIds: o.itemIds.map((id) => text(String(id), 'itemId', 32)) };
    case 'kitPage':
      return { itemId: text(String(o.itemId ?? ''), 'itemId', 32), model: text(o.model, 'model', 64) };
    case 'partPrice':
      return { itemId: text(String(o.itemId ?? ''), 'itemId', 32), model: text(o.model, 'model', 64), ...(typeof o.brand === 'string' ? { brand: text(o.brand, 'brand', 32) } : {}) };
    case 'search':
      return { query: text(o.query, 'query', 200), page: typeof o.page === 'number' && o.page >= 1 ? Math.floor(o.page) : 1 };
    case 'researchPage':
      return { itemId: text(String(o.itemId ?? ''), 'itemId', 32) };
  }
}

const NUMERIC_SETTINGS = ['searchesPerScan', 'reserve', 'keepaTokensPerScan', 'keepaReserve', 'pagesPerBrand', 'keepaDiscoveryShare'] as const;
const PIPELINES = ['judge', 'assist', 'research'] as const;

function flag(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new HttpError('bad_request', `${field} must be true or false.`);
  return v;
}

function aiPipelinePatch(cur: AiPipelineSetting, v: unknown, name: string): AiPipelineSetting {
  const o = obj(v, `ai.${name}`);
  const next: AiPipelineSetting = { ...cur };
  if ('provider' in o) {
    if (o.provider !== 'anthropic' && o.provider !== 'openai-compatible') throw new HttpError('bad_request', 'provider must be anthropic or openai-compatible.');
    next.provider = o.provider;
    next.apiKeyRef = o.provider === 'anthropic' ? 'anthropic' : 'openai';
    // A model that has not been measured is not trusted until the owner says it is (Autopilot rule 5).
    if (!('trusted' in o)) next.trusted = o.provider === 'anthropic';
  }
  if ('model' in o) next.model = text(o.model, `ai.${name}.model`, 100);
  if ('baseUrl' in o) next.baseUrl = o.baseUrl === null || o.baseUrl === '' ? undefined : text(o.baseUrl, `ai.${name}.baseUrl`, 300);
  if ('preset' in o) {
    if (o.preset !== 'deepseek' && o.preset !== 'generic') throw new HttpError('bad_request', 'preset must be deepseek or generic.');
    next.preset = o.preset;
  }
  if ('id' in o) next.id = text(o.id, `ai.${name}.id`, 40);
  if ('label' in o) next.label = text(o.label, `ai.${name}.label`, 60);
  if ('trusted' in o) next.trusted = flag(o.trusted, `ai.${name}.trusted`);
  if ('rates' in o) {
    const r = obj(o.rates, 'rates');
    const ok = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
    if (!ok(r.input) || !ok(r.output)) throw new HttpError('bad_request', 'rates need input and output dollars per million tokens.');
    next.rates = r as unknown as AiPipelineSetting['rates'];
  }
  return next;
}

function applySettingsPatch(cur: StoreData['settings'], patch: Record<string, unknown>, at: string): StoreData['settings'] {
  const next = structuredClone(cur);
  if ('autopilot' in patch) next.autopilot = flag(patch.autopilot, 'autopilot');
  if ('settings' in patch) {
    const s = obj(patch.settings, 'settings');
    for (const f of NUMERIC_SETTINGS) {
      if (!(f in s)) continue;
      if (typeof s[f] !== 'number' || !Number.isFinite(s[f]) || (s[f] as number) < 0) throw new HttpError('bad_request', `${f} must be a number of 0 or more.`);
      next.settings[f] = s[f] as number;
    }
    if ('brands' in s) {
      if (!Array.isArray(s.brands) || !s.brands.every((b) => typeof b === 'string' && b.trim())) throw new HttpError('bad_request', 'brands must be a list of names.');
      next.settings.brands = (s.brands as string[]).map((b) => b.trim().toUpperCase());
    }
    if ('fees' in s) next.settings.fees = { ...next.settings.fees, ...obj(s.fees, 'fees') } as typeof next.settings.fees;
    if ('schedule' in s) next.settings.schedule = obj(s.schedule, 'schedule') as unknown as typeof next.settings.schedule;
    if ('discoveryMode' in s) next.settings.discoveryMode = s.discoveryMode as typeof next.settings.discoveryMode;
    if ('trackingDepth' in s) next.settings.trackingDepth = s.trackingDepth as typeof next.settings.trackingDepth;
    if ('amazonRefreshViaKeepa' in s) next.settings.amazonRefreshViaKeepa = flag(s.amazonRefreshViaKeepa, 'amazonRefreshViaKeepa');
  }
  if ('alerts' in patch) {
    const a = obj(patch.alerts, 'alerts');
    if ('enabled' in a) next.alerts.enabled = flag(a.enabled, 'alerts.enabled');
    if ('reviewDigest' in a) next.alerts.reviewDigest = flag(a.reviewDigest, 'alerts.reviewDigest');
    for (const f of ['minProfit', 'minRoiPercent'] as const) {
      if (!(f in a)) continue;
      if (typeof a[f] !== 'number' || !Number.isFinite(a[f]) || (a[f] as number) < 0) throw new HttpError('bad_request', `alerts.${f} must be a number of 0 or more.`);
      next.alerts[f] = a[f] as number;
    }
  }
  if ('ai' in patch) {
    const a = obj(patch.ai, 'ai');
    for (const p of PIPELINES) if (p in a) next.ai[p] = aiPipelinePatch(next.ai[p], a[p], p);
    if ('monthlyCapUsd' in a) {
      if (typeof a.monthlyCapUsd !== 'number' || !Number.isFinite(a.monthlyCapUsd) || a.monthlyCapUsd < 0) throw new HttpError('bad_request', 'ai.monthlyCapUsd must be a number of 0 or more.');
      next.ai.monthlyCapUsd = a.monthlyCapUsd;
    }
  }
  if ('ebaySettings' in patch) {
    next.ebaySettings = { ...next.ebaySettings, ...obj(patch.ebaySettings, 'ebaySettings') } as typeof next.ebaySettings;
    const problem = ebaySettingsProblem(next.ebaySettings);
    if (problem) throw new HttpError('bad_request', problem);
  }
  // The scan's own checks (core/src/settings.ts validateSettings): a value no scan could use is refused here.
  const problems = validateSettings(extensionSettingsOf(next));
  const first = Object.entries(problems)[0];
  if (first) throw new HttpError('bad_request', `${first[0]}: ${first[1]}`);
  next.updatedAt = at;
  return next;
}

function pairResult<T extends object>(r: T | PairError): T {
  if ('code' in r && 'message' in r && !('claimSecret' in r)) throw new HttpError((r as PairError).code, (r as PairError).message);
  return r as T;
}

function monthStart(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function csvFileDate(now: number): string {
  const d = new Date(now);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function sendCsv(res: ServerResponse, file: string, csv: string): typeof HANDLED {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.end(csv);
  return HANDLED;
}

/** The work's refusals as HTTP: a busy agent or a refused answer is 409, an unknown thing 404. */
async function refusals<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorkRefused) throw new HttpError('conflict', err.message);
    if (err instanceof AnswerRefused) throw new HttpError(/not found|No such/i.test(err.message) ? 'not_found' : 'conflict', err.message);
    throw err;
  }
}

// ---------------------------------------------------------------- the agent

export function createAgent(opts: AgentOptions): Agent {
  const now = opts.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const store = Store.open(opts.dataDir);
  const auth = new Auth(store, { dataDir: opts.dataDir, port: opts.port, extraUiOrigins: opts.extraUiOrigins, now });
  const jobs = new WorkerJobs(store, { now });
  const events = new EventHub();
  const timers = opts.timers !== false;

  const helperLive = () => {
    const seen = auth.lastSeen();
    return {
      connected: jobs.pollers() > 0 || (seen !== null && now() - seen < HELPER_CONNECTED_MS),
      lastSeenAt: seen === null ? null : new Date(seen).toISOString(),
    };
  };

  // Store changes become events, gathered for a moment so a burst of writes is one event each.
  const dirty = new Set<AgentEventName>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const mark = (...names: AgentEventName[]) => {
    for (const n of names) dirty.add(n);
    if (!flushTimer) flushTimer = setTimeout(flush, 50);
  };

  const notify = (n: Omit<NotifyEvent, 'id'>): NotifyEvent => {
    const event: NotifyEvent = { id: `n-${randomBytes(6).toString('hex')}`, ...n };
    events.publish('notify', event);
    return event;
  };

  const work = new AgentWork({
    store, jobs, dataDir: opts.dataDir, now, fetchFn: opts.fetchFn ?? fetch, helperConnected: () => helperLive().connected, notify,
    changed: () => mark('state'), ...(opts.work ?? {}),
  });

  const state = () => {
    const data = Object.fromEntries(COLLECTIONS.map((n) => [n, store.get(n)])) as unknown as StoreData;
    const live = work.state();
    return agentState(data, {
      ...helperLive(), jobsWaiting: jobs.waitingCount(), now: now(), busy: live.busy, stopping: live.stopping, pipeline: live.pipeline, nextScanAt: work.nextScanAt(),
    });
  };

  function flush(): void {
    flushTimer = null;
    const names = [...dirty];
    dirty.clear();
    for (const name of names) {
      if (name === 'deals') {
        const d = store.get('deals');
        events.publish('deals', { at: d.at ?? d.auditAt, count: new Set([...d.bundles.map((b) => b.key), ...d.auditBundles.map((b) => b.key)]).size });
      } else if (name === 'review') {
        const r = store.get('review');
        const open = openReviewCount(r);
        events.publish('review', { at: r.at, open, counts: { review: open } });
      } else if (name === 'activity') events.publish('activity', { at: iso() });
    }
    if (names.length) events.publish('state', state());
  }
  store.onChange((name) => {
    if (name === 'deals') mark('deals', 'state');
    else if (name === 'review' || name === 'suggestions') mark('review', 'state');
    else if (name === 'activity' || name === 'autopilot') mark('activity', 'state');
    else if (name !== 'outbox') mark('state');
  });

  let lastConnected = helperLive().connected;
  const connectionTimer = timers
    ? setInterval(() => {
        const c = helperLive().connected;
        if (c !== lastConnected) {
          lastConnected = c;
          mark('state');
        }
      }, 15_000)
    : null;
  connectionTimer?.unref?.();
  if (timers) {
    jobs.start();
    work.start();
  }

  const r = new Router();

  // ------------------------------------------------------------ state and control
  r.get('/api/state', 'any', () => state());
  r.post('/api/agent/pause', 'ui', (): PauseResponse => {
    store.update('agent', () => ({ paused: true, pausedAt: iso() }));
    return { paused: true };
  });
  r.post('/api/agent/resume', 'ui', (): PauseResponse => {
    store.update('agent', () => ({ paused: false, pausedAt: null }));
    return { paused: false };
  });
  r.get('/api/events', 'any', (ctx) => {
    events.attach(ctx.res, { name: 'state', data: state() });
    return HANDLED;
  });
  r.post('/api/notify/test', 'ui', () => notify({ kind: 'scan', title: 'Split Finder', body: 'Notifications from the agent work.' }));

  // ------------------------------------------------------------ settings and keys
  r.get('/api/settings', 'any', () => settingsResponse({ settings: store.get('settings'), keys: store.get('keys') }));
  r.patch('/api/settings', 'ui', async (ctx) => {
    const patch = obj(await ctx.body());
    const next = applySettingsPatch(store.get('settings'), patch, iso());
    store.update('settings', () => next);
    return settingsResponse({ settings: next, keys: store.get('keys') });
  });
  const keyName = (ctx: Ctx): KeyName => {
    const n = ctx.params.name as KeyName;
    if (!KEY_NAMES.includes(n)) throw new HttpError('not_found', 'No such key.');
    return n;
  };
  // Keys go in and never come out: both answer with which keys are set.
  r.put('/api/keys/:name', 'ui', async (ctx) => {
    const name = keyName(ctx);
    const value = parseKey(name, obj(await ctx.body()));
    const keys = store.update('keys', (k) => ({ ...k, ...value }));
    return settingsResponse({ settings: store.get('settings'), keys }).keys;
  });
  r.delete('/api/keys/:name', 'ui', (ctx) => {
    const name = keyName(ctx);
    const keys = store.update('keys', (k) => {
      const next = { ...k };
      delete next[name];
      return next;
    });
    return settingsResponse({ settings: store.get('settings'), keys }).keys;
  });
  // Free account checks for a key typed in the app (the key is sent only to its own service).
  r.post('/api/settings/check-serp', 'ui', async (ctx) => {
    const res = await checkSerpApiKey(text(obj(await ctx.body()).serpApiKey, 'serpApiKey'));
    if (!res.ok) throw new HttpError('bad_request', res.message);
    return { ok: true, account: res.account };
  });
  r.post('/api/settings/check-ebay', 'ui', async (ctx) => {
    const b = obj(await ctx.body());
    const res = await checkEbayKeysApp(text(b.ebayAppId, 'ebayAppId'), text(b.ebayCertId, 'ebayCertId'));
    if (!res.ok) throw new HttpError('bad_request', res.message);
    return { ok: true };
  });

  // ------------------------------------------------------------ deals
  r.get('/api/deals', 'any', (ctx) =>
    dealsResponse(
      { deals: store.get('deals'), review: store.get('review'), runtime: store.get('runtime'), settings: store.get('settings') },
      { sort: parseSort(ctx.url.searchParams.get('sort')), section: parseSection(ctx.url.searchParams.get('section')) },
      now(),
    ),
  );
  r.get('/api/deals/export.csv', 'any', (ctx) => {
    const bundles = store.get('deals').bundles;
    if (!bundles.length) throw new HttpError('not_found', 'No deals to export yet.');
    const groups = dealListSections(bundles, parseSort(ctx.url.searchParams.get('sort')));
    return sendCsv(ctx.res, `split-finder-deals-${csvFileDate(now())}.csv`, bundlesCsv(groups.flatMap((g) => g.rows)));
  });
  r.get('/api/deals/:id', 'any', (ctx) => {
    const detail = dealDetail({ deals: store.get('deals'), review: store.get('review'), settings: store.get('settings') }, ctx.params.id!);
    if (!detail) throw new HttpError('not_found', 'No such deal.');
    return detail;
  });
  r.get('/api/deals/:id/export.csv', 'any', (ctx) => {
    const bundle = store.get('deals').bundles.find((b) => b.key === ctx.params.id);
    if (!bundle) throw new HttpError('not_found', 'No such deal.');
    return sendCsv(ctx.res, `split-finder-${bundle.model}.csv`, bundlesCsv([bundle]));
  });
  // Look up and Verify: the quote first (free), then the owner's click spends within the per-scan limit.
  r.get('/api/deals/:id/lookup', 'ui', (ctx) => refusals(async (): Promise<PaidResponse> => ({ searches: (await work.paidPlan(ctx.params.id!, 'lookUp')).searches })));
  r.post('/api/deals/:id/lookup', 'ui', (ctx) => refusals(async (): Promise<PaidResponse> => ({ searches: (await work.paid(ctx.params.id!, 'lookUp')).searchesUsed })));
  r.post('/api/deals/:id/verify', 'ui', async (ctx) => {
    const model = text(obj(await ctx.body()).model, 'model', 64);
    return refusals(async (): Promise<PaidResponse> => ({ searches: (await work.paid(ctx.params.id!, 'verify', model)).searchesUsed }));
  });

  // ------------------------------------------------------------ review (applied by the agent, core/src/scan/answers.ts)
  r.get('/api/review', 'any', () =>
    reviewResponse({ review: store.get('review'), suggestions: store.get('suggestions'), deals: store.get('deals'), settings: store.get('settings') }),
  );
  r.post('/api/review/ask-all', 'ui', () => refusals((): QueuedResponse => {
    work.askNow();
    return { queued: true };
  }));
  r.post('/api/review/approve', 'ui', async (ctx) => {
    const ids = obj(await ctx.body()).ids;
    if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) throw new HttpError('bad_request', 'ids must be a list of question ids.');
    return refusals(() => work.approve(ids as string[]));
  });
  r.post('/api/review/:id/answer', 'any', async (ctx) => {
    const b = obj(await ctx.body());
    const answer = parseAnswer(b.answer);
    const seen = typeof b.seen === 'string' ? b.seen : undefined;
    return refusals(async (): Promise<AnswerResponse> => {
      await work.answer(ctx.params.id!, answer, seen, b.fromSuggestion === true);
      return { applied: true };
    });
  });
  r.post('/api/review/:id/ask', 'ui', (ctx) => refusals(async (): Promise<QueuedResponse> => {
    if (!store.get('review').questions.some((q) => q.id === ctx.params.id && q.answer === null)) throw new HttpError('not_found', 'No open question with this id.');
    work.askNow([ctx.params.id!]);
    return { queued: true };
  }));

  // ------------------------------------------------------------ activity, autopilot, scan
  r.get('/api/activity', 'any', () =>
    activityResponse({ activity: store.get('activity'), autopilot: store.get('autopilot'), suggestions: store.get('suggestions') }, monthStart(now()), now()),
  );
  r.post('/api/activity/errors/:id/retry', 'ui', (ctx) => refusals(async () => {
    await work.retry(ctx.params.id!);
    return { ok: true };
  }));
  r.post('/api/autopilot/:id/undo', 'ui', (ctx) => refusals(() => work.undo(ctx.params.id!)));
  r.post('/api/scan', 'ui', () => refusals(() => work.scanNow()));
  r.post('/api/scan/stop', 'ui', () => ({ stopping: work.stop() }));

  // ------------------------------------------------------------ pairing
  r.post('/api/pair/request', 'none', async (ctx) => pairResult(auth.requestPairing(obj(await ctx.body()).extensionId, ctx.origin)));
  r.post('/api/pair/claim', 'none', async (ctx) => {
    const b = obj(await ctx.body());
    const res = pairResult<PairClaimResponse>(auth.claim(b.requestId, b.claimSecret, ctx.origin));
    if (res.status === 'approved') mark('state');
    return res;
  });
  r.get('/api/pair/requests', 'ui', () => auth.pendingRequests());
  const decide = (allow: boolean) => async (ctx: Ctx) => {
    if (!auth.decide(text(obj(await ctx.body()).requestId, 'requestId'), allow)) throw new HttpError('not_found', 'No pending pairing request with this id.');
    return { ok: true };
  };
  r.post('/api/pair/approve', 'ui', decide(true));
  r.post('/api/pair/deny', 'ui', decide(false));
  r.get('/api/pair/extensions', 'ui', () => auth.pairedExtensions());
  r.delete('/api/pair/extensions/:id', 'ui', (ctx) => {
    if (!auth.revoke(ctx.params.id!)) throw new HttpError('not_found', 'This extension is not paired.');
    return { ok: true };
  });
  // The app's Disconnect: one extension by id, or every paired one when none is named (the app pairs one helper).
  r.post('/api/pair/revoke', 'ui', async (ctx) => {
    const raw = await ctx.body().catch(() => ({}));
    const id = typeof (raw as { extensionId?: unknown })?.extensionId === 'string' ? (raw as { extensionId: string }).extensionId : null;
    const ids = id ? [id] : auth.pairedExtensions().map((e) => e.extensionId);
    const revoked = ids.filter((x) => auth.revoke(x));
    if (id && !revoked.length) throw new HttpError('not_found', 'This extension is not paired.');
    mark('state');
    return { ok: true, revoked: revoked.length };
  });
  // The extension's own Disconnect: its token stops working.
  r.delete('/api/pair/self', 'extension', (ctx) => {
    const p = ctx.principal;
    if (p?.kind !== 'extension') throw new HttpError('forbidden', 'Only the paired extension can do this.');
    auth.revoke(p.extensionId);
    mark('state');
    return { ok: true };
  });

  // ------------------------------------------------------------ worker
  r.get('/api/worker/next', 'extension', async (ctx) => {
    const wait = Number(ctx.url.searchParams.get('wait') ?? NaN);
    const ms = Number.isFinite(wait) ? Math.max(0, Math.min(wait * 1000, WORKER_LONG_POLL_MS)) : WORKER_LONG_POLL_MS;
    mark('state');
    const job = await jobs.next(ms, ctx.signal);
    mark('state');
    if (!job) return reply(204);
    const out: WorkerNextResponse = { job: { id: job.id, kind: job.kind, input: job.input, attempt: job.attempts } };
    return out;
  });
  r.post('/api/worker/result', 'extension', async (ctx) => {
    const b = obj(await ctx.body());
    const id = text(b.id, 'id', 64);
    const body: WorkerResultBody = b.ok === true ? { id, ok: true, result: b.result ?? null } : { id, ok: false, error: text(b.error, 'error', 2000) };
    const status = jobs.complete(body);
    if (!status) throw new HttpError('not_found', 'No unfinished job with this id.');
    return { status };
  });
  r.post('/api/worker/heartbeat', 'extension', async (ctx) => {
    const jobId = (await ctx.body()).jobId;
    if (typeof jobId === 'string' && jobId !== '' && jobId.length <= 64) jobs.extendLease(jobId);
    return { ok: true };
  });
  r.post('/api/worker/jobs', 'ui', async (ctx) => {
    const b = obj(await ctx.body());
    const kind = b.kind as WorkerJobKind;
    if (!WORKER_JOB_KINDS.includes(kind)) throw new HttpError('bad_request', `kind must be one of ${WORKER_JOB_KINDS.join(', ')}.`);
    return jobs.enqueue(kind, parseJobInput(kind, b.input));
  });
  r.get('/api/worker/jobs/:id', 'ui', (ctx) => {
    const job = jobs.get(ctx.params.id!);
    if (!job) throw new HttpError('not_found', 'No such job.');
    return job;
  });

  // ------------------------------------------------------------ setup (the app's first run)
  r.get('/api/setup/status', 'ui', () => ({ ok: true, ...setupStatus() }));
  r.post('/api/setup/install-extension', 'ui', () => {
    const zip = extensionZipSource();
    if (!zip) throw new HttpError('unavailable', 'The extension zip is not bundled with this app.');
    try {
      const dir = extensionInstallDir();
      installExtensionFromZip(zip, dir);
      return { ok: true, ...setupStatus(), extensionDir: dir };
    } catch (err) {
      throw new HttpError('bad_request', err instanceof Error ? err.message : 'Install failed.');
    }
  });

  // ------------------------------------------------------------ the request pipeline
  const PAIRING_PATHS = new Set(['/api/pair/request', '/api/pair/claim']);

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!auth.hostAllowed(req.headers.host)) {
      sendError(res, 'forbidden', 'This address is not the agent.');
      req.resume();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    } catch {
      sendError(res, 'bad_request', 'Bad address.');
      return;
    }
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 'method_not_allowed', 'Only GET here.');
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.statusCode = 302;
        res.setHeader('Location', '/ui/');
        res.end();
        return;
      }
      if (tryServeUi(url.pathname, res)) return;
      sendError(res, 'not_found', uiIndexExists() ? 'Not found.' : 'The app UI is not built.');
      return;
    }

    const pairing = PAIRING_PATHS.has(url.pathname);
    const cors = auth.corsOrigin(origin, { pairing });
    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', cors);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      const methods = r.methodsFor(url.pathname);
      if (!cors || !methods.length) {
        sendError(res, 'forbidden', 'Not allowed from this origin.');
        return;
      }
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.end();
      return;
    }

    const found = r.match(req.method ?? 'GET', url.pathname);
    if (found === null) {
      req.resume();
      sendError(res, 'not_found', 'No such endpoint.');
      return;
    }
    if (found === 'method') {
      req.resume();
      sendError(res, 'method_not_allowed', 'This endpoint does not take that method.');
      return;
    }
    const { route, params } = found;
    let principal = null;
    if (route.auth !== 'none') {
      principal = auth.authenticate(req.headers.authorization);
      if (!principal) {
        req.resume();
        sendError(res, 'unauthorized', 'A valid token is needed.');
        return;
      }
      if (!auth.originAllowed(origin, principal)) {
        req.resume();
        sendError(res, 'forbidden', 'Not allowed from this origin.');
        return;
      }
      if ((route.auth === 'ui' && principal.kind !== 'ui') || (route.auth === 'extension' && principal.kind !== 'extension')) {
        req.resume();
        sendError(res, 'forbidden', route.auth === 'ui' ? 'Only the app can do this.' : 'Only the paired extension can do this.');
        return;
      }
      if (principal.kind === 'extension') auth.touch(principal.extensionId);
    }
    const ctl = new AbortController();
    res.on('close', () => ctl.abort());
    let bodyRead: Promise<unknown> | null = null;
    const ctx: Ctx = {
      req,
      res,
      url,
      params,
      principal,
      origin,
      signal: ctl.signal,
      body: <T>() => {
        bodyRead ??= readJsonBody(req);
        return bodyRead as Promise<T>;
      },
    };
    void runHandler(route.handler, ctx);
  };

  return {
    handle,
    store,
    auth,
    jobs,
    events,
    work,
    notify,
    close() {
      if (flushTimer) clearTimeout(flushTimer);
      if (connectionTimer) clearInterval(connectionTimer);
      work.close();
      jobs.stop();
      events.close();
      store.close();
    },
  };
}
