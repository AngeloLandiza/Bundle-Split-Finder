// Costs: what the software services behind the app cost the owner, this month and by month's end, and what he allows.
// The one shape the agent serves (GET /api/costs) and the desktop UI draws. Types only; pure.
//
// What counts: services he pays for or meters (SerpApi, Keepa, the AI provider) and the free ones that have a limit
// worth seeing (eBay calls, Telegram). Never goods bought, never Amazon fees: those are the deals' own numbers.
// A price nobody entered is "not entered" (null), never $0: rule 4, never guess.

export type CostService = 'serpapi' | 'keepa' | 'ai' | 'ebay' | 'telegram' | 'amazon';
export type CostUnit = 'searches' | 'tokens' | 'usd' | 'calls' | 'messages';
/** The services the owner can set a price and a limit for. */
export type BudgetedService = 'serpapi' | 'keepa' | 'ai';

/** What the owner set for one service (Settings, Budget). */
export interface ServiceBudgetSetting {
  /** What he pays the service a month, in US dollars. Null = not entered. The AI provider is metered: its price stays null. */
  monthlyPriceUsd: number | null;
  /** The most the app may use this month, in the service's own unit (searches, Keepa tokens, AI dollars). Null = no limit of his own (the plan's still holds). */
  monthlyLimit: number | null;
  /** Percent of the limit at which he is warned. Default 80. */
  warnAtPercent: number;
}

export interface CostSettings {
  /** The most all services together may cost a month, in dollars (fixed prices plus metered spend). Null = not set. */
  totalMonthlyUsd: number | null;
  services: Record<BudgetedService, ServiceBudgetSetting>;
  /** The cost blocker: a step expected to pass a limit is not started. On by default. */
  blockWhenOver: boolean;
}

/** One local day of one service. */
export interface CostDay {
  /** YYYY-MM-DD, local time. */
  date: string;
  /** Used that day, in the service's unit. */
  used: number;
  /** Metered dollars that day (the AI provider). 0 for a subscription. */
  usd: number;
}

export interface CostForecast {
  /** Month-end totals in the service's unit: the middle of the forecast and the range most outcomes fall in (10th to 90th percentile). */
  expected: number;
  low: number;
  high: number;
  /**
   * What the forecast rests on. `history`: resampled from the owner's own runs and days. `settings`: too little history,
   * so the bound his schedule and per-run caps allow. `none`: nothing to forecast (no use, no schedule).
   */
  basis: 'history' | 'settings' | 'none';
  /** The days and runs of history behind it. */
  days: number;
  runs: number;
  /** The day the limit is expected to be reached (YYYY-MM-DD), or null when it is not expected this month. */
  limitReachedOn: string | null;
  /** One plain sentence on how it was computed, shown under the chart. */
  method: string;
}

/**
 * `ok`; `approaching`: use is at or past the warn percent; `expected_over`: the forecast passes the limit before the
 * month ends; `over`: the limit is reached; `blocked`: something was held back because of it.
 */
export type CostState = 'ok' | 'approaching' | 'expected_over' | 'over' | 'blocked';

export interface CostBlocked {
  /** "The 7:00 scan's Amazon lookups", "Review cards". */
  what: string;
  /** "It was expected to use about $0.40 and $0.31 of your $25.00 is left." */
  why: string;
  at: string;
}

export interface ServiceCost {
  service: CostService;
  /** "SerpApi", "Keepa", "AI (Anthropic)". */
  label: string;
  unit: CostUnit;
  /** Used so far this month, in the unit. */
  used: number;
  /** The owner's limit, and the plan's own (searches a month from the account check); null when there is none. */
  limit: number | null;
  planLimit: number | null;
  /** Dollars: the fixed monthly price (null = not entered), metered dollars so far, forecast month-end dollars (null when a price is missing). */
  monthlyPriceUsd: number | null;
  meteredUsd: number;
  forecastUsd: number | null;
  /** Dollars for one unit where that means something (plan price / plan limit); null otherwise. */
  usdPerUnit: number | null;
  /** This month so far, one entry a day, oldest first. */
  days: CostDay[];
  forecast: CostForecast;
  state: CostState;
  /** Plain words for the state: "62 of 150 searches (41%)", "Expected to reach your limit on Nov 28". */
  sentence: string;
  blocked: CostBlocked[];
}

export interface CostsView {
  /** "2026-11", local time. */
  month: string;
  at: string;
  services: ServiceCost[];
  total: {
    /** Dollars so far this month: fixed prices entered plus metered spend. */
    spentUsd: number;
    fixedUsd: number;
    meteredUsd: number;
    /** Month-end dollars: middle, low and high. Null when nothing can be forecast. */
    forecastUsd: number | null;
    forecastLowUsd: number | null;
    forecastHighUsd: number | null;
    budgetUsd: number | null;
    state: CostState;
    sentence: string;
    /** Services whose price is not entered, so they are missing from the dollar totals. */
    unpriced: CostService[];
  };
  /** Dollars by day for the chart, this month so far, oldest first; `cumulativeUsd` includes the fixed prices from day one. */
  days: { date: string; usd: number; cumulativeUsd: number; byService: Partial<Record<CostService, number>> }[];
  /** Earlier months, newest first, at most 12. */
  history: { month: string; totalUsd: number; byService: Partial<Record<CostService, number>> }[];
  settings: CostSettings;
}

/** Before a step that costs: may it run? The cost blocker's answer. */
export interface CostDecision {
  allow: boolean;
  service: CostService;
  /** What the step is expected to use and the high end of that, in the service's unit. */
  expected: number;
  high: number;
  used: number;
  limit: number | null;
  /** Null when allowed; otherwise the sentence the owner reads. */
  reason: string | null;
}

export const DEFAULT_COST_SETTINGS: CostSettings = {
  totalMonthlyUsd: null,
  services: {
    serpapi: { monthlyPriceUsd: null, monthlyLimit: null, warnAtPercent: 80 },
    keepa: { monthlyPriceUsd: null, monthlyLimit: null, warnAtPercent: 80 },
    ai: { monthlyPriceUsd: null, monthlyLimit: 25, warnAtPercent: 80 },
  },
  blockWhenOver: true,
};
