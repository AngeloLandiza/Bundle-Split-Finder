// The agent's one store (step 13, Decision 3). The agent process is its only writer: a lock file
// refuses a second one. Each collection is one JSON file under <dataDir>/store/, written whole to a
// temp file and renamed over the old one, so a crash leaves the old or the new file, never half of
// one. Keys and pairing are written owner-only (0600). On the first start the JSON files the agent
// kept before step 13 are read once into the store; after that they are never read again.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type {
  AppSettings,
  AutopilotEntry,
  LastScanSummary,
  PairedExtension,
  ReviewAnswer,
  RunRecord,
  WorkerJob,
} from '../core/src/api/contract';
import type { StoredSuggestion } from '../core/src/assist/stored';
import { DEFAULT_FEES } from '../core/src/money';
import { DEFAULT_EBAY_SETTINGS, DEFAULT_SETTINGS } from '../core/src/settings';
import type { BundleRow, EbayQuestion, PaidAction, ReportSection, ReviewItem, ScanJob } from '../core/src/scan/types';

// ---------------------------------------------------------------- collection types

/** Keys at rest (Decision 2: file 0600 now, the OS keychain later). Never sent out of the agent. */
export interface StoredKeys {
  serpapi?: string;
  keepa?: string;
  anthropic?: string;
  openai?: string;
  ebay?: { appId: string; certId: string };
  telegram?: { botToken: string; chatId: string };
}

/** A bundle as the extension's audit export lists it (POST /api/bridge). */
export interface AuditBundle {
  key: string;
  brand: string;
  model: string;
  title: string;
  section: ReportSection | string;
  itemId: number | null;
}

export interface DealsCollection {
  /** When the panel rows were stored. */
  at: string | null;
  /** The extension's panel rows (POST /api/panel), the richest record of each bundle. */
  bundles: BundleRow[];
  auditAt: string | null;
  auditBundles: AuditBundle[];
}

export interface ReviewCollection {
  at: string | null;
  questions: ReviewItem[];
  ebayQuestions: EbayQuestion[];
}

export type HelperLastJob = Pick<
  ScanJob,
  'status' | 'stopReason' | 'stopMessage' | 'searchesUsed' | 'finishedAt' | 'deferred' | 'ebayNotice'
>;

/** Meters the extension posts (POST /api/state, legacy). No keys. */
export interface HelperSnapshot {
  at: string;
  hasKey: boolean;
  hasAnthropicKey: boolean;
  scanRunning: boolean;
  askAiAllRunning: boolean;
  searchesLeft: number | null;
  searchesPerMonth: number | null;
  keepaTokensLeft: number | null;
  keepaRefillMin: number | null;
  searchesPerScan: number;
  rateLimitPerHour: number | null;
  lastJob: HelperLastJob | null;
}

export interface ActivityCollection {
  runs: RunRecord[];
  helper: HelperSnapshot | null;
  lastScan: LastScanSummary | null;
  bridge: { at: string; kind: string | null; bundleCount: number } | null;
}

export interface StoredPairedExtension extends PairedExtension {
  /** sha256 of the extension's token; the token itself is never stored. */
  tokenHash: string;
}

export interface StoredPairRequest {
  requestId: string;
  extensionId: string;
  code: string;
  claimSecretHash: string;
  requestedAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'denied';
}

export interface PairingCollection {
  extensions: StoredPairedExtension[];
  requests: StoredPairRequest[];
}

/** The mailbox today's (unpaired-era) extension polls; it goes when the extension becomes a worker (W5). */
export interface HelperOutbox {
  scan: { id: string; requestedAt: string } | null;
  reviewAnswers: { id: string; answer: ReviewAnswer; aiSuggestion?: boolean; queuedAt: string }[];
  paid: { action: PaidAction; queuedAt: string }[];
  ask: { job: { questionId: string } | { all: true }; queuedAt: string }[];
}

