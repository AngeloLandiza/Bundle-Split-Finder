// The agent's HTTP surface (step 13): checks, routes, store, worker jobs, events and the agent's work (work.ts),
// wired together. server.ts only listens. Tests build one on a temp data dir.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  KEY_NAMES,
  NOTIFY_KINDS,
  WORKER_JOB_KINDS,
  WORKER_LONG_POLL_MS,
  type AgentEventName,
  type AiPipelineSetting,
  type AnswerResponse,
  type BogoResponse,
  type ConfirmPriceResponse,
  type NeedsLookResponse,
  type FactResponse,
  type PriceFromLinkResponse,
  type KeyName,
  type CheckKeyResponse,
  type PutKeyResponse,
  type NotifyEvent,
  type PaidResponse,
  type WatchResponse,
  type PairClaimResponse,
  type PartOutcomeBody,
  type PauseResponse,
  type AskResponse,
  type QueuedResponse,
  type ReviewAnswer,
  type UndoAnswerResponse,
  type WorkerJobInputs,
  type LookupsRunResponse,
  type ReadPagesResponse,
  type HelperReloadResponse,
  type WorkerJobKind,
  type WorkerNextResponse,
  type WorkerResultBody,
} from '../core/src/api/contract';
import { dealListSections } from '../core/src/deals/sections';
import { AnswerRefused } from '../core/src/scan/answers';
import { planConfirmedPrice, planRemoveConfirmedPrice } from '../core/src/scan/confirmed';
import { bundlesCsv } from '../core/src/scan/csv';
import { ebaySettingsProblem, validateSettings } from '../core/src/settings';
import { testTelegram } from './alerts';
import { Auth, type PairError } from './auth';
import { AUDIT_REFUSAL, backUpScanData, buildAuditText, clearScanData } from './dataPane';
import { measuredByDefault, modelIdentity } from './autopilot';
import { checkEbayKeysApp } from './checkEbayKeysApp';
import { checkSerpApiKey } from './checkSerpKey';
import { checkForOwner, checkStoredKey, forgetKeyCheck, recheckStaleKeys, type KeyCheckHost } from './keyChecks';
import { EventHub } from './events';
import { HANDLED, HttpError, readJsonBody, reply, Router, runHandler, sendError, type Ctx } from './http';
import { extensionInstallDir, extensionZipSource, installExtensionFromZip, setupStatus, shippedHelperVersion } from './setup';
import { COLLECTIONS, defaultAiSettings, Store, type StoreData, type StoredKeys } from './store';
import { tryServeUi, uiIndexExists } from './uiStatic';
import { activityResponse, agentState, dealDetail, dealsResponse, openReviewCount, parseSection, parseSort, reviewResponse, settingsResponse, watchlistResponse, watchStateOf, workingReviewCount } from './views';
import { setWatch } from '../core/src/tracking/state';
import { isBogoListingPath } from '../core/src/tracking/bogoPairs';
import { DEFAULT_LISTING_SOURCE, isBundleListingPath, LISTING_SOURCES } from '../core/src/scan/listingSource';
import { HOME_DEPOT_ITEM_ID } from '../core/src/scan/kitPage';
import { AgentWork, extensionSettingsOf, WorkRefused, type WorkDeps } from './work';
import { WorkerJobs } from './workerJobs';
import { priceFromLink } from './priceFromLink';
import { OutcomeBook, outcomesCsvOf, outcomesResponse } from './outcomes';
import { parseSemver } from '../core/src/release/note';
import { checkForNewVersion, dismissUpdate, releaseState, updateNoticeOf, type VersionCheck } from './versionCheck';

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
  work?: Pick<Partial<WorkDeps>, 'runScan' | 'readerTimeouts' | 'serpBaseUrl' | 'keepAwake' | 'hdSleep' | 'hdRandom'>;
  /**
   * POST /api/agent/quit: the desktop shell asks the agent to stop as SIGTERM does. Windows has no SIGTERM for a
   * windowless child, so the shell asks over HTTP there before it kills. Absent, the route answers unavailable.
   */
  onQuit?: () => void;
  /** Nov 23: how long a key check may take before it says "could not reach" (default 10 s); tests shorten it. */
  keyCheckTimeoutMs?: number;
  /** Nov 23: the helper build this app ships; default the bundled zip's manifest (setup.ts shippedHelperVersion). Tests set it. */
  shippedHelperVersion?: string | null;
  /** Nov 25: the running app's version; default the shell's SPLIT_FINDER_APP_VERSION. Null: nothing to compare, so no release check. */
  appVersion?: string | null;
  /** Nov 25: one line for a developer when the release note cannot be read; default console.warn. */
  releaseLog?: (line: string) => void;
}

/** Nov 23: a helper build as a heartbeat may name it ("0.1.0+3c92cc7"). */
const HELPER_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export interface Agent {
  handle(req: IncomingMessage, res: ServerResponse): void;
  store: Store;
  auth: Auth;
  jobs: WorkerJobs;
  events: EventHub;
  work: AgentWork;
  notify(n: Omit<NotifyEvent, 'id'>): NotifyEvent;
  /** Nov 25: look at the release note now (tests; the timers do it at start and daily). */
  checkVersion(o?: { force?: boolean }): Promise<VersionCheck>;
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

/**
 * A Home Depot item id as the helper takes it (extension/lib/agentJobs.ts): digits, at most 12. Security review, Nov 23:
 * checked here too, so a job the helper would refuse is refused at the door and never sits in the queue.
 */
function itemIdOf(v: unknown): string {
  const id = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : v;
  if (typeof id !== 'string' || id.length > 12 || !HOME_DEPOT_ITEM_ID.test(id)) throw new HttpError('bad_request', 'An item id is the digits of a Home Depot item id.');
  return id;
}

function itemIdsOf(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || v.length > 50) throw new HttpError('bad_request', 'itemIds must list 1 to 50 item ids.');
  return v.map(itemIdOf);
}

