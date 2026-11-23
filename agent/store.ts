// The agent's one store (step 13, Decision 3). The agent process is its only writer: a lock file
// refuses a second one. Each collection is one JSON file under <dataDir>/store/, written whole to a
// temp file and renamed over the old one, so a crash leaves the old or the new file, never half of
// one. Keys and pairing are written owner-only (0600). On the first start the JSON files the agent
// kept before step 13 are read once into the store; after that they are never read again.

import { DEFAULT_LISTING_SOURCE } from '../core/src/scan/listingSource';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type {
  AppSettings,
  KeyName,
  KeyCheckRecord,
  AutopilotEntry,
  EvidenceQuote,
  LastScanSummary,
  PairedExtension,
  Purchase,
  ReviewAnswer,
  RunRecord,
  WorkerJob,
} from '../core/src/api/contract';
import type { StoredSuggestion } from '../core/src/assist/stored';
import type { FollowUpState } from '../core/src/research/followUp';
import { DEFAULT_BRIEF_MODEL } from '../core/src/brief/pipeline';
import { DEFAULT_CLAUDE_JUDGE_MODEL } from '../core/src/judge/claude';
import { DEFAULT_FEES } from '../core/src/money';
import type { UnitRates } from '../core/src/scan/pipeline';
import { measuredByDefault } from './autopilot';
import type { Footprint } from './ownerAnswers';
import { DEFAULT_EBAY_SETTINGS, DEFAULT_SETTINGS } from '../core/src/settings';
import type { BundleRow, EbayQuestion, PaidAction, ReportSection, ReviewItem, ScanJob } from '../core/src/scan/types';
import type { BogoView } from '../core/src/tracking/bogo';
import type { BogoGroup } from '../core/src/tracking/bogoPairs';
import type { FbaEstimate } from '../core/src/tracking/fba';
import { emptyTracking, type TrackingState } from '../core/src/tracking/state';
import { ensureOwnerOnlyFinal, restrictToOwner, setAclReporter } from './winAcl';

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
  /** W4: searches a Look up of each bundle's unmatched parts would spend now (paid.ts lookupsNeeded), by bundle key. */
  lookups?: Record<string, number>;
}

export interface ReviewCollection {
  at: string | null;
  questions: ReviewItem[];
  ebayQuestions: EbayQuestion[];
  /** W4: the stored evidence of each open question (core/src/assist/evidence.ts), by question id. */
  evidence?: Record<string, EvidenceQuote[]>;
  /**
   * Step 16 (round 2): the follow-up loop's free reads for a split question the AI has not answered (no live suggestion), by
   * question id, with the question's reviewSignature when they were made (agent/followUp.ts). A question with a live suggestion
   * keeps its loop on the suggestion (StoredSuggestion.followUp).
   */
  followUps?: Record<string, { seen: string; state: FollowUpState }>;
}

export type HelperLastJob = Pick<
  ScanJob,
  'status' | 'stopReason' | 'stopMessage' | 'searchesUsed' | 'finishedAt' | 'deferred' | 'ebayNotice'
> & Partial<Pick<ScanJob, 'lookupsVia' | 'lookupsWaiting' | 'lookupsBlockedBy'>
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

/** W4: something that went wrong, in one plain sentence, and what Retry would do. */
export interface ActivityErrorRecord {
  id: string;
  at: string;
  sentence: string;
  retry: { kind: 'scan' | 'ask' | 'telegram'; label: string; searches: number; usd: number } | null;
  resolvedAt: string | null;
}

export interface ActivityCollection {
  runs: RunRecord[];
  /** W4: errors the owner may retry, newest last. */
  errors?: ActivityErrorRecord[];
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
  /** Why the agent paused itself (saved data it could not read at start); Resume clears it. */
  problem?: string | null;
}

/** W4: an Autopilot application as the agent keeps it: the contract's entry and what Undo needs. */
export interface StoredAutopilotEntry extends AutopilotEntry {
  answer: string;
  /** The item's answeredAt Autopilot wrote; Undo refuses once the owner answered again. */
  answeredAt: number;
  /** The suggestion it applied (StoredSuggestion.key). */
  suggestionKey: string;
}

