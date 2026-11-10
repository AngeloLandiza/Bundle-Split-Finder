// The development plan for SerpApi's free tier, in one place.
// A test (core/test/budget.test.ts) fails if these numbers stop fitting the plan.
//
// Facts (serpapi.com/pricing, checked 2026-11-09): the Free plan gives 250
// searches a month and 50 an hour. Cached, failed and errored searches are free.

export const FREE_PLAN = { searchesPerMonth: 250, searchesPerHour: 50 };

/** Never spent during development: cover for re-recording, mistakes and a second demo. */
export const DEV_RESERVE = 100;

/** The most each kind of development work may spend in a month. Ledger labels start with these names. */
export const DEV_ALLOCATION = {
  /** Record real SerpApi responses once, then replay them forever. */
  fixtures: 15,
  /** Amazon lookups for the ~30-bundle validation set. Cached, so paid once. Sized to fit one hour. */
  validation: 50,
  /** Opt-in live smoke tests. Each run spends at most 3. */
  live: 15,
  /** One real "run through what's available today" for the founder. */
  demo: 50,
} as const;

export type DevCategory = keyof typeof DEV_ALLOCATION;
