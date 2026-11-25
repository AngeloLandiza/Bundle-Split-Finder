// The mock agent's answer to GET /api/costs, in the real shape (core/src/costs/types.ts), for `?mock=costs-<scenario>`.
// A month of use is made up deterministically (no randomness, so a screenshot and a test see the same numbers); the
// limits, prices and the budget are the owner's settings, so moving a slider moves the states, the sentences and the
// forecast's "limit reached on" the way the agent's own would. The agent's real arithmetic lives in core/src/costs; this
// only has to look like it. Nothing here touches the network.

import type { CostSettings, CostService, CostState, CostsView, ServiceCost } from '@core/costs/types';
import { DEFAULT_COST_SETTINGS } from '@core/costs/types';
import { amount, dayLabel, daysInMonth, usdRound } from '../lib/costs';
import { money } from '../lib/format';

export type CostsScenario = 'calm' | 'approaching' | 'expected-over' | 'blocked' | 'unpriced' | 'no-history';
export const COSTS_SCENARIOS: readonly CostsScenario[] = ['calm', 'approaching', 'expected-over', 'blocked', 'unpriced', 'no-history'];

const pad = (n: number): string => String(n).padStart(2, '0');
const cents = (n: number): number => Math.round(n * 100) / 100;

/** Made-up use for day `d` (1-based): the same every time. */
function useOnDay(d: number, scenario: CostsScenario): { searches: number; tokens: number; ai: number } {
  if (scenario === 'no-history') return { searches: 0, tokens: 0, ai: 0 };
  return { searches: 3 + ((d * 7) % 5) + (d % 6 === 0 ? 4 : 0), tokens: 9000 + ((d * 37) % 7) * 1500, ai: cents(0.2 + ((d * 13) % 6) * 0.07) };
}

interface Usage {
  month: string;
  dates: string[];
  searches: number[];
  tokens: number[];
  ai: number[];
}

function usageOf(now: Date, scenario: CostsScenario): Usage {
  const month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const dates: string[] = [];
  const u: Usage = { month, dates, searches: [], tokens: [], ai: [] };
  for (let d = 1; d <= now.getDate(); d++) {
    dates.push(`${month}-${pad(d)}`);
    const x = useOnDay(d, scenario);
    u.searches.push(x.searches);
    u.tokens.push(x.tokens);
    u.ai.push(x.ai);
  }
  return u;
}