/**
 * An answer the owner saved himself, kept so Undo can reopen the question (ownerAnswers.ts). `before` is what the answer
 * replaced and `after` what it wrote; Undo works only while the records are still `after`. The newest 50 are kept.
 */
export interface StoredOwnerAnswer {
  id: string;
  by: 'owner';
  at: string;
  questionId: string;
  title: string;
  /** What he answered, in plain words. */
  answer: string;
  /** The question's `answeredAt` the answer wrote. */
  answeredAt: number;
  /** The AI suggestion he used (StoredSuggestion.key), or null. */
  suggestionKey: string | null;
  undoneAt: string | null;
  undoable: boolean;
  before: Footprint;
  after: Footprint;
}

/** A digest Telegram has not taken yet; tried again after the next run. */
export interface PendingMessage {
  text: string;
  at: string;
  tries: number;
}

/** W4: what the scheduler, the meters and the alert engine keep between runs. Never a key. */
export interface AgentRuntime {
  /** When the last scheduled scan started (epoch ms); the schedule counts from it. */
  lastScheduledRunAt: number | null;
  /** When the schedule was switched on from manual (epoch ms): the first scheduled scan counts from here, not now. */
  scheduleFrom?: number | null;
  /** The last SerpApi account check (free). */
  serp: { left: number; perMonth: number; rateLimitPerHour: number; at: string } | null;
  /** Keepa's balance as its last answer said; step 15: its refill (tokens a minute) too, from any answer or the free status. */
  keepa: { tokensLeft: number; refillIn: number; refillRate?: number; at: string } | null;
  /** Step 15: the last rejection of each key by its service, in plain words; cleared when replaced or next accepted. */
  keyProblems?: Partial<Record<KeyName, string>>;
  /** Nov 23: the last verdict of each saved key's own service (agent/keyChecks.ts); dropped when the key is replaced or removed. */
  keyChecks?: Partial<Record<KeyName, KeyCheckRecord>>;
  /** Step 15: one-time changes to stored data already made (applyMigrations), by name. */
  migrations?: string[];
  /** Signals round 2: what a one-time change did to the owner's settings, in plain words, with when (ISO). */
  migrationLog?: { name: string; at: string; sentence: string }[];
  /** Step 15: the drip's last look at Keepa and its last lookup (epoch ms). */
  drip?: { checkedAt: number | null; lastLookupAt: number | null };
  /** The listing ladder, rung 2 (agent/autoConfirm.ts): today's searches and every listing it read. */
  autoConfirm?: { day: string; spent: number; tried: string[]; exhaustedDay?: string; queue?: string[]; nextAt?: number | null; unconfirmable?: Record<string, { key: string; model: string; reason: string }>; searchedAt?: Record<string, number> };
  /** Deal keys already named in a message: a deal alerts once. */
  notifiedDeals: string[];
  /** Question ids already counted in a message: the same questions do not alert again. */
  notifiedQuestions: string[];
  telegram: { pending: PendingMessage[]; lastSentAt: string | null; lastError: string | null };
  /** Seconds a unit of each kind took in recent scans, for the progress estimate (pipeline.ts). */
  rates: UnitRates;
  /** The last scan's job, as the Deals limit notice reads it (core/src/deals/limitCopy.ts). */
  lastJob: HelperLastJob | null;
}

/**
 * The watchlist, each bundle's stored scan points, the last scan's signals, what was sent today, and the owner's BOGO
 * promotions (core/src/tracking/state.ts). `derived` is worked out from the scan store and the Keepa trend cache when the
 * deals are published, so the views stay synchronous: each BOGO promotion's view and each bundle's FBA-fee estimate.
 */
export interface TrackingCollection extends TrackingState {
  /** `groups`: the automatic BOGO groups by id (bogoPairs.ts bogoGroups); absent in a store written before them. */
  derived: { bogo: Record<string, BogoView>; fba: Record<string, FbaEstimate>; groups?: Record<string, BogoGroup> };
}