/** The agent's own switches. The scheduler (Wave 2) reads `paused`. */
export interface AgentControl {
  paused: boolean;
  pausedAt: string | null;
}

export interface StoreData {
  agent: AgentControl;
  settings: AppSettings & { updatedAt: string };
  keys: StoredKeys;
  deals: DealsCollection;
  review: ReviewCollection;
  suggestions: StoredSuggestion[];
  activity: ActivityCollection;
  autopilot: AutopilotEntry[];
  jobs: WorkerJob[];
  pairing: PairingCollection;
  outbox: HelperOutbox;
}

export type CollectionName = keyof StoreData;

export const COLLECTIONS: readonly CollectionName[] = [
  'agent',
  'settings',
  'keys',
  'deals',
  'review',
  'suggestions',
  'activity',
  'autopilot',
  'jobs',
  'pairing',
  'outbox',
];

const OWNER_ONLY: ReadonlySet<CollectionName> = new Set(['keys', 'pairing']);

export const STORE_VERSION = 1;

export function defaultSettings(): StoreData['settings'] {
  return {
    updatedAt: new Date(0).toISOString(),
    appPrimaryUi: true,
    compactHelperPanel: false,
    askAfterScan: false,
    autopilot: true,
    ebaySettings: { ...DEFAULT_EBAY_SETTINGS },
    settings: {
      schedule: DEFAULT_SETTINGS.schedule,
      searchesPerScan: DEFAULT_SETTINGS.searchesPerScan,
      reserve: DEFAULT_SETTINGS.reserve,
      agentBridgeAfterScan: true,
      keepaTokensPerScan: DEFAULT_SETTINGS.keepaTokensPerScan,
      keepaReserve: DEFAULT_SETTINGS.keepaReserve,
      fees: { ...DEFAULT_FEES },
      brands: [...DEFAULT_SETTINGS.brands],
      pagesPerBrand: DEFAULT_SETTINGS.pagesPerBrand,
    },
  };
}

function defaults(): StoreData {
  return {
    agent: { paused: false, pausedAt: null },
    settings: defaultSettings(),
    keys: {},
    deals: { at: null, bundles: [], auditAt: null, auditBundles: [] },
    review: { at: null, questions: [], ebayQuestions: [] },
    suggestions: [],
    activity: { runs: [], helper: null, lastScan: null, bridge: null },
    autopilot: [],
    jobs: [],
    pairing: { extensions: [], requests: [] },
    outbox: { scan: null, reviewAnswers: [], paid: [], ask: [] },
  };
}

/** Fills fields a newer agent added to a collection stored by an older one. */
function normalize<K extends CollectionName>(name: K, raw: unknown): StoreData[K] {
  const base = defaults()[name];
  if (Array.isArray(base)) return (Array.isArray(raw) ? raw : base) as StoreData[K];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;
  if (name === 'settings') {
    const s = raw as Partial<StoreData['settings']>;
    const d = base as StoreData['settings'];
    return {
      ...d,
      ...s,
      ebaySettings: { ...d.ebaySettings, ...(s.ebaySettings ?? {}) },
      settings: { ...d.settings, ...(s.settings ?? {}) },
    } as StoreData[K];
  }
  return { ...(base as object), ...(raw as object) } as StoreData[K];
}

// ---------------------------------------------------------------- files

/** Writes the whole file to a temp name beside it, then renames it over the old one. */
export function writeFileAtomic(path: string, text: string, mode = 0o644): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function takeLock(path: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && pidAlive(holder)) {
        throw new Error(`Another Split Finder agent (process ${holder}) is using this data folder.`);
      }
      unlinkSync(path);
    }
  }
  throw new Error('Could not lock the agent store.');
}

// ---------------------------------------------------------------- migration from the pre-step-13 files

