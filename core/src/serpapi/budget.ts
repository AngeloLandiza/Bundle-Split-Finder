// Search budget: the one place that decides whether a paid SerpApi search may happen.
//
// Facts this is built on (SerpApi docs, checked 2026-11-09):
//   - Free plan: 250 searches a month, 50 an hour.
//   - Only successful searches count. Cached, errored and failed searches are free.
//   - The Account API is free and reports what is left.
//
// Three limits apply at once, and the tightest one wins:
//   reserve      searches that must stay on the account no matter what
//   run cap      the most one scan (or one test session) may spend
//   hourly limit the plan's throughput per hour

export interface AccountInfo {
  planName: string;
  status: string;
  searchesPerMonth: number;
  totalSearchesLeft: number;
  thisMonthUsage: number;
  thisHourSearches: number;
  rateLimitPerHour: number;
  renewalDate: string | null;
}

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** Parse the response of GET https://serpapi.com/account.json */
export function parseAccount(json: unknown): AccountInfo {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (typeof j.error === 'string') throw new Error(`SerpApi account error: ${j.error}`);
  const perMonth = num(j.searches_per_month);
  const left = num(j.total_searches_left, num(j.plan_searches_left));
  return {
    planName: typeof j.plan_name === 'string' ? j.plan_name : 'Unknown plan',
    status: typeof j.account_status === 'string' ? j.account_status : 'Unknown',
    searchesPerMonth: perMonth,
    totalSearchesLeft: left,
    thisMonthUsage: num(j.this_month_usage, Math.max(0, perMonth - left)),
    thisHourSearches: num(j.this_hour_searches),
    // If the field is missing, assume the free plan's limit rather than "unlimited".
    rateLimitPerHour: num(j.account_rate_limit_per_hour, 50),
    renewalDate: typeof j.plan_renewal_date === 'string' ? j.plan_renewal_date : null,
  };
}

export interface BudgetPolicy {
  /** Searches that must remain on the account after any spend. */
  reserve: number;
  /** Most searches a single scan or test session may spend. */
  maxPerRun: number;
}

export type BlockReason = 'reserve' | 'run_cap' | 'hourly_limit';

/**
 * Nov 25, key stacking (desktop agent only): one saved key's account, as its own free account check said. Each key is its
 * own SerpApi account, with its own searches left and its own hourly limit.
 */
export interface KeyAccount {
  id: string;
  account: AccountInfo;
}

interface KeyLedger {
  id: string;
  account: AccountInfo;
  spent: number;
  /** SerpApi refused this key during the run (not accepted, or out of searches): it pays for nothing more. */
  out: boolean;
}

/** The id a budget made from one plain AccountInfo gives its only key. */
export const SINGLE_KEY_ID = '';

export class SearchBudget {
  private readonly keys: KeyLedger[];

  /**
   * One account (the extension, development, every caller before key stacking), or several keys' accounts (the desktop
   * agent's owner keys). With several, searches left and the month's allowance are the sums; the reserve and the run cap
   * are single numbers that apply to the total; the hourly limit is each account's own.
   */
  constructor(
    account: AccountInfo | readonly KeyAccount[],
    private readonly policy: BudgetPolicy,
  ) {
    this.keys = Array.isArray(account)
      ? (account as readonly KeyAccount[]).map((k) => ({ id: k.id, account: k.account, spent: 0, out: false }))
      : [{ id: SINGLE_KEY_ID, account: account as AccountInfo, spent: 0, out: false }];
  }

  /** Several keys (or none): the sums. One key reads exactly as a budget before key stacking. */
  private get pooled(): boolean {
    return this.keys.length !== 1;
  }
  private leftOn(k: KeyLedger): number {
    return k.out ? 0 : Math.max(0, k.account.totalSearchesLeft - k.spent);
  }
  private hourLeftOn(k: KeyLedger): number {
    return Math.max(0, k.account.rateLimitPerHour - k.account.thisHourSearches - k.spent);
  }