/**
 * Outcomes: what the owner bought and what became of each part (core/src/outcomes). His records, not scan data: Reset scan data
 * never empties this collection. `before` and `after` are the purchase as the change found it and left it (null: it did not
 * exist, or it was removed); Undo works only while the purchase is still `after`. The newest KEEP_OUTCOME_ENTRIES are kept.
 */
export interface StoredOutcomeEntry {
  id: string;
  at: string;
  purchaseId: string;
  sentence: string;
  undoneAt: string | null;
  before: Purchase | null;
  after: Purchase | null;
}

export interface OutcomesCollection {
  purchases: Purchase[];
  entries: StoredOutcomeEntry[];
}

export interface StoreData {
  agent: AgentControl;
  settings: AppSettings & { updatedAt: string };
  keys: StoredKeys;
  deals: DealsCollection;
  review: ReviewCollection;
  suggestions: StoredSuggestion[];
  activity: ActivityCollection;
  autopilot: StoredAutopilotEntry[];
  /** The owner's own answers with what Undo needs, oldest first, at most KEEP_OWNER_ANSWERS. */
  answers: StoredOwnerAnswer[];
  jobs: WorkerJob[];
  pairing: PairingCollection;
  outbox: HelperOutbox;
  runtime: AgentRuntime;
  tracking: TrackingCollection;
  /** Outcomes: his purchases and what became of them. Never emptied by Reset scan data. */
  outcomes: OutcomesCollection;
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
  'answers',
  'jobs',
  'pairing',
  'outbox',
  'runtime',
  'tracking',
  'outcomes',
];

const OWNER_ONLY: ReadonlySet<CollectionName> = new Set(['keys', 'pairing']);

export const STORE_VERSION = 1;

export function defaultSettings(): StoreData['settings'] {
  return {
    updatedAt: new Date(0).toISOString(),
    autopilot: false,
    ebaySettings: { ...DEFAULT_EBAY_SETTINGS },
    settings: {
      schedule: DEFAULT_SETTINGS.schedule,
      searchesPerScan: DEFAULT_SETTINGS.searchesPerScan,
      reserve: DEFAULT_SETTINGS.reserve,
      keepaTokensPerScan: DEFAULT_SETTINGS.keepaTokensPerScan,
      keepaReserve: DEFAULT_SETTINGS.keepaReserve,
      fees: { ...DEFAULT_FEES },
      brands: [...DEFAULT_SETTINGS.brands],
      pagesPerBrand: DEFAULT_SETTINGS.pagesPerBrand,
      discoveryMode: DEFAULT_SETTINGS.discoveryMode,
      keepaDiscoveryShare: DEFAULT_SETTINGS.keepaDiscoveryShare,
      trackingDepth: DEFAULT_SETTINGS.trackingDepth,
      amazonRefreshViaKeepa: DEFAULT_SETTINGS.amazonRefreshViaKeepa,
    },
    // The agent messages the owner (the PO's brief), so alerts start on; the numbers are core's defaults.
    alerts: { ...DEFAULT_SETTINGS.alerts, enabled: true },
    ai: defaultAiSettings(),
    // Step 15: waiting parts are looked up with Keepa between scans as its tokens refill.
    lookups: { drip: true },
    // Free scan: the bundle lists are read in Chrome when it is connected; a scheduled scan with Chrome closed waits for it.
    scan: { listingSource: DEFAULT_LISTING_SOURCE, serpWhenChromeClosed: false },
    // Suggested prices (Nov 23): a suggestion counts only when the owner confirms it. Exists, stays off, not in the UI.
    prices: { autoAcceptSuggestions: false },
    appearance: { theme: 'system', accent: 'system', density: 'regular' },
    // Today's behaviour: every kind on, no quiet hours, a message after each run.
    notifications: {
      kinds: { review: true, deal: true, autopilot: true, scan: true, error: true },
      sound: false,
      quietHours: { enabled: false, from: '22:00', to: '07:00' },
      digest: 'each-run',
      morningAt: '08:00',
    },
    shell: { menuBarIcon: true, dockIcon: true, launchAtLogin: false, keepAwakeDuringScan: true },
  };
}