type LegacyRecord = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Reads the files the agent kept before step 13 into a store. Returns the files it read. */
export function migrateLegacyFiles(dataDir: string, into: StoreData): string[] {
  const read: string[] = [];
  const legacy = (file: string): LegacyRecord | unknown[] | undefined => {
    const v = readJson(join(dataDir, file));
    if (v === undefined || v === null || typeof v !== 'object') return undefined;
    read.push(file);
    return v as LegacyRecord | unknown[];
  };

  const keys: StoredKeys = {};
  const takeKeys = (raw: LegacyRecord) => {
    const serp = str(raw.serpApiKey);
    const keepa = str(raw.keepaApiKey);
    const anthropic = str(raw.anthropicKey);
    const appId = str(raw.ebayAppId);
    const certId = str(raw.ebayCertId);
    if (serp) keys.serpapi = serp;
    if (keepa) keys.keepa = keepa;
    if (anthropic) keys.anthropic = anthropic;
    if (appId && certId) keys.ebay = { appId, certId };
  };

  const settings = legacy('app-settings.json');
  if (settings && !Array.isArray(settings) && settings.version === 1) {
    takeKeys(settings);
    const { serpApiKey: _s, keepaApiKey: _k, ebayAppId: _a, ebayCertId: _c, anthropicKey: _h, version: _v, ...rest } = settings;
    into.settings = normalize('settings', rest);
  }
  const secrets = legacy('app-secrets.json');
  if (secrets && !Array.isArray(secrets)) takeKeys(secrets);
  into.keys = keys;

  const helper = legacy('helper-state.json');
  if (helper && !Array.isArray(helper)) into.activity.helper = helper as unknown as HelperSnapshot;

  const panel = legacy('deals-panel.json');
  if (panel && !Array.isArray(panel) && Array.isArray(panel.bundles)) {
    into.deals.at = str(panel.at) ?? null;
    into.deals.bundles = panel.bundles as BundleRow[];
  }

  const snap = legacy('deals-snapshot.json');
  if (snap && !Array.isArray(snap)) {
    const at = str(snap.at) ?? null;
    if (Array.isArray(snap.bundles)) {
      into.deals.auditAt = at;
      into.deals.auditBundles = snap.bundles as AuditBundle[];
    }
    into.review = {
      at,
      questions: Array.isArray(snap.openQuestions) ? (snap.openQuestions as ReviewItem[]) : [],
      ebayQuestions: Array.isArray(snap.openEbayQuestions) ? (snap.openEbayQuestions as EbayQuestion[]) : [],
    };
    if (Array.isArray(snap.aiSuggestions)) into.suggestions = snap.aiSuggestions as StoredSuggestion[];
  }

  const bridge = legacy('agent-bridge.json');
  if (bridge && !Array.isArray(bridge)) {
    const body = (bridge.body ?? {}) as LegacyRecord;
    into.activity.bridge = {
      at: str(bridge.at) ?? new Date(0).toISOString(),
      kind: typeof body.kind === 'string' ? body.kind : null,
      bundleCount: Array.isArray(body.bundles) ? body.bundles.length : 0,
    };
  }

  const last = legacy('agent-last-scan.json');
  if (last && !Array.isArray(last)) {
    const ended = (last.ended ?? {}) as LegacyRecord;
    const summary = (last.summary ?? {}) as LegacyRecord;
    into.activity.lastScan = {
      at: str(last.at) ?? new Date(0).toISOString(),
      status: typeof ended.status === 'string' ? ended.status : 'unknown',
      stopMessage: typeof ended.stopMessage === 'string' ? ended.stopMessage : null,
      searchesUsed: typeof summary.serpSearches === 'number' ? summary.serpSearches : 0,
      keepaTokensUsed: typeof summary.keepaTokens === 'number' ? summary.keepaTokens : 0,
      newDeals: typeof summary.confirmed === 'number' ? summary.confirmed : 0,
      reviewOpen: typeof summary.reviewOpen === 'number' ? summary.reviewOpen : 0,
    };
  }

  const scan = legacy('scan-pending.json');
  if (scan && !Array.isArray(scan) && str(scan.id)) {
    into.outbox.scan = { id: str(scan.id)!, requestedAt: str(scan.requestedAt) ?? new Date().toISOString() };
  }
  const reviewQueue = legacy('review-queue.json');
  if (Array.isArray(reviewQueue)) into.outbox.reviewAnswers = reviewQueue as HelperOutbox['reviewAnswers'];
  const paidQueue = legacy('paid-queue.json');
  if (Array.isArray(paidQueue)) into.outbox.paid = paidQueue as HelperOutbox['paid'];
  const askQueue = legacy('ask-queue.json');
  if (Array.isArray(askQueue)) into.outbox.ask = askQueue as HelperOutbox['ask'];

  const hd = legacy('hd-read-pending.json');
  if (hd && !Array.isArray(hd) && str(hd.id) && Array.isArray(hd.itemIds) && hd.itemIds.length) {
    into.jobs.push({
      id: str(hd.id)!,
      kind: 'page',
      input: { itemIds: hd.itemIds.map(String) },
      status: 'queued',
      attempts: 0,
      createdAt: str(hd.requestedAt) ?? new Date().toISOString(),
      leasedAt: null,
      leaseExpiresAt: null,
      finishedAt: null,
      result: null,
      error: null,
    });
  }
  return read;
}