function parseJobInput(kind: WorkerJobKind, v: unknown): WorkerJobInputs[WorkerJobKind] {
  const o = obj(v, 'input');
  switch (kind) {
    case 'page':
      return { itemIds: itemIdsOf(o.itemIds) };
    case 'kitPage':
      return { itemId: itemIdOf(o.itemId), model: text(o.model, 'model', 64) };
    case 'partPrice':
      return { itemId: itemIdOf(o.itemId), model: text(o.model, 'model', 64), ...(typeof o.brand === 'string' ? { brand: text(o.brand, 'brand', 32) } : {}) };
    case 'search':
      // The helper reads the first page of a search only.
      if (o.page !== undefined && o.page !== 1) throw new HttpError('bad_request', 'Only the first page of a Home Depot search is read.');
      return { query: text(o.query, 'query', 200), page: 1 };
    case 'researchPage':
      return { itemId: itemIdOf(o.itemId) };
    case 'bogoListing':
      if (!isBogoListingPath(o.path)) throw new HttpError('bad_request', 'path must be a Featured BOGO listing path.');
      return { path: o.path };
    case 'bundleListing':
      // Security review M2: only the Bundle listing addresses the scan builds (filter tokens, a query, an offset).
      if (!isBundleListingPath(o.path)) throw new HttpError('bad_request', 'path must be a Home Depot Bundle listing path.');
      return { path: o.path };
    case 'promoPage':
      return { itemIds: itemIdsOf(o.itemIds) };
    case 'reload':
      return {};
  }
}

const NUMERIC_SETTINGS = ['searchesPerScan', 'reserve', 'keepaTokensPerScan', 'keepaReserve', 'pagesPerBrand', 'keepaDiscoveryShare'] as const;

function flag(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new HttpError('bad_request', `${field} must be true or false.`);
  return v;
}

const PIPELINES = ['judge', 'assist', 'research'] as const;

export function aiPipelinePatch(cur: AiPipelineSetting, v: unknown, name: (typeof PIPELINES)[number] | 'brief'): AiPipelineSetting {
  const o = obj(v, `ai.${name}`);
  const next: AiPipelineSetting = { ...cur };
  if ('provider' in o) {
    if (o.provider !== 'anthropic' && o.provider !== 'openai-compatible') throw new HttpError('bad_request', 'provider must be anthropic or openai-compatible.');
    next.provider = o.provider;
    next.apiKeyRef = o.provider === 'anthropic' ? 'anthropic' : 'openai';
  }
  if ('model' in o) next.model = text(o.model, `ai.${name}.model`, 100);
  if ('baseUrl' in o) next.baseUrl = o.baseUrl === null || o.baseUrl === '' ? undefined : text(o.baseUrl, `ai.${name}.baseUrl`, 300);
  if ('preset' in o) {
    if (o.preset !== 'deepseek' && o.preset !== 'generic') throw new HttpError('bad_request', 'preset must be deepseek or generic.');
    next.preset = o.preset;
  }
  if ('id' in o) next.id = text(o.id, `ai.${name}.id`, 40);
  if ('label' in o) next.label = text(o.label, `ai.${name}.label`, 60);
  // Autopilot rule 5: when anything that identifies the model changes (provider, model, address, preset, id), trust
  // goes back to the measured list (autopilot.ts) unless the same patch says `trusted` itself.
  if (modelIdentity(next) !== modelIdentity(cur)) next.trusted = name === 'brief' ? false : measuredByDefault(name, next);
  if ('trusted' in o) next.trusted = name === 'brief' ? false : flag(o.trusted, `ai.${name}.trusted`);
  if ('rates' in o) {
    const r = obj(o.rates, 'rates');
    const ok = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
    if (!ok(r.input) || !ok(r.output)) throw new HttpError('bad_request', 'rates need input and output dollars per million tokens.');
    next.rates = r as unknown as AiPipelineSetting['rates'];
  }
  return next;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new HttpError('bad_request', `${name} must be one of ${allowed.join(', ')}.`);
  return v as T;
}

function clock(v: unknown, name: string): string {
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new HttpError('bad_request', `${name} must be a time like 22:30.`);
  return v;
}