/**
 * The model each pipeline starts on: Haiku 5.5 for the judge (the cheapest, measured on the listings); Opus 5.5 for Ask AI
 * and Research (owner ruling, Nov 23: measured with 0 wrong verified answers, so their verified answers can be approved in one tap, or applied by Autopilot once the owner switches it on). $25 a month
 * until the owner says otherwise. Trusted only where the evals measured that exact model for that pipeline
 * (autopilot.ts MEASURED_MODELS). Stored settings keep whatever the owner has; this only fills new installs.
 */
export const DEFAULT_AI_MODELS: Readonly<Record<'judge' | 'assist' | 'research', string>> = {
  judge: DEFAULT_CLAUDE_JUDGE_MODEL,
  assist: 'claude-opus-5-5',
  research: 'claude-opus-5-5',
};

export function defaultAiSettings(): AppSettings['ai'] {
  const of = (p: 'judge' | 'assist' | 'research') => {
    const claude = { provider: 'anthropic' as const, model: DEFAULT_AI_MODELS[p], apiKeyRef: 'anthropic' };
    return { ...claude, trusted: measuredByDefault(p, claude) };
  };
  // Step 16: the brief's model (Opus, measured: core/src/brief/pipeline.ts) explains a suggestion and cannot change one, so it is never trusted.
  const brief = { provider: 'anthropic' as const, model: DEFAULT_BRIEF_MODEL, apiKeyRef: 'anthropic', trusted: false };
  return { judge: of('judge'), assist: of('assist'), research: of('research'), brief, monthlyCapUsd: 25 };
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
    answers: [],
    jobs: [],
    pairing: { extensions: [], requests: [] },
    outbox: { scan: null, reviewAnswers: [], paid: [], ask: [] },
    runtime: {
      lastScheduledRunAt: null, serp: null, keepa: null, notifiedDeals: [], notifiedQuestions: [],
      telegram: { pending: [], lastSentAt: null, lastError: null }, rates: {}, lastJob: null,
    },
    tracking: { ...emptyTracking(), derived: { bogo: {}, fba: {}, groups: {} } },
    outcomes: { purchases: [], entries: [] },
  };
}

/** A new, empty collection (what Reset scan data leaves behind). */
export function emptyCollection<K extends CollectionName>(name: K): StoreData[K] {
  return defaults()[name];
}

/** Fills fields a newer agent added to a collection stored by an older one. */
function normalize<K extends CollectionName>(name: K, raw: unknown): StoreData[K] {
  const base = defaults()[name];
  if (Array.isArray(base)) return (Array.isArray(raw) ? raw : base) as StoreData[K];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;
  if (name === 'settings') {
    const s = raw as Partial<StoreData['settings']>;
    const d = base as StoreData['settings'];
    const ai = (s.ai ?? {}) as Partial<AppSettings['ai']>;
    // Fields of the extension era that W4 removed are not carried on.
    const { appPrimaryUi: _a, compactHelperPanel: _c, askAfterScan: _k, ...kept } = s as Record<string, unknown>;
    const { agentBridgeAfterScan: _b, ...keptSettings } = (s.settings ?? {}) as Record<string, unknown>;
    return {
      ...d,
      ...(kept as Partial<StoreData['settings']>),
      ebaySettings: { ...d.ebaySettings, ...(s.ebaySettings ?? {}) },
      settings: { ...d.settings, ...(keptSettings as Partial<StoreData['settings']['settings']>) },
      alerts: { ...d.alerts, ...(s.alerts ?? {}) },
      appearance: { ...d.appearance, ...(s.appearance ?? {}) },
      notifications: {
        ...d.notifications,
        ...(s.notifications ?? {}),
        kinds: { ...d.notifications.kinds, ...(s.notifications?.kinds ?? {}) },
        quietHours: { ...d.notifications.quietHours, ...(s.notifications?.quietHours ?? {}) },
      },
      shell: { ...d.shell, ...(s.shell ?? {}) },
      lookups: { drip: true, ...(s.lookups ?? {}) },
      scan: { listingSource: DEFAULT_LISTING_SOURCE, serpWhenChromeClosed: false, ...(s.scan ?? {}) },
      // Suggested prices (Nov 23): off, and kept off whatever a stored file says. The PO: his approval is the answer.
      prices: { autoAcceptSuggestions: false },
      ai: {
        ...d.ai,
        ...ai,
        judge: { ...d.ai.judge, ...(ai.judge ?? {}) },
        assist: { ...d.ai.assist, ...(ai.assist ?? {}) },
        research: { ...d.ai.research, ...(ai.research ?? {}) },
        brief: { ...d.ai.brief!, ...(ai.brief ?? {}), trusted: false },
      },
    } as StoreData[K];
  }
  if (name === 'runtime') {
    const r = raw as Partial<AgentRuntime>;
    const d = base as AgentRuntime;
    return { ...d, ...r, telegram: { ...d.telegram, ...(r.telegram ?? {}) } } as StoreData[K];
  }
  return { ...(base as object), ...(raw as object) } as StoreData[K];
}