// ---------------------------------------------------------------- the store

export type ChangeListener = (name: CollectionName) => void;

export class Store {
  private readonly listeners = new Set<ChangeListener>();
  private closed = false;

  private constructor(
    readonly dir: string,
    private readonly data: StoreData,
    private readonly lockPath: string | null,
  ) {}

  /**
   * Opens the store in `<dataDir>/store`, taking the single-writer lock (unless `lock: false`, for
   * read-only tools), and migrating the pre-step-13 files the first time.
   */
  static open(dataDir: string, opts: { lock?: boolean } = {}): Store {
    const dir = join(dataDir, 'store');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lockPath = opts.lock === false ? null : join(dir, 'store.lock');
    if (lockPath) takeLock(lockPath);

    const data = defaults();
    const metaPath = join(dir, 'meta.json');
    const fresh = !existsSync(metaPath);
    if (fresh) {
      const migratedFrom = migrateLegacyFiles(dataDir, data);
      const store = new Store(dir, data, lockPath);
      for (const name of COLLECTIONS) store.write(name);
      writeFileAtomic(
        metaPath,
        JSON.stringify({ version: STORE_VERSION, createdAt: new Date().toISOString(), migratedFrom }, null, 2),
      );
      return store;
    }
    for (const name of COLLECTIONS) {
      const raw = readJson(join(dir, `${name}.json`));
      if (raw !== undefined) (data as Record<CollectionName, unknown>)[name] = normalize(name, raw);
    }
    return new Store(dir, data, lockPath);
  }

  /** A copy of the collection; changing it changes nothing stored. */
  get<K extends CollectionName>(name: K): StoreData[K] {
    return structuredClone(this.data[name]);
  }

  /** Replaces the collection with what `fn` returns from a copy of it, writes it, and tells listeners. */
  update<K extends CollectionName>(name: K, fn: (current: StoreData[K]) => StoreData[K]): StoreData[K] {
    if (this.closed) throw new Error('The store is closed.');
    const next = fn(structuredClone(this.data[name]));
    this.data[name] = next;
    this.write(name);
    for (const listener of this.listeners) listener(name);
    return structuredClone(next);
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    if (this.lockPath && existsSync(this.lockPath)) {
      try {
        if (Number(readFileSync(this.lockPath, 'utf8').trim()) === process.pid) unlinkSync(this.lockPath);
      } catch {
        // the lock is gone already
      }
    }
  }

  private write(name: CollectionName): void {
    writeFileAtomic(join(this.dir, `${name}.json`), JSON.stringify(this.data[name], null, 2), OWNER_ONLY.has(name) ? 0o600 : 0o644);
  }
}
