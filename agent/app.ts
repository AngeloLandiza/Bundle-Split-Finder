// The agent's HTTP surface (step 13): checks, routes, store, worker jobs and events, wired together.
// server.ts only listens. Tests build one on a temp data dir.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  KEY_NAMES,
  WORKER_JOB_KINDS,
  WORKER_LONG_POLL_MS,
  type AgentEventName,
  type ApproveResponse,
  type KeyName,
  type NotifyEvent,
  type PairClaimResponse,
  type PauseResponse,
  type QueuedResponse,
  type ReviewAnswer,
  type ScanStartResponse,
  type WorkerJobInputs,
  type WorkerJobKind,
  type WorkerNextResponse,
  type WorkerResultBody,
} from '../core/src/api/contract';
import type { StoredSuggestion } from '../core/src/assist/stored';
import { dealListSections } from '../core/src/deals/sections';
import { bundlesCsv } from '../core/src/scan/csv';
import type { BundleRow, EbayQuestion, PaidAction, ReviewItem } from '../core/src/scan/types';
import { Auth, type PairError } from './auth';
import { checkEbayKeysApp } from './checkEbayKeysApp';
import { checkSerpApiKey } from './checkSerpKey';
import { EventHub } from './events';
import { HANDLED, HttpError, readJsonBody, reply, Router, runHandler, sendError, type Ctx } from './http';
import { extensionInstallDir, extensionZipSource, installExtensionFromZip, setupStatus } from './setup';
import { COLLECTIONS, Store, type AuditBundle, type HelperSnapshot, type StoreData, type StoredKeys } from './store';
import { tryServeUi, uiIndexExists } from './uiStatic';
import {
  activityResponse,
  agentState,
  answerFromSuggestion,
  dealDetail,
  dealsResponse,
  latestSuggestion,
  openReviewCount,
  parseSection,
  parseSort,
  reviewResponse,
  settingsResponse,
} from './views';
import { WorkerJobs } from './workerJobs';

/** A paired extension counts as connected this long after it was last heard from. */
export const HELPER_CONNECTED_MS = 90_000;

export interface AgentOptions {
  dataDir: string;
  port: number;
  extraUiOrigins?: string[];
  now?: () => number;
  /** Tests turn the background timers off. */
  timers?: boolean;
}