// ---------------------------------------------------------------- one-time changes to stored data

/**
 * Step 15: Keepa's per-scan cap was 5 tokens by default, which no lookup (11 tokens) can ever fit (the real Nov 23 scan:
 * 0 lookups, 18 waiting). A store still at that old default moves to 0 (automatic: every token above the reserve), once;
 * an owner who sets 5 again afterwards keeps it, because the change is remembered in runtime.migrations.
 */
export const KEEPA_AUTO_MIGRATION = 'keepa-tokens-per-scan-auto';
const OLD_KEEPA_TOKENS_PER_SCAN = 5;

/**
 * Step 16: the brief's model started as Haiku (the judge's) and became Opus after the owner's 15 real questions (Haiku $0.00518,
 * 12 of 15 briefs passed the checks, one check line invented a fact; Opus $0.1768, 15 of 15 passed). A store still on the Haiku
 * default moves to Opus once: the owner never chose it. One who sets Haiku again afterwards keeps it: the change is remembered.
 */
export const BRIEF_OPUS_MIGRATION = 'brief-model-opus';

/**
 * Signals round 2 (Nov 23): every estimate left out Amazon's fulfillment fee, because the flat fee was still the $0
 * default. A store whose fees name no fulfillment source takes Keepa's FBA fee ('keepa') when its flat fee is 0, and keeps
 * the flat fee ('flat') when the owner set one; once. One who chooses a flat $0 afterwards keeps it. The referral rate is
 * never changed here (referralSource stays 'flat': his own rate). Logged in runtime.migrations and in `migrationLog`.
 */
export const FULFILLMENT_KEEPA_MIGRATION = 'fulfillment-fee-from-keepa';

/** Applies each one-time change not made yet; returns the collections it changed. */
export function applyMigrations(data: StoreData): CollectionName[] {
  const before = data.runtime.migrations ?? [];
  const done = new Set(before);
  const changed = new Set<CollectionName>();
  if (!done.has(KEEPA_AUTO_MIGRATION)) {
    if (data.settings.settings.keepaTokensPerScan === OLD_KEEPA_TOKENS_PER_SCAN) {
      data.settings = { ...data.settings, settings: { ...data.settings.settings, keepaTokensPerScan: 0 } };
      changed.add('settings');
    }
    done.add(KEEPA_AUTO_MIGRATION);
  }
  if (!done.has(BRIEF_OPUS_MIGRATION)) {
    const brief = data.settings.ai.brief;
    if (brief && brief.provider === 'anthropic' && !brief.baseUrl && brief.model === 'claude-haiku-5-5') {
      data.settings = { ...data.settings, ai: { ...data.settings.ai, brief: { ...brief, model: DEFAULT_BRIEF_MODEL } } };
      changed.add('settings');
    }
    done.add(BRIEF_OPUS_MIGRATION);
  }
  const log: { name: string; at: string; sentence: string }[] = [];
  if (!done.has(FULFILLMENT_KEEPA_MIGRATION)) {
    const fees = data.settings.settings.fees;
    if (fees.fulfillmentSource === undefined) {
      const source = fees.fulfillmentFee === 0 ? 'keepa' : 'flat';
      data.settings = { ...data.settings, settings: { ...data.settings.settings, fees: { ...fees, fulfillmentSource: source, referralSource: fees.referralSource ?? 'flat' } } };
      changed.add('settings');
      if (source === 'keepa') {
        log.push({ name: FULFILLMENT_KEEPA_MIGRATION, at: new Date().toISOString(), sentence: "Fulfillment fee: Amazon's FBA fee from Keepa now, where Keepa has one for a part's listing; the flat fee was $0.00, which left the fee out. Your referral rate is unchanged." });
      }
    }
    done.add(FULFILLMENT_KEEPA_MIGRATION);
  }
  if (done.size === before.length) return [];
  data.runtime = { ...data.runtime, migrations: [...done], ...(log.length > 0 ? { migrationLog: [...(data.runtime.migrationLog ?? []), ...log] } : {}) };
  changed.add('runtime');
  return [...changed];
}