function applySettingsPatch(cur: StoreData['settings'], patch: Record<string, unknown>, at: string): StoreData['settings'] {
  const next = structuredClone(cur);
  if ('autopilot' in patch) next.autopilot = flag(patch.autopilot, 'autopilot');
  if ('scan' in patch) {
    // Free scan: where the bundle lists come from, and whether a scheduled scan may search for them with Chrome closed.
    const sc = obj(patch.scan, 'scan');
    const cur = next.scan ?? { listingSource: DEFAULT_LISTING_SOURCE, serpWhenChromeClosed: false };
    next.scan = {
      listingSource: 'listingSource' in sc ? oneOf(sc.listingSource, LISTING_SOURCES, 'scan.listingSource') : cur.listingSource,
      serpWhenChromeClosed: 'serpWhenChromeClosed' in sc ? flag(sc.serpWhenChromeClosed, 'scan.serpWhenChromeClosed') : cur.serpWhenChromeClosed,
    };
  }
  if ('lookups' in patch) {
    const l = obj(patch.lookups, 'lookups');
    if ('drip' in l) next.lookups = { ...(next.lookups ?? { drip: true }), drip: flag(l.drip, 'lookups.drip') };
    // The listing ladder, rung 2: the agent's own Confirm listing reads, and how many searches a day they may spend.
    if ('autoVerify' in l) next.lookups = { ...(next.lookups ?? { drip: true }), autoVerify: flag(l.autoVerify, 'lookups.autoVerify') };
    if ('verifySearchesPerDay' in l) {
      const v = l.verifySearchesPerDay;
      if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 250)) throw new HttpError('bad_request', 'lookups.verifySearchesPerDay must be a whole number from 0 to 250, or null for automatic.');
      next.lookups = { ...(next.lookups ?? { drip: true }), verifySearchesPerDay: v as number | null };
    }
  }
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
    if ('minMonthlySold' in a) {
      const n = a.minMonthlySold;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new HttpError('bad_request', 'alerts.minMonthlySold must be a whole number of 0 or more.');
      next.alerts.minMonthlySold = n;
    }
    if ('floorProfit' in a) {
      if (a.floorProfit === null) delete next.alerts.floorProfit;
      else if (typeof a.floorProfit !== 'number' || !Number.isFinite(a.floorProfit)) throw new HttpError('bad_request', 'alerts.floorProfit must be a number of dollars, or null for your profit threshold.');
      else next.alerts.floorProfit = a.floorProfit;
    }
    if ('marginDownDigest' in a) next.alerts.marginDownDigest = flag(a.marginDownDigest, 'alerts.marginDownDigest');
  }
  if ('ai' in patch) {
    const a = obj(patch.ai, 'ai');
    for (const p of PIPELINES) if (p in a) next.ai[p] = aiPipelinePatch(next.ai[p], a[p], p);
    // Step 16: the brief's model is chosen like the others and is never trusted (it explains a suggestion, it cannot change one).
    if ('brief' in a) next.ai.brief = aiPipelinePatch({ ...defaultAiSettings().brief!, ...(next.ai.brief ?? {}) }, a.brief, 'brief');
    if ('monthlyCapUsd' in a) {
      if (typeof a.monthlyCapUsd !== 'number' || !Number.isFinite(a.monthlyCapUsd) || a.monthlyCapUsd < 0) throw new HttpError('bad_request', 'ai.monthlyCapUsd must be a number of 0 or more.');
      next.ai.monthlyCapUsd = a.monthlyCapUsd;
    }
    if ('reaskOnNewEvidence' in a) next.ai.reaskOnNewEvidence = flag(a.reaskOnNewEvidence, 'ai.reaskOnNewEvidence');
  }
  if ('appearance' in patch) {
    const a = obj(patch.appearance, 'appearance');
    if ('theme' in a) next.appearance.theme = oneOf(a.theme, ['system', 'light', 'dark'], 'appearance.theme');
    if ('accent' in a) next.appearance.accent = oneOf(a.accent, ['system', 'blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'graphite'], 'appearance.accent');
    if ('density' in a) next.appearance.density = oneOf(a.density, ['regular', 'compact'], 'appearance.density');
  }
  if ('notifications' in patch) {
    const n = obj(patch.notifications, 'notifications');
    const out = next.notifications;
    if ('kinds' in n) {
      const k = obj(n.kinds, 'notifications.kinds');
      for (const kind of NOTIFY_KINDS) if (kind in k) out.kinds[kind] = flag(k[kind], `notifications.kinds.${kind}`);
    }
    if ('sound' in n) out.sound = flag(n.sound, 'notifications.sound');
    if ('quietHours' in n) {
      const q = obj(n.quietHours, 'notifications.quietHours');
      if ('enabled' in q) out.quietHours.enabled = flag(q.enabled, 'notifications.quietHours.enabled');
      if ('from' in q) out.quietHours.from = clock(q.from, 'notifications.quietHours.from');
      if ('to' in q) out.quietHours.to = clock(q.to, 'notifications.quietHours.to');
    }
    if ('digest' in n) out.digest = oneOf(n.digest, ['each-run', 'morning', 'off'], 'notifications.digest');
    if ('morningAt' in n) out.morningAt = clock(n.morningAt, 'notifications.morningAt');
  }
  if ('updates' in patch) {
    const u = obj(patch.updates, 'updates');
    if ('tellMeAboutNewVersion' in u) next.updates = { ...(next.updates ?? { tellMeAboutNewVersion: true }), tellMeAboutNewVersion: flag(u.tellMeAboutNewVersion, 'updates.tellMeAboutNewVersion') };
  }
  if ('shell' in patch) {
    const sh = obj(patch.shell, 'shell');
    for (const f of ['menuBarIcon', 'dockIcon', 'launchAtLogin', 'keepAwakeDuringScan'] as const) if (f in sh) next.shell[f] = flag(sh[f], `shell.${f}`);
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

function sendJsonFile(res: ServerResponse, file: string, text: string): typeof HANDLED {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
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
  jobs.abandonUnfinished('The agent restarted before this read was answered.');
  const events = new EventHub();
  const timers = opts.timers !== false;

  // Nov 23: which helper build is connected, and whether it is the one this app ships. `reportedBy`: the build that answered
  // a job with "does not know that kind of job" (undefined: none did). A reload is queued once per outdated build.
  const shipped = opts.shippedHelperVersion !== undefined ? opts.shippedHelperVersion : shippedHelperVersion();
  const helper: { version: string | null; reportedBy: string | null | undefined; reloadsFor: Set<string> } = { version: null, reportedBy: undefined, reloadsFor: new Set() };
  const helperOutdated = (): boolean =>
    (helper.version !== null && shipped !== null && helper.version !== shipped) || (helper.reportedBy !== undefined && helper.reportedBy === helper.version);
  const queueReload = (): boolean => {
    if (jobs.hasWaiting('reload')) return false;
    jobs.enqueue('reload', {});
    return true;
  };
  const reloadIfOutdated = (): void => {
    if (!helperOutdated()) return;
    const key = helper.version ?? '';
    if (helper.reloadsFor.has(key)) return;
    helper.reloadsFor.add(key);
    queueReload();
  };
  /** Nov 23: the helper's build, from a heartbeat's `version` or a poll's `v`. A new one clears what the old one reported, and may be outdated itself. */
  const noteHelperVersion = (version: unknown): void => {
    if (typeof version === 'string' && HELPER_VERSION.test(version) && version !== helper.version) {
      helper.version = version;
      reloadIfOutdated();
      mark('state');
    } else if (version === undefined && helper.version === null && shipped !== null) {
      // A helper built before Nov 23 sends no build at all: it is older than the app, so the app says so instead of
      // waiting for a job it cannot run.
      helper.version = 'unversioned';
      reloadIfOutdated();
      mark('state');
    }
  };
  jobs.onOutdated = () => {
    helper.reportedBy = helper.version;
    reloadIfOutdated();
    mark('state');
  };

  const helperLive = () => {
    const seen = auth.lastSeen();
    return {
      connected: jobs.pollers() > 0 || (seen !== null && now() - seen < HELPER_CONNECTED_MS),
      lastSeenAt: seen === null ? null : new Date(seen).toISOString(),
      helperVersion: helper.version,
      helperOutdated: helperOutdated(),
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
    // Home Depot's pace waits on real timers; with the timers off (tests) its gaps are counted on the injected clock and not waited.
    ...(timers ? {} : { hdSleep: async () => {} }),
    changed: () => mark('state'), ...(opts.work ?? {}),
  });

  // Nov 23: questions opened for bundles whose page was never read are withdrawn once at start (the next scan would too).
  // Signals round 2: then the deals rebuilt and their buy signals judged, with what is stored now (no network).
  void work.withdrawWaitingQuestions().then(() => work.signalsAtStart()).catch(() => 0);

  // Nov 25, new versions: the running app's version is the shell's (Cargo's package version, handed over at launch), not the
  // helper's build id. Not an x.y.z: nothing to compare, and the release note is never requested.
  const rawVersion = opts.appVersion !== undefined ? opts.appVersion : (process.env.SPLIT_FINDER_APP_VERSION ?? null);
  const appVersion = parseSemver(rawVersion) ? rawVersion : null;
  const checkVersion = (o: { force?: boolean } = {}): Promise<VersionCheck> =>
    checkForNewVersion(
      { store, fetchFn: opts.fetchFn ?? fetch, now, appVersion, announce: (text) => work.announceVersion(text), changed: () => mark('state', 'activity'), ...(opts.releaseLog ? { log: opts.releaseLog } : {}) },
      o,
    );
  // Once shortly after start, then the hourly tick looks only when a day has passed since the last look.
  const releaseStart = timers ? setTimeout(() => void checkVersion({ force: true }).catch(() => undefined), 30_000) : null;
  const releaseTimer = timers ? setInterval(() => void checkVersion().catch(() => undefined), 3_600_000) : null;
  releaseStart?.unref?.();
  releaseTimer?.unref?.();

  const state = () => {
    const data = Object.fromEntries(COLLECTIONS.map((n) => [n, store.get(n)])) as unknown as StoreData;
    const live = work.state();
    const update = updateNoticeOf(store, appVersion);
    return {
      ...agentState(data, {
        ...helperLive(), jobsWaiting: jobs.waitingCount(), now: now(), busy: live.busy, stopping: live.stopping, pipeline: live.pipeline, nextScanAt: work.nextScanAt(),
        ...(live.drip ? { drip: live.drip } : {}), serpLeft: work.serpLeft(),
      }),
      ...(update ? { update } : {}),
    };
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
        const working = workingReviewCount(r, store.get('suggestions'));
        events.publish('review', { at: r.at, open, counts: { review: open - working, ...(working > 0 ? { reviewWorking: working } : {}) } });
      } else if (name === 'activity') events.publish('activity', { at: iso() });
    }
    if (names.length) events.publish('state', state());
  }
  store.onChange((name) => {
    if (name === 'deals' || name === 'tracking') mark('deals', 'state');
    else if (name === 'review' || name === 'suggestions') mark('review', 'state');
    else if (name === 'activity' || name === 'autopilot' || name === 'answers') mark('activity', 'state');
    // Outcomes: a purchase marks its deal Bought, and each change is a sentence in Activity.
    else if (name === 'outcomes') mark('deals', 'activity', 'state');
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
  const keyHost: KeyCheckHost = { store, fetchFn: opts.fetchFn ?? fetch, now, ...(opts.work?.serpBaseUrl ? { serpBaseUrl: opts.work.serpBaseUrl } : {}), ...(opts.keyCheckTimeoutMs ? { timeoutMs: opts.keyCheckTimeoutMs } : {}) };
  // Nov 23: stored keys with no verdict in the last 24 hours are checked quietly (free requests only), at start and every hour after.
  const quietKeyChecks = () => void recheckStaleKeys(keyHost).catch(() => []);
  const quietStart = timers ? setTimeout(quietKeyChecks, 4_000) : null;
  const quietTimer = timers ? setInterval(quietKeyChecks, 3_600_000) : null;
  quietStart?.unref?.();
  quietTimer?.unref?.();
  if (timers) {
    jobs.start();
    work.start();
  }

  // Open requests of each paired extension (its event stream, its long poll), so revoking its token ends them at once.
  const openByExtension = new Map<string, Set<{ res: ServerResponse; ctl: AbortController }>>();
  const endConnections = (extensionId: string, except?: ServerResponse) => {
    for (const c of openByExtension.get(extensionId) ?? []) {
      if (c.res === except) continue;
      c.ctl.abort();
      c.res.destroy();
    }
  };
  /** Revokes an extension's token and ends whatever it has open. */
  const revoke = (extensionId: string, except?: ServerResponse): boolean => {
    const ok = auth.revoke(extensionId);
    if (ok) endConnections(extensionId, except);
    return ok;
  };

  const r = new Router();

  // ------------------------------------------------------------ state and control
  // The shell's challenge (src-tauri/src/agent.rs): no token asked, and only the proof comes back.
  r.get('/api/hello', 'none', (ctx) => {
    const proof = auth.helloProof(ctx.url.searchParams.get('nonce'));
    if (!proof) throw new HttpError('bad_request', 'nonce must be 32 to 128 letters, digits, - or _.');
    return { proof };
  });
  r.get('/api/state', 'any', () => state());
  r.post('/api/agent/pause', 'ui', (): PauseResponse => {
    store.update('agent', (a) => ({ ...a, paused: true, pausedAt: iso() }));
    return { paused: true };
  });
  r.post('/api/agent/resume', 'ui', (): PauseResponse => {
    // Resuming is the owner's acknowledgement of a problem the agent paused itself for.
    store.update('agent', () => ({ paused: false, pausedAt: null, problem: null }));
    return { paused: false };
  });
  r.post('/api/agent/quit', 'ui', () => {
    const quit = opts.onQuit;
    if (!quit) throw new HttpError('unavailable', 'This agent is not run by the desktop app.');
    // After the answer is out: the shell waits for the port to close.
    setTimeout(quit, 20).unref?.();
    return { ok: true };
  });
  r.get('/api/events', 'any', (ctx) => {
    events.attach(ctx.res, { name: 'state', data: state() });
    return HANDLED;
  });
  r.post('/api/notify/test', 'ui', () => notify({ kind: 'scan', title: 'Split Finder', body: 'Notifications from the agent work.' }));
  r.post('/api/notify/test-telegram', 'ui', () => testTelegram(opts.fetchFn ?? fetch, store.get('keys').telegram));
  // Nov 25: the owner closed the new-version notice; it stays closed for that version.
  r.post('/api/update/dismiss', 'ui', async (ctx) => {
    const b = obj(await ctx.body());
    if (typeof b.version !== 'string' || parseSemver(b.version) === null) throw new HttpError('bad_request', 'version must be like 0.1.1.');
    dismissUpdate(store, b.version);
    return { ok: true };
  });

  // ------------------------------------------------------------ settings and keys
  r.get('/api/settings', 'any', () => settingsResponse({ settings: store.get('settings'), keys: store.get('keys') }));
  r.patch('/api/settings', 'ui', async (ctx) => {
    const patch = obj(await ctx.body());
    const before = store.get('settings');
    const next = applySettingsPatch(before, patch, iso());
    store.update('settings', () => next);
    work.settingsChanged(before, next);
    return settingsResponse({ settings: next, keys: store.get('keys') });
  });
  const keyName = (ctx: Ctx): KeyName => {
    const n = ctx.params.name as KeyName;
    if (!KEY_NAMES.includes(n)) throw new HttpError('not_found', 'No such key.');
    return n;
  };
  // Step 15: a key replaced or removed has no problem any more until its service says otherwise.
  const clearKeyProblem = (name: KeyName) => {
    if (store.get('runtime').keyProblems?.[name] === undefined) return;
    store.update('runtime', (rt) => {
      const { [name]: _gone, ...rest } = rt.keyProblems ?? {};
      return { ...rt, keyProblems: rest };
    });
  };
  // Nov 23: a key is checked with its own service as it is saved (free requests only: agent/keyChecks.ts), and again on demand
  // from the stored value. What the service said is recorded for the UI (keyProblems, keyChecks).
  // Keys go in and never come out: a save answers whether it was kept and what the service said; a delete answers which keys are set.
  r.put('/api/keys/:name', 'ui', async (ctx): Promise<PutKeyResponse> => {
    const name = keyName(ctx);
    const value = parseKey(name, obj(await ctx.body()));
    store.update('keys', (k) => ({ ...k, ...value }));
    // The old value's problem and verdict were about another key.
    clearKeyProblem(name);
    forgetKeyCheck(store, name);
    const check = (await checkStoredKey(keyHost, name))!;
    return { saved: true, check: checkForOwner(check, 'save') };
  });
  r.post('/api/keys/:name/check', 'ui', async (ctx): Promise<CheckKeyResponse> => {
    const name = keyName(ctx);
    const check = await checkStoredKey(keyHost, name);
    if (!check) throw new HttpError('not_found', 'No such key is saved.');
    return { check: checkForOwner(check, 'recheck') };
  });
  r.delete('/api/keys/:name', 'ui', (ctx) => {
    const name = keyName(ctx);
    const keys = store.update('keys', (k) => {
      const next = { ...k };
      delete next[name];
      return next;
    });
    clearKeyProblem(name);
    forgetKeyCheck(store, name);
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
      { deals: store.get('deals'), review: store.get('review'), runtime: store.get('runtime'), settings: store.get('settings'), tracking: store.get('tracking') },
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
  // Settings, Data: what a developer needs to see what happened (never a key), and a reset of the scan data alone.
  r.get('/api/export/audit', 'ui', async (ctx) => {
    let text: string;
    try {
      text = await buildAuditText({
        store, scan: work.scanStore, now: now(), appVersion: process.env.SPLIT_FINDER_APP_VERSION ?? null, helperVersion: helper.version,
        platform: `${process.platform} ${process.arch}`,
      });
    } catch {
      throw new HttpError('unavailable', AUDIT_REFUSAL);
    }
    return sendJsonFile(ctx.res, `split-finder-audit-${csvFileDate(now())}.json`, text);
  });
  r.post('/api/data/reset', 'ui', async (ctx) => {
    if (obj(await ctx.body()).confirm !== 'RESET') throw new HttpError('bad_request', 'confirm must be "RESET".');
    if (work.writing()) throw new HttpError('conflict', 'A scan or a lookup is running. Stop it or wait for it to finish, then reset.');
    const backup = backUpScanData(opts.dataDir, store, now());
    await work.scanStore.clearAll();
    clearScanData(store);
    return { reset: true, backup };
  });
  r.get('/api/deals/:id', 'any', (ctx) => {
    const detail = dealDetail({ deals: store.get('deals'), review: store.get('review'), settings: store.get('settings'), tracking: store.get('tracking'), runtime: store.get('runtime') }, ctx.params.id!, Date.now());
    if (!detail) throw new HttpError('not_found', 'No such deal.');
    return detail;
  });
  // Tracking: the watchlist with each bundle's signals, Watch / Unwatch, and the owner's BOGO entry.
  r.get('/api/watchlist', 'any', () =>
    watchlistResponse({ deals: store.get('deals'), review: store.get('review'), settings: store.get('settings'), tracking: store.get('tracking') }),
  );
  r.post('/api/deals/:id/watch', 'ui', async (ctx): Promise<WatchResponse> => {
    const id = ctx.params.id!;
    const watched = flag(obj(await ctx.body()).watch, 'watch');
    if (!store.get('deals').bundles.some((b) => b.key === id)) throw new HttpError('not_found', 'No such deal.');
    const t = store.update('tracking', (cur) => ({ ...cur, ...setWatch(cur, id, watched, now()) }));
    return { id, watch: watchStateOf(t, id)! };
  });
  r.post('/api/deals/:id/bogo', 'ui', async (ctx) => {
    const body = obj(await ctx.body());
    return refusals(async (): Promise<BogoResponse> => ({ bogo: await work.saveBogo(ctx.params.id!, body) }));
  });
  r.delete('/api/deals/:id/bogo', 'ui', (ctx) => refusals(async (): Promise<BogoResponse> => ({ bogo: await work.saveBogo(ctx.params.id!, null) })));
  r.get('/api/deals/:id/export.csv', 'any', (ctx) => {
    const bundle = store.get('deals').bundles.find((b) => b.key === ctx.params.id);
    if (!bundle) throw new HttpError('not_found', 'No such deal.');
    return sendCsv(ctx.res, `split-finder-${bundle.model || `set-${bundle.itemId}`}.csv`, bundlesCsv([bundle]));
  });
  // Look up and Verify: the quote first (free), then the owner's click spends within the per-scan limit.
  r.get('/api/deals/:id/lookup', 'ui', (ctx) => refusals(async (): Promise<PaidResponse> => ({ searches: (await work.paidPlan(ctx.params.id!, 'lookUp')).searches })));
  r.post('/api/deals/:id/lookup', 'ui', (ctx) => refusals(async (): Promise<PaidResponse> => ({ searches: (await work.paid(ctx.params.id!, 'lookUp')).searchesUsed })));
  r.post('/api/deals/:id/verify', 'ui', async (ctx) => {
    const model = text(obj(await ctx.body()).model, 'model', 64);
    return refusals(async (): Promise<PaidResponse> => ({ searches: (await work.paid(ctx.params.id!, 'verify', model)).searchesUsed }));
  });

  // Checking the app's own work: his verdict on a "Needs a look" finding (core/src/audit/sanity.ts).
  r.post('/api/deals/:id/needs-look', 'ui', async (ctx) => {
    const b = obj(await ctx.body());
    const clearKey = text(b.clearKey, 'clearKey', 300);
    const verdict = b.verdict;
    if (verdict !== 'right' && verdict !== 'wrong') throw new HttpError('bad_request', 'verdict must be "right" or "wrong".');
    if (!store.get('deals').bundles.some((x) => x.key === ctx.params.id)) throw new HttpError('not_found', 'No such deal.');
    return refusals(async (): Promise<NeedsLookResponse> => {
      await work.settleNeedsLook(ctx.params.id!, clearKey, verdict);
      return { ok: true };
    });
  });

  // The owner's confirmed sell price for one part: chosen from a stored eBay listing or typed with a link (core/src/scan/confirmed.ts).
  const dealOf = (id: string) => {
    const bundle = store.get('deals').bundles.find((b) => b.key === id);
    if (!bundle) throw new HttpError('not_found', 'No such deal.');
    return bundle;
  };
  r.post('/api/deals/:id/parts/:part/price', 'ui', async (ctx) => {
    const bundle = dealOf(ctx.params.id!);
    const b = obj(await ctx.body());
    const plan = planConfirmedPrice(bundle, ctx.params.part!, b, now());
    if (!plan.ok) throw new HttpError(plan.code, plan.message);
    return refusals(async (): Promise<ConfirmPriceResponse> => {
      const rec = await work.confirmPrice(plan.record);
      return { confirmed: { price: rec.price, link: rec.link, note: rec.note ?? null, confirmedAt: new Date(rec.confirmedAt).toISOString() } };
    });
  });
  // A pasted link read for its price: eBay (Browse), Amazon (one Keepa token), Home Depot (his Chrome). The answer is shown to him; it counts only when he confirms it.
  r.post('/api/price-from-link', 'ui', async (ctx): Promise<PriceFromLinkResponse> => {
    const url = text(obj(await ctx.body()).url, 'url', 2048);
    return priceFromLink({ store, jobs, dataDir: opts.dataDir, now, fetchFn: opts.fetchFn ?? fetch, helperConnected: () => helperLive().connected, cache: work.cache, pace: work.pace }, url);
  });
  r.delete('/api/deals/:id/parts/:part/price', 'ui', (ctx) => {
    const plan = planRemoveConfirmedPrice(dealOf(ctx.params.id!), ctx.params.part!);
    if (!plan.ok) throw new HttpError(plan.code, plan.message);
    return refusals(async (): Promise<ConfirmPriceResponse> => {
      await work.removeConfirmedPrice(plan.key);
      return { confirmed: null };
    });
  });

  // Answer once (Nov 23): what he settled about a model, kept per brand and model (core/src/facts).
  r.post('/api/facts', 'ui', async (ctx) => {
    const b = obj(await ctx.body());
    const brand = text(b.brand, 'brand', 40).trim();
    const model = text(b.model, 'model', 40).trim();
    if (b.notSoldSeparately !== true) throw new HttpError('bad_request', 'notSoldSeparately must be true.');
    if (brand === '' || model === '' || model.startsWith('~')) throw new HttpError('bad_request', 'Name the brand and the model.');
    return refusals(async (): Promise<FactResponse> => {
      await work.markNotSold(brand, model);
      return { ok: true };
    });
  });
  r.delete('/api/facts/:key', 'ui', (ctx) => {
    const field = ctx.url.searchParams.get('field');
    if (field !== null && field !== 'isPart' && field !== 'sellAs' && field !== 'notSoldSeparately') throw new HttpError('bad_request', 'field must be isPart, sellAs or notSoldSeparately.');
    return refusals(async (): Promise<FactResponse> => ({ ok: true, reopened: await work.forgetFact(ctx.params.key!, field) }));
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
      const remember = b.remember === undefined ? [] : b.remember;
      if (!Array.isArray(remember) || remember.length > 8 || !remember.every((m) => typeof m === 'string' && m.trim() !== '' && m.length <= 40)) {
        throw new HttpError('bad_request', 'remember must be a list of up to 8 model numbers.');
      }
      const { entryId: answerId, remembered } = await work.answerRemembering(ctx.params.id!, answer, seen, b.fromSuggestion === true, remember as string[]);
      const r = remembered ? { remembered: { models: remembered.facts.map((f) => f.model), settled: remembered.settled, skipped: remembered.skipped } } : {};
      return answerId ? { applied: true, answerId, ...r } : { applied: true, ...r };
    });
  });
  // The owner takes back an answer he saved (`:id` is the answer entry's id, as in AnswerResponse.answerId).
  r.post('/api/review/:id/undo', 'ui', (ctx) => refusals(async (): Promise<UndoAnswerResponse> => ({ reopened: true, questionId: (await work.undoAnswer(ctx.params.id!)).questionId })));
  // Step 16: never a silent nothing (AskResponse): an ask, the follow-up loop, a fresh ask with { force: true }, or the reason.
  r.post('/api/review/:id/ask', 'ui', async (ctx) => {
    const b = obj(await ctx.body());
    if (b.force !== undefined && typeof b.force !== 'boolean') throw new HttpError('bad_request', 'force must be true or false.');
    if (!store.get('review').questions.some((q) => q.id === ctx.params.id && q.answer === null)) throw new HttpError('not_found', 'No open question with this id.');
    return refusals((): Promise<AskResponse> => work.askQuestion(ctx.params.id!, b.force === true));
  });

  // ------------------------------------------------------------ outcomes: what he bought and what became of it
  // His records, kept in the store's outcomes collection (agent/outcomes.ts). Every route is the app's own ('ui'): the
  // extension has no use for them. Writes are checked in core/src/outcomes; a refusal is a 400 with one sentence.
  const outcomes = new OutcomeBook(store, now);
  r.get('/api/outcomes', 'ui', () => outcomesResponse(store, now()));
  r.get('/api/outcomes/export.csv', 'ui', (ctx) => {
    if (!store.get('outcomes').purchases.length) throw new HttpError('not_found', 'No purchases recorded yet.');
    return sendCsv(ctx.res, `split-finder-outcomes-${csvFileDate(now())}.csv`, outcomesCsvOf(store));
  });
  r.post('/api/outcomes', 'ui', async (ctx) => {
    const b = obj(await ctx.body());
    return outcomes.record({ dealId: text(b.dealId, 'dealId'), boughtAt: b.boughtAt, pricePaid: b.pricePaid, quantity: b.quantity });
  });
  r.patch('/api/outcomes/:id', 'ui', async (ctx) => outcomes.patch(ctx.params.id!, obj(await ctx.body())));
  r.delete('/api/outcomes/:id', 'ui', (ctx) => outcomes.remove(ctx.params.id!));
  r.post('/api/outcomes/:id/parts/:part', 'ui', async (ctx) => {
    const b = obj(await ctx.body());
    if (b.status !== 'sold' && b.status !== 'holding' && b.status !== 'returned') throw new HttpError('bad_request', 'status must be sold, holding or returned.');
    return outcomes.setPart(ctx.params.id!, ctx.params.part!, b as unknown as PartOutcomeBody);
  });
  r.post('/api/outcomes/entries/:id/undo', 'ui', (ctx) => outcomes.undo(ctx.params.id!));

  // ------------------------------------------------------------ activity, autopilot, scan
  r.get('/api/activity', 'any', () =>
    activityResponse({ activity: store.get('activity'), autopilot: store.get('autopilot'), answers: store.get('answers'), suggestions: store.get('suggestions'), outcomes: store.get('outcomes'), versions: releaseState(store).history }, monthStart(now()), now()),
  );
  r.post('/api/activity/errors/:id/retry', 'ui', (ctx) => refusals(async () => {
    await work.retry(ctx.params.id!);
    return { ok: true };
  }));
  r.post('/api/autopilot/:id/undo', 'ui', (ctx) => refusals(() => work.undo(ctx.params.id!)));
  r.post('/api/scan', 'ui', () => refusals(() => work.scanNow()));
  r.post('/api/scan/stop', 'ui', () => ({ stopping: work.stop() }));
  // Nov 23: Read again, free (ReadPagesResponse): a refusal is an answer with its reason, not an error.
  r.post('/api/scan/read-pages', 'ui', (): ReadPagesResponse => work.readPagesAgain());
  // Step 15, Look up all (LookupsRunResponse): a refusal is an answer with its reason, not an error.
  r.post('/api/lookups/run', 'ui', async (ctx): Promise<LookupsRunResponse> => {
    const raw = await ctx.body();
    const b = raw === undefined || raw === null ? {} : obj(raw);
    if ('maxSearches' in b && (typeof b.maxSearches !== 'number' || !Number.isInteger(b.maxSearches) || b.maxSearches < 0)) {
      throw new HttpError('bad_request', 'maxSearches must be a whole number of 0 or more.');
    }
    if ('useReserve' in b && typeof b.useReserve !== 'boolean') throw new HttpError('bad_request', 'useReserve must be true or false.');
    return work.lookUpAll(typeof b.maxSearches === 'number' ? b.maxSearches : undefined, b.useReserve === true);
  });

  // ------------------------------------------------------------ pairing
  r.post('/api/pair/request', 'none', async (ctx) => pairResult(auth.requestPairing(obj(await ctx.body()).extensionId, ctx.origin)));
  r.post('/api/pair/claim', 'none', async (ctx) => {
    const b = obj(await ctx.body());
    const res = pairResult<PairClaimResponse>(auth.claim(b.requestId, b.claimSecret, ctx.origin));
    // Pairing again replaced the old token: what the old one had open ends.
    if (res.status === 'approved') endConnections(res.extensionId);
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
    if (!revoke(ctx.params.id!)) throw new HttpError('not_found', 'This extension is not paired.');
    return { ok: true };
  });
  // The app's Disconnect: one extension by id, or every paired one when none is named (the app pairs one helper).
  r.post('/api/pair/revoke', 'ui', async (ctx) => {
    const raw = await ctx.body().catch(() => ({}));
    const id = typeof (raw as { extensionId?: unknown })?.extensionId === 'string' ? (raw as { extensionId: string }).extensionId : null;
    const ids = id ? [id] : auth.pairedExtensions().map((e) => e.extensionId);
    const revoked = ids.filter((x) => revoke(x));
    if (id && !revoked.length) throw new HttpError('not_found', 'This extension is not paired.');
    mark('state');
    return { ok: true, revoked: revoked.length };
  });
  // The extension's own Disconnect: its token stops working.
  r.delete('/api/pair/self', 'extension', (ctx) => {
    const p = ctx.principal;
    if (p?.kind !== 'extension') throw new HttpError('forbidden', 'Only the paired extension can do this.');
    revoke(p.extensionId, ctx.res);
    mark('state');
    return { ok: true };
  });

  // ------------------------------------------------------------ worker
  r.get('/api/worker/next', 'extension', async (ctx) => {
    const wait = Number(ctx.url.searchParams.get('wait') ?? NaN);
    const ms = Number.isFinite(wait) ? Math.max(0, Math.min(wait * 1000, WORKER_LONG_POLL_MS)) : WORKER_LONG_POLL_MS;
    // Every poll names the helper's build, so a restarted app learns it at once, not at the next heartbeat.
    noteHelperVersion(ctx.url.searchParams.get('v') ?? undefined);
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
    const body: WorkerResultBody = b.ok === true
      ? { id, ok: true, result: b.result ?? null }
      : { id, ok: false, error: text(b.error, 'error', 2000), ...(b.outdated === true ? { outdated: true } : {}) };
    const status = jobs.complete(body);
    if (!status) throw new HttpError('not_found', 'No unfinished job with this id.');
    return { status };
  });
  r.post('/api/worker/heartbeat', 'extension', async (ctx) => {
    const b = (await ctx.body()) as { jobId?: unknown; version?: unknown } | null;
    const jobId = b?.jobId;
    if (typeof jobId === 'string' && jobId !== '' && jobId.length <= 64) jobs.extendLease(jobId);
    noteHelperVersion(b?.version);
    return { ok: true };
  });
  // Nov 23: the app's Reload helper button: one reload job, unless one is waiting already (HelperReloadResponse).
  r.post('/api/helper/reload', 'ui', (): HelperReloadResponse => {
    queueReload();
    mark('state');
    return { queued: true };
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
    if (principal?.kind === 'extension') {
      const id = principal.extensionId;
      const set = openByExtension.get(id) ?? new Set();
      const entry = { res, ctl };
      set.add(entry);
      openByExtension.set(id, set);
      res.on('close', () => {
        set.delete(entry);
        if (set.size === 0 && openByExtension.get(id) === set) openByExtension.delete(id);
      });
    }
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
    checkVersion,
    close() {
      if (releaseStart) clearTimeout(releaseStart);
      if (releaseTimer) clearInterval(releaseTimer);
      if (flushTimer) clearTimeout(flushTimer);
      if (connectionTimer) clearInterval(connectionTimer);
      if (quietStart) clearTimeout(quietStart);
      if (quietTimer) clearInterval(quietTimer);
      work.close();
      jobs.stop();
      events.close();
      store.close();
    },
  };
}