  get spentThisRun(): number {
    return this.keys.reduce((n, k) => n + k.spent, 0);
  }
  /** Searches left on the account right now, counting this run's spend (with several keys: on all of them together). */
  get leftOnAccount(): number {
    return this.keys.reduce((n, k) => n + this.leftOn(k), 0);
  }
  get leftAboveReserve(): number {
    return Math.max(0, this.leftOnAccount - this.policy.reserve);
  }
  get leftThisRun(): number {
    return Math.max(0, this.policy.maxPerRun - this.spentThisRun);
  }
  /**
   * The plan's searches an hour, as the account reported it; null when it is not a positive number. With several keys,
   * the sum of the accounts still in play (each hour is each account's own).
   */
  get hourlyLimit(): number | null {
    if (!this.pooled) return this.keys[0]!.account.rateLimitPerHour > 0 ? this.keys[0]!.account.rateLimitPerHour : null;
    const sum = this.keys.filter((k) => !k.out && k.account.rateLimitPerHour > 0).reduce((n, k) => n + k.account.rateLimitPerHour, 0);
    return sum > 0 ? sum : null;
  }
  /**
   * Searches this hour still allows. With several keys a search needs one key with both a search left and room in its own
   * hour, so each key counts the smaller of the two: the sum is what this hour can really take.
   */
  get leftThisHour(): number {
    if (!this.pooled) return this.hourLeftOn(this.keys[0]!);
    return this.keys.reduce((n, k) => n + Math.min(this.hourLeftOn(k), this.leftOn(k)), 0);
  }
  /** How many more paid searches may happen right now. */
  get spendable(): number {
    return Math.min(this.leftAboveReserve, this.leftThisRun, this.leftThisHour);
  }

  blockReason(n = 1): BlockReason | null {
    if (this.leftAboveReserve < n) return 'reserve';
    if (this.leftThisRun < n) return 'run_cap';
    if (this.leftThisHour < n) return 'hourly_limit';
    return null;
  }
  canSpend(n = 1): boolean {
    return this.blockReason(n) === null;
  }
  /** One counted search, charged to the key that made it (the only key when none is named). */
  record(n = 1, keyId?: string): void {
    const k = (keyId === undefined ? undefined : this.keys.find((x) => x.id === keyId)) ?? this.keys[0];
    if (k) k.spent += n;
  }

  /**
   * The key the next search is charged to, chosen before the call from the fresh account data: the key with the most
   * searches left that is not at its hourly limit and was not refused (nor in `exclude`); on a tie, the earlier key. Null
   * when no key can take a search now.
   */
  pickKey(exclude: ReadonlySet<string> = new Set()): string | null {
    let best: KeyLedger | null = null;
    for (const k of this.keys) {
      if (k.out || exclude.has(k.id) || this.leftOn(k) < 1 || this.hourLeftOn(k) < 1) continue;
      if (best === null || this.leftOn(k) > this.leftOn(best)) best = k;
    }
    return best?.id ?? null;
  }

  /** SerpApi refused this key (not accepted, or out of searches): it counts for nothing more in this run. */
  markOut(keyId: string): void {
    const k = this.keys.find((x) => x.id === keyId);
    if (k) k.out = true;
  }

  /** Each key as this run sees it: searches left, spent in this run, and whether SerpApi refused it. */
  get byKey(): { id: string; left: number; spent: number; out: boolean }[] {
    return this.keys.map((k) => ({ id: k.id, left: this.leftOn(k), spent: k.spent, out: k.out }));
  }
}

/**
 * The sum of several keys' accounts as one AccountInfo, for what reads one account (a scan's summary, the costs): searches
 * left, used and the month's allowance summed; the hourly figures summed too. The plan's name is the one name when every
 * key has it, else the names joined with " + ".
 */
export function pooledAccount(accounts: readonly AccountInfo[]): AccountInfo {
  if (accounts.length === 1) return accounts[0]!;
  const sum = (f: (a: AccountInfo) => number) => accounts.reduce((n, a) => n + f(a), 0);
  const names = [...new Set(accounts.map((a) => a.planName))];
  const renewals = accounts.map((a) => a.renewalDate).filter((d): d is string => d !== null).sort();
  return {
    planName: names.join(' + '),
    status: accounts.every((a) => a.status === accounts[0]?.status) ? (accounts[0]?.status ?? 'Unknown') : 'Mixed',
    searchesPerMonth: sum((a) => a.searchesPerMonth),
    totalSearchesLeft: sum((a) => a.totalSearchesLeft),
    thisMonthUsage: sum((a) => a.thisMonthUsage),
    thisHourSearches: sum((a) => a.thisHourSearches),
    rateLimitPerHour: sum((a) => a.rateLimitPerHour),
    renewalDate: renewals[0] ?? null,
  };
}

export const BLOCK_MESSAGE: Record<BlockReason, string> = {
  reserve: 'Stopped: spending more would dip into the search reserve.',
  run_cap: "Stopped: this run reached its search limit.",
  hourly_limit: "Stopped: the plan's hourly search limit is reached. Try again next hour.",
};