// ---------------------------------------------------------------- files

/** Makes a rename in `dir` survive a power cut. A directory cannot be opened on Windows; there rename is the best there is. */
function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // not supported here
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Writes the whole file to a temp name beside it, flushes it to disk, renames it over the old one and flushes the
 * directory, so after a crash or a power cut the file is the old one or the new one, never empty or half written.
 */
/** The files that hold a key or a token. Lock and temp files are written 0600 too but are not secret: no ACL work on them. */
const SECRET_FILES: ReadonlySet<string> = new Set(['agent-token', 'keys.json', 'pairing.json']);

export function writeFileAtomic(path: string, text: string, mode = 0o644): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const secret = mode === 0o600 && process.platform === 'win32' && SECRET_FILES.has(basename(path));
  if (secret) {
    // Windows ignores the mode: the empty file gets its owner-only ACL before any content (winAcl.ts).
    closeSync(openSync(tmp, 'w'));
    restrictToOwner(tmp);
  }
  const fd = openSync(tmp, 'w', mode);
  try {
    const buf = Buffer.from(text, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameOver(tmp, path);
  // Again on the final path, then read back; a failure goes to Activity, the write is never failed (winAcl.ts).
  if (secret) ensureOwnerOnlyFinal(path, basename(path));
  fsyncDir(dirname(path));
}

const RENAME_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * renameSync, and on Windows a few more tries over about half a second when the old file is held open without
 * delete sharing (a virus scanner or the search indexer reading it). Elsewhere a rename over a file does not fail so.
 */
export function renameOver(from: string, to: string, platform: NodeJS.Platform = process.platform, rename = renameSync): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (platform !== 'win32' || !RENAME_BUSY.has(code) || attempt >= 9) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** A collection's file as it reads: missing, its value, or unreadable (not JSON, or not the collection's shape). */
function readCollection(name: CollectionName, path: string): { kind: 'missing' } | { kind: 'ok'; value: unknown } | { kind: 'corrupt' } {
  if (!existsSync(path)) return { kind: 'missing' };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return { kind: 'corrupt' };
  }
  const wantArray = Array.isArray(defaults()[name]);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) !== wantArray) return { kind: 'corrupt' };
  return { kind: 'ok', value: raw };
}

/** The sentence the app shows when saved data could not be read at start. Never a key. */
export function unreadableSentence(names: CollectionName[]): string {
  const parts: string[] = [];
  if (names.includes('settings')) parts.push('Settings could not be read; the agent is paused.');
  if (names.includes('keys')) parts.push('Your saved keys could not be read; the agent is paused. The file is kept beside the store as keys.json.corrupt-…; add the keys again in Settings or restore it.');
  const rest = names.filter((n) => n !== 'settings' && n !== 'keys');
  if (rest.length) parts.push(`Saved ${rest.join(', ')} could not be read and ${rest.length === 1 ? 'was' : 'were'} kept aside; the agent is paused.`);
  return `${parts.join(' ')} Autopilot and alerts are off until you turn them on again.`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The holder touches its lock this often; a lock not touched for LOCK_STALE_MS is a dead holder's (or a reused pid's). */
export const LOCK_BEAT_MS = 10_000;
export const LOCK_STALE_MS = 60_000;