export interface Agent {
  handle(req: IncomingMessage, res: ServerResponse): void;
  store: Store;
  auth: Auth;
  jobs: WorkerJobs;
  events: EventHub;
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

function parseAnswer(v: unknown): ReviewAnswer {
  const a = obj(v, 'answer');
  if (typeof a.choice === 'number' && Number.isInteger(a.choice) && a.choice >= 0) return { choice: a.choice };
  if (a.none === true) return { none: true };
  if (Array.isArray(a.parts) && a.parts.length >= 1 && a.parts.length <= 8 && a.parts.every((p) => typeof p === 'string' && p.trim())) {
    return { parts: (a.parts as string[]).map((p) => p.trim()) };
  }
  if (a.ebay === 'yes' || a.ebay === 'no') return { ebay: a.ebay };
  throw new HttpError('bad_request', 'answer must be a choice, none, parts, or an eBay yes or no.');
}

function parsePaid(v: unknown): PaidAction {
  const a = obj(v, 'action');
  if (a.kind === 'verify') return { kind: 'verify', brand: text(a.brand, 'brand'), model: text(a.model, 'model'), asin: text(a.asin, 'asin') };
  if (a.kind === 'lookUp' && Array.isArray(a.parts)) {
    return { kind: 'lookUp', parts: a.parts.map((p) => { const o = obj(p, 'part'); return { brand: text(o.brand, 'brand'), model: text(o.model, 'model') }; }) };
  }
  throw new HttpError('bad_request', 'action must be a verify or a lookUp.');
}

function parseKey(name: KeyName, body: Record<string, unknown>): Partial<StoredKeys> {
  switch (name) {
    case 'ebay':
      return { ebay: { appId: text(body.appId, 'appId'), certId: text(body.certId, 'certId') } };
    case 'telegram':
      return { telegram: { botToken: text(body.botToken, 'botToken'), chatId: text(body.chatId, 'chatId') } };
    default:
      return { [name]: text(body.key, 'key') };
  }
}

function parseJobInput(kind: WorkerJobKind, v: unknown): WorkerJobInputs[WorkerJobKind] {
  const o = obj(v, 'input');
  switch (kind) {
    case 'page':
      if (!Array.isArray(o.itemIds) || !o.itemIds.length || o.itemIds.length > 50) throw new HttpError('bad_request', 'itemIds must list 1 to 50 item ids.');
      return { itemIds: o.itemIds.map((id) => text(String(id), 'itemId', 32)) };
    case 'kitPage':
    case 'partPrice':
      return { itemId: text(String(o.itemId ?? ''), 'itemId', 32), model: text(o.model, 'model', 64) };
    case 'search':
      return { query: text(o.query, 'query', 200), page: typeof o.page === 'number' && o.page >= 1 ? Math.floor(o.page) : 1 };
    case 'partPrices':
      if (!Array.isArray(o.parts) || !o.parts.length || o.parts.length > 40) throw new HttpError('bad_request', 'parts must list 1 to 40 parts.');
      return { parts: o.parts.map((p) => { const x = obj(p, 'part'); return { brand: text(x.brand, 'brand', 32), model: text(x.model, 'model', 64) }; }) };
    case 'researchPage':
      return { itemId: text(String(o.itemId ?? ''), 'itemId', 32) };
  }
}

const NUMERIC_SETTINGS = ['searchesPerScan', 'reserve', 'keepaTokensPerScan', 'keepaReserve', 'pagesPerBrand'] as const;
const FLAG_SETTINGS = ['appPrimaryUi', 'compactHelperPanel', 'askAfterScan', 'autopilot'] as const;

function applySettingsPatch(cur: StoreData['settings'], patch: Record<string, unknown>, at: string): StoreData['settings'] {
  const next = structuredClone(cur);
  for (const f of FLAG_SETTINGS) {
    if (!(f in patch)) continue;
    if (typeof patch[f] !== 'boolean') throw new HttpError('bad_request', `${f} must be true or false.`);
    next[f] = patch[f] as boolean;
  }
  if ('settings' in patch) {
    const s = obj(patch.settings, 'settings');
    for (const f of NUMERIC_SETTINGS) {
      if (!(f in s)) continue;
      if (typeof s[f] !== 'number' || !Number.isFinite(s[f]) || (s[f] as number) < 0) throw new HttpError('bad_request', `${f} must be a number of 0 or more.`);
      next.settings[f] = s[f] as number;
    }
    if ('agentBridgeAfterScan' in s) {
      if (typeof s.agentBridgeAfterScan !== 'boolean') throw new HttpError('bad_request', 'agentBridgeAfterScan must be true or false.');
      next.settings.agentBridgeAfterScan = s.agentBridgeAfterScan;
    }
    if ('brands' in s) {
      if (!Array.isArray(s.brands) || !s.brands.every((b) => typeof b === 'string' && b.trim())) throw new HttpError('bad_request', 'brands must be a list of names.');
      next.settings.brands = (s.brands as string[]).map((b) => b.trim());
    }
    if ('fees' in s) next.settings.fees = { ...next.settings.fees, ...obj(s.fees, 'fees') } as typeof next.settings.fees;
    if ('schedule' in s) next.settings.schedule = obj(s.schedule, 'schedule') as unknown as typeof next.settings.schedule;
  }
  if ('ebaySettings' in patch) next.ebaySettings = { ...next.ebaySettings, ...obj(patch.ebaySettings, 'ebaySettings') } as typeof next.ebaySettings;
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

/** The meters the pre-step-13 extension posts, kept field by field so nothing else is stored. */
function helperSnapshot(body: Record<string, unknown>, at: string): HelperSnapshot {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const job = body.lastJob && typeof body.lastJob === 'object' ? (body.lastJob as HelperSnapshot['lastJob']) : null;
  return {
    at,
    hasKey: body.hasKey === true,
    hasAnthropicKey: body.hasAnthropicKey === true,
    scanRunning: body.scanRunning === true,
    askAiAllRunning: body.askAiAllRunning === true,
    searchesLeft: num(body.searchesLeft),
    searchesPerMonth: num(body.searchesPerMonth),
    keepaTokensLeft: num(body.keepaTokensLeft),
    keepaRefillMin: num(body.keepaRefillMin),
    searchesPerScan: num(body.searchesPerScan) ?? 0,
    rateLimitPerHour: num(body.rateLimitPerHour),
    lastJob: job,
  };
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
  const state = () => {
    const data = Object.fromEntries(COLLECTIONS.map((n) => [n, store.get(n)])) as unknown as StoreData;
    return agentState(data, { ...helperLive(), jobsWaiting: jobs.waitingCount(), monthStart: monthStart(now()) });
  };

  // Store changes become events, gathered for a moment so a burst of writes is one event each.
  const dirty = new Set<AgentEventName>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
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
  };
  const mark = (...names: AgentEventName[]) => {
    for (const n of names) dirty.add(n);
    if (!flushTimer) flushTimer = setTimeout(flush, 50);
  };
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
  if (timers) jobs.start();

  const notify = (n: Omit<NotifyEvent, 'id'>): NotifyEvent => {
    const event: NotifyEvent = { id: `n-${randomBytes(6).toString('hex')}`, ...n };
    events.publish('notify', event);
    return event;
  };

  const pushOutbox = <K extends 'reviewAnswers' | 'paid' | 'ask'>(k: K, item: StoreData['outbox'][K][number]) =>
    store.update('outbox', (o) => ({ ...o, [k]: [...o[k], item] }));

  const openQuestion = (id: string): ReviewItem | EbayQuestion | null => {
    const r = store.get('review');
    return r.questions.find((q) => q.id === id && q.answer === null) ?? r.ebayQuestions.find((q) => q.id === id) ?? null;
  };

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
      { deals: store.get('deals'), review: store.get('review'), activity: store.get('activity') },
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
    const detail = dealDetail({ deals: store.get('deals'), review: store.get('review') }, ctx.params.id!);
    if (!detail) throw new HttpError('not_found', 'No such deal.');
    return detail;
  });
  r.get('/api/deals/:id/export.csv', 'any', (ctx) => {
    const bundle = store.get('deals').bundles.find((b) => b.key === ctx.params.id);
    if (!bundle) throw new HttpError('not_found', 'No such deal.');
    return sendCsv(ctx.res, `split-finder-${bundle.model}.csv`, bundlesCsv([bundle]));
  });

  // ------------------------------------------------------------ review
  r.get('/api/review', 'any', () => reviewResponse({ review: store.get('review'), suggestions: store.get('suggestions'), deals: store.get('deals') }));
  r.post('/api/review/ask-all', 'ui', (): QueuedResponse => {
    pushOutbox('ask', { job: { all: true }, queuedAt: iso() });
    return { queued: true };
  });
  r.post('/api/review/approve', 'ui', async (ctx): Promise<ApproveResponse> => {
    const ids = obj(await ctx.body()).ids;
    if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) throw new HttpError('bad_request', 'ids must be a list of question ids.');
    const suggestions = store.get('suggestions');
    const out: ApproveResponse = { approved: [], skipped: [] };
    for (const id of ids as string[]) {
      const q = store.get('review').questions.find((x) => x.id === id && x.answer === null);
      if (!q) {
        out.skipped.push({ id, reason: 'No open question with this id.' });
        continue;
      }
      const res = answerFromSuggestion(q, latestSuggestion(suggestions, id));
      if ('reason' in res) out.skipped.push({ id, reason: res.reason });
      else {
        pushOutbox('reviewAnswers', { id, answer: res.answer, aiSuggestion: true, queuedAt: iso() });
        out.approved.push(id);
      }
    }
    return out;
  });
  r.post('/api/review/:id/answer', 'any', async (ctx): Promise<QueuedResponse> => {
    const b = obj(await ctx.body());
    const answer = parseAnswer(b.answer);
    if (!openQuestion(ctx.params.id!)) throw new HttpError('not_found', 'No open question with this id.');
    pushOutbox('reviewAnswers', { id: ctx.params.id!, answer, aiSuggestion: b.fromSuggestion === true ? true : undefined, queuedAt: iso() });
    return { queued: true };
  });
  r.post('/api/review/:id/ask', 'ui', (ctx): QueuedResponse => {
    if (!openQuestion(ctx.params.id!)) throw new HttpError('not_found', 'No open question with this id.');
    pushOutbox('ask', { job: { questionId: ctx.params.id! }, queuedAt: iso() });
    return { queued: true };
  });

  // ------------------------------------------------------------ activity, autopilot, scan
  r.get('/api/activity', 'any', () =>
    activityResponse({ activity: store.get('activity'), autopilot: store.get('autopilot'), suggestions: store.get('suggestions') }, monthStart(now())),
  );
  r.post('/api/autopilot/:id/undo', 'ui', () => {
    throw new HttpError('unavailable', 'Autopilot arrives with the agent scans (step 13, Wave 2).');
  });
  const requestScan = (): ScanStartResponse => {
    const pending = { id: `scan-${now()}`, requestedAt: iso() };
    store.update('outbox', (o) => ({ ...o, scan: pending }));
    return pending;
  };
  r.post('/api/scan', 'ui', () => requestScan());
  r.post('/api/scan/stop', 'ui', () => {
    throw new HttpError('unavailable', 'Stopping a scan from the app arrives with the agent scans (step 13, Wave 2).');
  });

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
  r.post('/api/worker/heartbeat', 'extension', () => ({ ok: true }));
  r.post('/api/worker/jobs', 'ui', async (ctx) => {
    const b = obj(await ctx.body());
    const kind = b.kind as WorkerJobKind;
    if (!WORKER_JOB_KINDS.includes(kind)) throw new HttpError('bad_request', 'kind must be page, kitPage, partPrice or search.');
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

  // ------------------------------------------------------------ the pre-step-13 extension mailbox
  // Today's extension still scans and posts its results. These keep their old bodies, now behind a
  // paired token, until the extension becomes a worker (W5). Keys are never in any of them.
  r.post('/api/panel', 'any', async (ctx) => {
    const b = obj(await ctx.body());
    if (b.kind !== 'split-finder-panel' || !Array.isArray(b.bundles)) throw new HttpError('bad_request', 'Not a split-finder-panel export.');
    store.update('deals', (d) => ({ ...d, at: iso(), bundles: b.bundles as BundleRow[] }));
    return { ok: true };
  });
  r.post('/api/bridge', 'any', async (ctx) => {
    const b = obj(await ctx.body());
    const at = iso();
    const bundles = Array.isArray(b.bundles) ? b.bundles : [];
    store.update('activity', (a) => ({ ...a, bridge: { at, kind: typeof b.kind === 'string' ? b.kind : null, bundleCount: bundles.length } }));
    if (b.kind !== 'split-finder-audit') return { ok: true };
    const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
    store.update('deals', (d) => ({
      ...d,
      auditAt: at,
      auditBundles: bundles.filter(isObj).map((x) => ({
        key: String(x.key),
        brand: String(x.brand),
        model: String(x.model),
        title: String(x.title),
        section: String(x.section),
        itemId: typeof x.itemId === 'number' ? x.itemId : null,
      })) as AuditBundle[],
    }));
    store.update('review', () => ({
      at,
      questions: (Array.isArray(b.questions) ? b.questions : []).filter((q): q is ReviewItem => isObj(q) && typeof q.id === 'string'),
      ebayQuestions: (Array.isArray(b.ebayQuestions) ? b.ebayQuestions : []).filter((q): q is EbayQuestion => isObj(q) && typeof q.id === 'string'),
    }));
    if (Array.isArray(b.aiSuggestions)) {
      store.update('suggestions', () => (b.aiSuggestions as unknown[]).filter((s): s is StoredSuggestion => isObj(s) && typeof s.questionId === 'string'));
    }
    return { ok: true };
  });
  r.get('/api/bridge', 'any', () => {
    const bridge = store.get('activity').bridge;
    return bridge ? { ok: true, summary: bridge } : { ok: false, message: 'No extension export yet.' };
  });
  r.post('/api/state', 'any', async (ctx) => {
    const snap = helperSnapshot(obj(await ctx.body()), iso());
    store.update('activity', (a) => ({ ...a, helper: snap }));
    return { ok: true };
  });
  r.get('/api/helper/settings', 'any', () => {
    const { settings, keys } = settingsResponse({ settings: store.get('settings'), keys: store.get('keys') });
    return {
      ok: true,
      updatedAt: store.get('settings').updatedAt,
      appPrimaryUi: settings.appPrimaryUi,
      compactHelperPanel: settings.compactHelperPanel,
      askAfterScan: settings.askAfterScan,
      ebaySettings: settings.ebaySettings,
      settings: settings.settings,
      serpApiKeySet: keys.serpapi,
      keepaKeySet: keys.keepa,
      ebayKeysSet: keys.ebay,
      anthropicKeySet: keys.anthropic,
    };
  });
  r.post('/api/scan/start', 'any', () => ({ ok: true, pending: requestScan() }));
  r.get('/api/scan/pending', 'any', () => ({ ok: true, pending: store.get('outbox').scan }));
  r.post('/api/scan/ack', 'any', () => {
    store.update('outbox', (o) => ({ ...o, scan: null }));
    return { ok: true };
  });
  r.get('/api/review/queue', 'any', () => ({ ok: true, jobs: store.get('outbox').reviewAnswers }));
  r.post('/api/review/queue', 'any', async (ctx) => {
    const b = obj(await ctx.body());
    pushOutbox('reviewAnswers', { id: text(b.id, 'id'), answer: parseAnswer(b.answer), aiSuggestion: b.aiSuggestion === true ? true : undefined, queuedAt: iso() });
    return { ok: true };
  });
  r.post('/api/review/queue/ack', 'any', () => {
    store.update('outbox', (o) => ({ ...o, reviewAnswers: [] }));
    return { ok: true };
  });
  r.get('/api/paid/queue', 'any', () => ({ ok: true, jobs: store.get('outbox').paid }));
  r.post('/api/paid/queue', 'any', async (ctx) => {
    pushOutbox('paid', { action: parsePaid(obj(await ctx.body()).action), queuedAt: iso() });
    return { ok: true };
  });
  r.post('/api/paid/queue/ack', 'any', () => {
    store.update('outbox', (o) => ({ ...o, paid: [] }));
    return { ok: true };
  });
  r.get('/api/review/ask/queue', 'any', () => ({ ok: true, jobs: store.get('outbox').ask }));
  r.post('/api/review/ask/queue', 'any', async (ctx) => {
    const b = obj(await ctx.body());
    if (b.all === true) pushOutbox('ask', { job: { all: true }, queuedAt: iso() });
    else pushOutbox('ask', { job: { questionId: text(b.questionId, 'questionId') }, queuedAt: iso() });
    return { ok: true };
  });
  r.post('/api/review/ask/queue/ack', 'any', () => {
    store.update('outbox', (o) => ({ ...o, ask: [] }));
    return { ok: true };
  });
  // Home Depot page reads, now worker jobs of kind 'page'.
  r.post('/api/hd-read/request', 'any', async (ctx) => {
    const ids = obj(await ctx.body()).itemIds;
    const itemIds = Array.isArray(ids) ? [...new Set(ids.filter((id): id is number => Number.isInteger(id) && id > 0))] : [];
    if (!itemIds.length) throw new HttpError('bad_request', 'No valid Home Depot item ids.');
    const job = jobs.enqueue('page', { itemIds: itemIds.map(String) });
    return { ok: true, pending: { id: job.id, itemIds, requestedAt: job.createdAt } };
  });
  r.get('/api/hd-read/pending', 'any', () => {
    const job = jobs.take(['page']);
    const input = job?.input as WorkerJobInputs['page'] | undefined;
    return { ok: true, pending: job && input ? { id: job.id, itemIds: input.itemIds.map(Number), requestedAt: job.createdAt } : null };
  });
  r.post('/api/hd-read/result', 'any', async (ctx) => {
    const b = obj(await ctx.body());
    if (!jobs.complete({ id: text(b.id, 'id', 64), ok: true, result: b.outcomes ?? null })) throw new HttpError('not_found', 'No unfinished read with this id.');
    return { ok: true };
  });
  r.get('/api/hd-read/result', 'any', (ctx) => {
    const job = jobs.get(ctx.url.searchParams.get('id') ?? '');
    if (!job || job.status !== 'done') return { ok: false, message: 'No result yet.' };
    return { ok: true, id: job.id, at: job.finishedAt, outcomes: job.result };
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
    notify,
    close() {
      if (flushTimer) clearTimeout(flushTimer);
      if (connectionTimer) clearInterval(connectionTimer);
      jobs.stop();
      events.close();
      store.close();
    },
  };
}