/** The month `n` before "2026-11". */
const earlier = (month: string, n: number): string => {
  const d = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 - n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
/** How much of the usual pace is still ahead: the schedule of a calm month, a slowed one for "approaching". */
const PACE: Record<CostsScenario, number> = { calm: 1, approaching: 0.12, 'expected-over': 1.3, blocked: 1, unpriced: 1, 'no-history': 1 };

/** The settings each scenario starts from: what the owner would have entered, and the limits that make its state true. */
export function costSettingsFor(scenario: CostsScenario, now: Date): CostSettings {
  const s: CostSettings = structuredClone(DEFAULT_COST_SETTINGS);
  const u = usageOf(now, scenario);
  const today = Math.max(1, u.dates.length);
  const left = daysInMonth(u.month) - today;
  const used = sum(u.searches);
  const aiUsed = cents(sum(u.ai));
  s.totalMonthlyUsd = 60;
  s.services.serpapi = { monthlyPriceUsd: 0, monthlyLimit: Math.max(150, Math.ceil((used * 2.2) / 10) * 10), warnAtPercent: 80 };
  s.services.keepa = { monthlyPriceUsd: scenario === 'unpriced' ? null : 19, monthlyLimit: null, warnAtPercent: 80 };
  s.services.ai = { monthlyPriceUsd: null, monthlyLimit: 25, warnAtPercent: 80 };
  if (scenario === 'approaching') s.services.serpapi.monthlyLimit = Math.ceil(used / 0.86);
  if (scenario === 'expected-over') s.services.serpapi.monthlyLimit = Math.max(used + 10, Math.ceil((used + (used / today) * left * PACE[scenario]) * 0.8));
  if (scenario === 'blocked') s.services.ai.monthlyLimit = cents(aiUsed + 0.31);
  return s;
}

function sentenceOf(s: { used: number; limit: number | null; unit: ServiceCost['unit']; state: CostState; reach: string | null; month: string }): string {
  const pct = s.limit ? Math.round((s.used / s.limit) * 100) : null;
  const base = s.limit !== null ? `${amount(s.used, s.unit)} of ${amount(s.limit, s.unit)} (${pct}%)` : `${amount(s.used, s.unit)} used this month`;
  if (s.state === 'over') return `At your limit: ${base}`;
  if (s.state === 'expected_over' && s.reach) return `Expected to reach your limit on ${dayLabel(s.month, Number(s.reach.slice(8, 10)))}: ${base}`;
  if (s.state === 'blocked') return `Held back to stay inside your limit: ${base}`;
  return base;
}

/** The agent's answer for this scenario, with these settings, on this day. */
export function buildCostsView(scenario: CostsScenario, settings: CostSettings, now: Date): CostsView {
  const u = usageOf(now, scenario);
  const today = Math.max(1, u.dates.length);
  const N = daysInMonth(u.month);
  const left = N - today;
  const pace = PACE[scenario];
  const noHistory = scenario === 'no-history';
  const dayDate = (offset: number): string => `${u.month}-${pad(Math.min(N, today + offset))}`;

  const make = (service: 'serpapi' | 'keepa' | 'ai'): ServiceCost => {
    const cfg = settings.services[service];
    const series = service === 'serpapi' ? u.searches : service === 'keepa' ? u.tokens : u.ai;
    const unit = service === 'serpapi' ? 'searches' : service === 'keepa' ? 'tokens' : 'usd';
    const used = service === 'ai' ? cents(sum(series)) : sum(series);
    const planLimit = service === 'serpapi' ? 250 : service === 'keepa' ? 864_000 : null;
    const limit = cfg.monthlyLimit;
    const rate = noHistory ? 0 : used / today;
    const expectedRest = noHistory ? 0 : rate * left * pace;
    // With no history the forecast is the bound the schedule allows, and says so.
    const bound = service === 'serpapi' ? 96 : service === 'keepa' ? 400_000 : 11;
    const expected = noHistory ? bound : service === 'ai' ? cents(used + expectedRest) : Math.round(used + expectedRest);
    const low = noHistory ? expected : service === 'ai' ? cents(used + expectedRest * 0.7) : Math.round(used + expectedRest * 0.7);
    const high = noHistory ? expected : service === 'ai' ? cents(used + expectedRest * 1.35) : Math.round(used + expectedRest * 1.35);
    const cap = limit ?? planLimit;
    const reached = cap !== null && used < cap && expected > cap && rate > 0 ? Math.max(1, Math.ceil((cap - used) / (rate * pace || rate))) : null;
    const limitReachedOn = reached !== null && today + reached <= N ? dayDate(reached) : null;

    const blocked =
      service === 'ai' && limit !== null && settings.blockWhenOver && limit - used < 0.4 && limit > used
        ? [{ what: 'Review cards', why: `It was expected to use about ${money(0.4)} and ${money(cents(limit - used))} of your ${money(limit)} is left.`, at: now.toISOString() }]
        : [];
    const warn = cfg.warnAtPercent / 100;
    let state: CostState = 'ok';
    if (limit !== null && used >= limit) state = 'over';
    else if (limit !== null && expected > limit) state = 'expected_over';
    else if (limit !== null && used >= warn * limit) state = 'approaching';
    if (blocked.length) state = 'blocked';

    const meteredUsd = service === 'ai' ? used : 0;
    const price = service === 'ai' ? null : cfg.monthlyPriceUsd;
    const forecastUsd = service === 'ai' ? expected : price;
    return {
      service,
      label: service === 'serpapi' ? 'SerpApi' : service === 'keepa' ? 'Keepa' : 'AI (Anthropic)',
      unit,
      used,
      limit,
      planLimit,
      monthlyPriceUsd: price,
      meteredUsd,
      forecastUsd,
      usdPerUnit: service === 'serpapi' && price ? price / (planLimit ?? 1) : null,
      days: u.dates.map((date, i) => ({ date, used: series[i] ?? 0, usd: service === 'ai' ? (u.ai[i] ?? 0) : 0 })),
      forecast: {
        expected,
        low,
        high,
        basis: noHistory ? 'settings' : 'history',
        days: noHistory ? 0 : today,
        runs: noHistory ? 0 : Math.round(today * 1.6),
        limitReachedOn,
        method: noHistory
          ? 'Too little history, so this is the most your schedule and per-run caps allow.'
          : 'Resampled from your own days and runs this month, 1,000 times, with the runs your schedule still has; the range is the 10th to 90th percentile.',
      },
      state,
      sentence: sentenceOf({ used, limit, unit, state, reach: limitReachedOn, month: u.month }),
      blocked,
    };
  };

  const free = (service: CostService, label: string, unit: ServiceCost['unit'], used: number): ServiceCost => ({
    service,
    label,
    unit,
    used,
    limit: null,
    planLimit: null,
    monthlyPriceUsd: 0,
    meteredUsd: 0,
    forecastUsd: 0,
    usdPerUnit: null,
    days: [],
    forecast: { expected: used, low: used, high: used, basis: used > 0 ? 'history' : 'none', days: 0, runs: 0, limitReachedOn: null, method: '' },
    state: 'ok',
    sentence: `${amount(used, unit)} this month`,
    blocked: [],
  });

  const services = [make('serpapi'), make('keepa'), make('ai'), free('ebay', 'eBay', 'calls', noHistory ? 0 : 38), free('telegram', 'Telegram', 'messages', noHistory ? 0 : 7)];
  const unpriced = services.filter((s) => (s.service === 'serpapi' || s.service === 'keepa') && s.monthlyPriceUsd === null).map((s) => s.service);
  const fixedUsd = cents(sum(services.filter((s) => s.service !== 'ai').map((s) => s.monthlyPriceUsd ?? 0)));
  const meteredUsd = cents(sum(services.map((s) => s.meteredUsd)));
  const spentUsd = cents(fixedUsd + meteredUsd);
  const ai = services.find((s) => s.service === 'ai')!;
  const fixedForecast = sum(services.filter((s) => s.service !== 'ai').map((s) => s.monthlyPriceUsd ?? 0));
  const forecastUsd = cents(fixedForecast + ai.forecast.expected);
  const forecastLowUsd = cents(fixedForecast + ai.forecast.low);
  const forecastHighUsd = cents(fixedForecast + ai.forecast.high);
  const budgetUsd = settings.totalMonthlyUsd;

  let cum = fixedUsd;
  const days = u.dates.map((date, i) => {
    const usd = u.ai[i] ?? 0;
    cum = cents(cum + usd);
    return { date, usd, cumulativeUsd: cum, byService: { serpapi: 0, keepa: 0, ai: usd } };
  });

  let state: CostState = 'ok';
  if (budgetUsd !== null && spentUsd >= budgetUsd) state = 'over';
  else if (budgetUsd !== null && forecastUsd > budgetUsd) state = 'expected_over';
  else if (budgetUsd !== null && spentUsd >= 0.8 * budgetUsd) state = 'approaching';
  const verdict = budgetUsd === null ? ', and no total budget is set.' : forecastUsd <= budgetUsd ? `, inside your ${usdRound(budgetUsd)} budget.` : `, over your ${usdRound(budgetUsd)} budget.`;
  const sentence = `${money(spentUsd)} so far this month. Expected about ${usdRound(forecastUsd)} by ${dayLabel(u.month, N)} (between ${usdRound(forecastLowUsd)} and ${usdRound(forecastHighUsd)})${verdict}`;

  return {
    month: u.month,
    at: now.toISOString(),
    services,
    total: { spentUsd, fixedUsd, meteredUsd, forecastUsd, forecastLowUsd, forecastHighUsd, budgetUsd, state, sentence, unpriced },
    days,
    history: [
      { month: earlier(u.month, 1), totalUsd: 38.4, byService: { keepa: 19, ai: 19.4 } },
      { month: earlier(u.month, 2), totalUsd: 31.1, byService: { keepa: 19, ai: 12.1 } },
    ],
    settings,
  };
}