/** The pid a lock names: `{"pid":…}` now, a bare number from before. Null when it names none. */
function lockHolder(text: string): number | null {
  let pid: unknown;
  try {
    pid = (JSON.parse(text) as { pid?: unknown })?.pid ?? JSON.parse(text);
  } catch {
    return null;
  }
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Takes the single-writer lock. The lock is written whole to a temp file first and linked into place (link fails when
 * the lock exists), so nobody ever reads a half-written lock. A lock is live when its process is alive and it was
 * touched in the last minute (the heartbeat; a reused pid does not keep a dead agent's lock). A stale lock is moved
 * aside by rename before it is removed, and if what was moved is not the lock that was judged stale (another agent
 * took it over meanwhile) it is put back and this start is refused. Returns this holder's token.
 */
function takeLock(path: string): string {
  const token = randomBytes(8).toString('hex');
  const tmp = `${path}.${process.pid}.${token}.tmp`;
  writeFileAtomic(tmp, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }), 0o600);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, path);
        return token;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      let seen: string;
      let touched: number;
      try {
        seen = readFileSync(path, 'utf8');
        touched = statSync(path).mtimeMs;
      } catch {
        continue; // it went away: try again
      }
      const holder = lockHolder(seen);
      if (holder !== null && holder !== process.pid && pidAlive(holder) && Date.now() - touched < LOCK_STALE_MS) {
        throw new Error(`Another Split Finder agent (process ${holder}) is using this data folder.`);
      }
      const aside = `${path}.stale-${token}`;
      try {
        renameSync(path, aside);
      } catch {
        continue;
      }
      const moved = readFileSync(aside, 'utf8');
      if (moved !== seen) {
        try {
          linkSync(aside, path);
        } catch {
          // a third start holds it now
        }
        unlinkSync(aside);
        throw new Error('Another Split Finder agent is starting on this data folder.');
      }
      unlinkSync(aside);
    }
    throw new Error('Could not lock the agent store.');
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // gone already
    }
  }
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

const LEGACY_KEY_FIELDS = ['serpApiKey', 'keepaApiKey', 'anthropicKey', 'ebayAppId', 'ebayCertId'] as const;

/**
 * After the keys are in the store (keys.json, 0600), the old copies go: app-secrets.json is deleted and the key fields
 * are taken out of app-settings.json (its other fields stay, unread). Best effort: a file that cannot be changed is
 * left, and the next start tries again.
 */
