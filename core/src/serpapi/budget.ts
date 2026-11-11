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

export class SearchBudget {
  private spent = 0;

  constructor(
    private readonly account: AccountInfo,
    private readonly policy: BudgetPolicy,
  ) {}

  get spentThisRun(): number {
    return this.spent;
  }
  /** Searches left on the account right now, counting this run's spend. */
  get leftOnAccount(): number {
    return Math.max(0, this.account.totalSearchesLeft - this.spent);
  }
  get leftAboveReserve(): number {
    return Math.max(0, this.leftOnAccount - this.policy.reserve);
  }
  get leftThisRun(): number {
    return Math.max(0, this.policy.maxPerRun - this.spent);
  }
  /** The plan's searches an hour, as the account reported it; null when it is not a positive number. */
  get hourlyLimit(): number | null {
    return this.account.rateLimitPerHour > 0 ? this.account.rateLimitPerHour : null;
  }
  get leftThisHour(): number {
    return Math.max(0, this.account.rateLimitPerHour - this.account.thisHourSearches - this.spent);
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
  record(n = 1): void {
    this.spent += n;
  }
}

export const BLOCK_MESSAGE: Record<BlockReason, string> = {
  reserve: 'Stopped: spending more would dip into the search reserve.',
  run_cap: "Stopped: this run reached its search limit.",
  hourly_limit: "Stopped: the plan's hourly search limit is reached. Try again next hour.",
};