export function scrubLegacyKeys(dataDir: string): void {
  try {
    const secrets = join(dataDir, 'app-secrets.json');
    if (existsSync(secrets)) unlinkSync(secrets);
  } catch {
    // tried again next start
  }
  try {
    const path = join(dataDir, 'app-settings.json');
    const raw = readJson(path);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
    const rec = raw as LegacyRecord;
    if (!LEGACY_KEY_FIELDS.some((f) => f in rec)) return;
    const kept = Object.fromEntries(Object.entries(rec).filter(([k]) => !(LEGACY_KEY_FIELDS as readonly string[]).includes(k)));
    writeFileAtomic(path, JSON.stringify(kept, null, 2), 0o600);
  } catch {
    // tried again next start
  }
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
    const lockToken = lockPath ? takeLock(lockPath) : null;

    const data = defaults();
    const metaPath = join(dir, 'meta.json');
    const writeMeta = (migratedFrom: string[]) =>
      writeFileAtomic(metaPath, JSON.stringify({ version: STORE_VERSION, createdAt: new Date().toISOString(), migratedFrom }, null, 2));
    if (!existsSync(metaPath)) {
      // A store with keys but no meta.json (a crash before meta was written, or meta deleted) is not new: importing the
      // old files again would bring back keys the owner deleted since.
      if (!existsSync(join(dir, 'keys.json'))) {
        const migratedFrom = migrateLegacyFiles(dataDir, data);
        // A new store (or one read from the old files) takes the one-time changes now, so they never run on it again.
        applyMigrations(data);
        const store = new Store(dir, data, lockPath);
        if (lockToken) store.holdLock(lockToken);
        if (lockPath) setAclReporter((sentence) => store.noteProblem(sentence));
        for (const name of COLLECTIONS) store.write(name);
        writeMeta(migratedFrom);
        if (lockPath) scrubLegacyKeys(dataDir);
        return store;
      }
      writeMeta([]);
    }
    // Every start of the writer, so a scrub that failed once is tried again.
    if (lockPath) scrubLegacyKeys(dataDir);
    const unreadable: CollectionName[] = [];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const name of COLLECTIONS) {
      const path = join(dir, `${name}.json`);
      const read = readCollection(name, path);
      if (read.kind === 'ok') (data as Record<CollectionName, unknown>)[name] = normalize(name, read.value);
      else if (read.kind === 'corrupt') {
        // Kept, never overwritten with defaults: the owner (or support) can restore it.
        renameSync(path, `${path}.corrupt-${stamp}`);
        unreadable.push(name);
      }
    }
    const store = new Store(dir, data, lockPath);
    if (lockToken) store.holdLock(lockToken);
    if (lockPath) setAclReporter((sentence) => store.noteProblem(sentence));
    if (unreadable.length) store.startSafe(unreadable);
    // A read-only open (lock: false) never writes.
    else if (lockPath) for (const name of applyMigrations(data)) store.write(name);
    return store;
  }

  /** Collections that could not be read at open (kept as `<name>.json.corrupt-<time>`). */
  readonly unreadable: CollectionName[] = [];

  /** Something saved could not be read: paused, Autopilot off, alerts off, and the sentence in state and Activity. */
  private startSafe(names: CollectionName[]): void {
    this.unreadable.push(...names);
    const at = new Date().toISOString();
    const sentence = unreadableSentence(names);
    this.data.agent = { ...this.data.agent, paused: true, pausedAt: at, problem: sentence };
    this.data.settings = { ...this.data.settings, autopilot: false, alerts: { ...this.data.settings.alerts, enabled: false } };
    const error: ActivityErrorRecord = { id: `err-store-${Date.now()}`, at, sentence, retry: null, resolvedAt: null };
    this.data.activity = { ...this.data.activity, errors: [...(this.data.activity.errors ?? []), error] };
    for (const name of new Set<CollectionName>([...names, 'agent', 'settings', 'activity'])) this.write(name);
  }

  /** A copy of the collection; changing it changes nothing stored. */
  get<K extends CollectionName>(name: K): StoreData[K] {
    return structuredClone(this.data[name]);
  }

  /** Replaces the collection with what `fn` returns from a copy of it, writes it, and tells listeners. */
  update<K extends CollectionName>(name: K, fn: (current: StoreData[K]) => StoreData[K]): StoreData[K] {
    if (this.closed) throw new Error('The store is closed.');
    // A copy of what fn returns, so a caller that keeps (and later changes) its object changes nothing stored.
    const next = structuredClone(fn(structuredClone(this.data[name])));
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
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    if (this.lockPath && existsSync(this.lockPath)) {
      try {
        const held = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { token?: unknown };
        if (held.token === this.lockToken) unlinkSync(this.lockPath);
      } catch {
        // the lock is gone already, or is not ours
      }
    }
  }

  private lockToken: string | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;

  /** Keeps the lock fresh while this store holds it (LOCK_STALE_MS). */
  private holdLock(token: string): void {
    this.lockToken = token;
    const path = this.lockPath!;
    this.beat = setInterval(() => {
      try {
        const now = new Date();
        utimesSync(path, now, now);
      } catch {
        // the lock went away; close() and the next start sort it out
      }
    }, LOCK_BEAT_MS);
    this.beat.unref?.();
  }

  /** A problem the agent noticed on its own (no retry): one Activity error, once per sentence. */
  noteProblem(sentence: string): void {
    const errors = this.data.activity.errors ?? [];
    if (errors.some((e) => e.sentence === sentence && !e.resolvedAt)) return;
    const error: ActivityErrorRecord = { id: `err-acl-${Date.now()}`, at: new Date().toISOString(), sentence, retry: null, resolvedAt: null };
    this.data.activity = { ...this.data.activity, errors: [...errors, error] };
    this.write('activity');
  }

  private write(name: CollectionName): void {
    writeFileAtomic(join(this.dir, `${name}.json`), JSON.stringify(this.data[name], null, 2), OWNER_ONLY.has(name) ? 0o600 : 0o644);
  }
}
