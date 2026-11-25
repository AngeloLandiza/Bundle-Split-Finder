// The costs view (step 18, GET /api/costs): each software service's use this month from the app's own records, its limit
// and price as the owner set them, the month-end forecast, and the dollars together. Pure: the agent reads the ledgers,
// runs and settings and hands them in with the clock.
//
// A price nobody entered stays null and the service is left out of the dollar totals, which name it (rule 4). SerpApi's
// free plan is known from the account check and is $0. eBay's Browse API and Telegram's bot API are free services: $0.

import { nextRun, type Schedule } from '../schedule';
import { forecastService, HISTORY_WINDOW_DAYS, reachWords, seedOf, type SettingsBound } from './forecast';
import { addDays, datesBetween, daysInMonth, localDate, monthOf, shortDay } from './time';
import type { BudgetedService, CostBlocked, CostService, CostSettings, CostState, CostUnit, CostsView, ServiceCost } from './types';
import { aiEvents, byDay, byMonth, countEvents, keepaEvents, type AiSpendSources, type KeepaLedgerRow, monthDays, serpEvents, type UsageEvent } from './usage';
import { amount, figure, usd } from './words';

/** A run as Activity keeps it (contract RunRecord), as far as the costs read it. */
export interface CostRun {
  startedAt: string;
  kind: string;
  trigger?: string;
  status: string;
  searchesUsed: number;
  keepaTokensUsed: number;
  aiCostUsd: number;
}

export interface CostsInput {
  now: number;
  /** Undefined: the computer's own zone. */
  tz?: string;
  settings: CostSettings;
  schedule: Schedule;
  lastScheduledRunAt: number | null;
  /** What his settings let a scheduled scan and a day spend (the per-scan caps, the listing check's searches a day; 0 when off). */
  caps: { searchesPerScan: number; verifySearchesPerDay: number };
  serp: { rows: readonly { at: string }[]; plan: { perMonth: number; planName?: string | null } | null };
  keepa: { rows: readonly KeepaLedgerRow[]; refillPerMin: number | null };
  ai: AiSpendSources & { label: string };
  /** eBay calls and Telegram messages by local day. */
  counts: Readonly<Record<string, { ebay?: number; telegram?: number }>>;
  runs: readonly CostRun[];
  /** What the blocker held this month, by service. */
  blocked: Partial<Record<CostService, readonly CostBlocked[]>>;
}

/** The free SerpApi plan, from the account check: by its name, or by the free plan's 250 searches when no name was kept. */
export function freeSerpPlan(plan: CostsInput['serp']['plan']): boolean {
  if (!plan) return false;
  if (plan.planName) return /free/i.test(plan.planName);
  return plan.perMonth === 250;
}

/** The local dates of the scheduled scans left this month (today's still to come included), one entry a scan. */
export function scheduledRunsLeft(schedule: Schedule, now: number, lastRun: number | null, tz?: string): string[] {
  const month = monthOf(localDate(now, tz));
  const first = nextRun(schedule, new Date(now), lastRun === null ? null : new Date(lastRun));
  const out: string[] = [];
  for (let t = first; t !== null && out.length < 1000;) {
    const date = localDate(t.getTime(), tz);
    if (monthOf(date) !== month) break;
    out.push(date);
    if (schedule.mode === 'interval') t = new Date(t.getTime() + schedule.hours * 3_600_000);
    else if (schedule.mode === 'daily') {
      const [h, m] = schedule.at.split(':').map(Number) as [number, number];
      const next = new Date(t);
      next.setDate(next.getDate() + 1);
      next.setHours(h, m, 0, 0);
      t = next;
    } else break;
  }
  return out;
}

const RECENT_BLOCK_MS = 24 * 60 * 60_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const SERVICE_ORDER: readonly CostService[] = ['serpapi', 'keepa', 'ai', 'ebay', 'telegram'];

interface Spec {
  service: CostService;
  label: string;
  unit: CostUnit;
  events: UsageEvent[];
  /** What a scan run used of this service; null: the service is not counted per run. */
  perRun: ((r: CostRun) => number) | null;
  limit: number | null;
  warnAtPercent: number;
  planLimit: number | null;
  price: number | null;
  metered: boolean;
  bound: SettingsBound | null;
}

/** Whether the run is a scan that finished (its use is a sample of what a scan uses). */
const scanRun = (r: CostRun): boolean => r.kind === 'scan' && r.status !== 'running';

function serviceCost(spec: Spec, ctx: { input: CostsInput; today: string; firstDay: string; runsLeft: string[] }): ServiceCost {
  const { input, today } = ctx;
  const month = monthOf(today);
  const tz = input.tz;
  const days = monthDays(spec.events, today, tz);
  const used = days.reduce((n, d) => n + d.used, 0);
  const usdSoFar = days.reduce((n, d) => n + d.usd, 0);
  const windowStart = addDays(today, -HISTORY_WINDOW_DAYS);
  const dayOf = (r: CostRun) => localDate(Date.parse(r.startedAt), tz);
  const runs = input.runs.filter((r) => scanRun(r) && Number.isFinite(Date.parse(r.startedAt)) && dayOf(r) >= windowStart && dayOf(r) <= today);
  const runSamples = spec.perRun ? runs.map((r) => Math.max(0, spec.perRun!(r))) : [];
  // A scheduled scan's use is counted per scan; everything else a day did (manual scans included) is the day's.
  const scheduled = new Map<string, number>();
  if (spec.perRun) for (const r of runs.filter((x) => x.trigger === 'scheduled')) scheduled.set(dayOf(r), (scheduled.get(dayOf(r)) ?? 0) + Math.max(0, spec.perRun(r)));
  const totals = byDay(spec.events, tz);
  const from = ctx.firstDay > windowStart ? ctx.firstDay : windowStart;
  const daySamples = from <= addDays(today, -1) ? datesBetween(from, addDays(today, -1)).map((d) => Math.max(0, (totals.get(d)?.used ?? 0) - (scheduled.get(d) ?? 0))) : [];
  const todayUsed = Math.max(0, (totals.get(today)?.used ?? 0) - (scheduled.get(today) ?? 0));
  const forecast = forecastService({
    unit: spec.unit, used: round6(used), todayUsed, limit: spec.limit, today, runSamples, daySamples: daySamples.map(round6),
    runsLeft: spec.perRun ? ctx.runsLeft : [], bound: spec.bound, seed: seedOf(`${month}:${spec.service}`),
  });
  const blocked = [...(input.blocked[spec.service] ?? [])].filter((b) => monthOf(localDate(Date.parse(b.at), tz)) === month);
  const last = blocked.length > 0 ? blocked[blocked.length - 1]! : null;
  const { state, sentence } = stateOf(spec, used, forecast.limitReachedOn, forecast.basis, last, input.now, tz);
  const price = spec.price;
  return {
    service: spec.service, label: spec.label, unit: spec.unit, used: spec.unit === 'usd' ? round2(used) : Math.round(used),
    limit: spec.limit, planLimit: spec.planLimit,
    monthlyPriceUsd: price, meteredUsd: spec.metered ? round2(usdSoFar) : 0,
    forecastUsd: spec.metered ? forecast.expected : price,
    usdPerUnit: price !== null && spec.planLimit !== null && spec.planLimit > 0 ? round6(price / spec.planLimit) : null,
    days, forecast, state, sentence, blocked,
  };
}

function stateOf(spec: Spec, used: number, reachedOn: string | null, basis: string, last: CostBlocked | null, now: number, tz?: string): { state: CostState; sentence: string } {
  const limit = spec.limit;
  const of = limit !== null ? (spec.unit === 'usd' ? `${usd(used)} of ${usd(limit)}` : `${figure(used)} of ${amount(limit, spec.unit)}`) : null;
  if (limit === 0) return { state: 'ok', sentence: `Turned off: your limit is ${amount(0, spec.unit)}.` };
  if (limit !== null && used >= limit) return { state: 'over', sentence: `Limit reached: ${of}.` };
  if (last && now - Date.parse(last.at) < RECENT_BLOCK_MS) return { state: 'blocked', sentence: `Held back: ${last.what} (${shortDay(localDate(Date.parse(last.at), tz))}).` };
  if (basis === 'history' && reachedOn !== null) return { state: 'expected_over', sentence: `${reachWords(reachedOn)}: ${of} so far.` };
  if (limit !== null) {
    const pct = Math.floor((used / limit) * 100);
    return { state: pct >= spec.warnAtPercent ? 'approaching' : 'ok', sentence: `${of} (${pct}%).` };
  }
  return { state: 'ok', sentence: `${amount(used, spec.unit)} this month; no limit set.` };
}

export function buildCostsView(input: CostsInput): CostsView {
  const tz = input.tz;
  const today = localDate(input.now, tz);
  const month = monthOf(today);
  const s = input.settings;
  const svc = s.services;
  const free = freeSerpPlan(input.serp.plan);
  const serpEv = serpEvents(input.serp.rows);
  const keepaEv = keepaEvents(input.keepa.rows);
  const aiEv = aiEvents(input.ai);
  const ebayEv = countEvents(Object.fromEntries(Object.entries(input.counts).map(([d, c]) => [d, c.ebay ?? 0])));
  const tgEv = countEvents(Object.fromEntries(Object.entries(input.counts).map(([d, c]) => [d, c.telegram ?? 0])));
  const all = [...serpEv, ...keepaEv, ...aiEv, ...ebayEv, ...tgEv];
  const starts = [...all.map((e) => e.at), ...input.runs.map((r) => Date.parse(r.startedAt)).filter(Number.isFinite)];
  const firstDay = starts.length > 0 ? localDate(Math.min(...starts), tz) : today;
  const runsLeft = scheduledRunsLeft(input.schedule, input.now, input.lastScheduledRunAt, tz);
  // Keepa's refill as its token status said, else as its last charged answer in the ledger said.
  const lastRate = [...input.keepa.rows].reverse().find((r) => typeof r.refillRate === 'number' && r.refillRate > 0)?.refillRate ?? null;
  const refill = input.keepa.refillPerMin ?? lastRate;
  const keepaPlan = refill !== null && refill > 0 ? Math.round(refill * 1440 * daysInMonth(month)) : null;
  const serpPrice = svc.serpapi.monthlyPriceUsd ?? (free ? 0 : null);
  const held = (service: BudgetedService) => (s.blockWhenOver || service === 'ai' ? svc[service].monthlyLimit : null);
  const scans = runsLeft.length;

  const specs: Spec[] = [
    {
      service: 'serpapi', label: 'SerpApi', unit: 'searches', events: serpEv, perRun: (r) => r.searchesUsed, limit: svc.serpapi.monthlyLimit,
      warnAtPercent: svc.serpapi.warnAtPercent, planLimit: input.serp.plan?.perMonth ?? null, price: serpPrice, metered: false,
      bound: {
        perRun: input.caps.searchesPerScan, perDay: input.caps.verifySearchesPerDay, cap: held('serpapi'),
        words: [
          ...(scans > 0 ? [`${amount(input.caps.searchesPerScan, 'searches')} for each of the ${figure(scans)} scheduled ${scans === 1 ? 'scan' : 'scans'} left`] : []),
          `${amount(input.caps.verifySearchesPerDay, 'searches')} a day for the listing check`,
        ].join(' and ') + (held('serpapi') !== null ? `, never past your limit of ${amount(held('serpapi')!, 'searches')}` : ', plus any scan you start yourself'),
      },
    },
    {
      service: 'keepa', label: 'Keepa', unit: 'tokens', events: keepaEv, perRun: (r) => r.keepaTokensUsed, limit: svc.keepa.monthlyLimit,
      warnAtPercent: svc.keepa.warnAtPercent, planLimit: keepaPlan, price: svc.keepa.monthlyPriceUsd, metered: false,
      // Every Keepa token, a scan's or the drip's, comes out of the same refill: it bounds the month whatever runs.
      bound: refill !== null && refill > 0
        ? { perRun: 0, perDay: refill * 1440, cap: held('keepa'), words: `Keepa refills ${figure(refill)} ${refill === 1 ? 'token' : 'tokens'} a minute, ${figure(refill * 1440)} a day${held('keepa') !== null ? `, never past your limit of ${amount(held('keepa')!, 'tokens')}` : ''}` }
        : held('keepa') !== null ? { perRun: null, perDay: null, cap: held('keepa'), words: `your limit of ${amount(held('keepa')!, 'tokens')}` } : null,
    },
    {
      service: 'ai', label: input.ai.label, unit: 'usd', events: aiEv, perRun: (r) => r.aiCostUsd, limit: svc.ai.monthlyLimit,
      warnAtPercent: svc.ai.warnAtPercent, planLimit: null, price: null, metered: true,
      bound: svc.ai.monthlyLimit !== null ? { perRun: null, perDay: null, cap: svc.ai.monthlyLimit, words: `your ${usd(svc.ai.monthlyLimit)} AI limit` } : null,
    },
    { service: 'ebay', label: 'eBay', unit: 'calls', events: ebayEv, perRun: null, limit: null, warnAtPercent: 80, planLimit: null, price: 0, metered: false, bound: null },
    { service: 'telegram', label: 'Telegram', unit: 'messages', events: tgEv, perRun: null, limit: null, warnAtPercent: 80, planLimit: null, price: 0, metered: false, bound: null },
  ];
  const services = specs.map((spec) => serviceCost(spec, { input, today, firstDay, runsLeft }));
  const by = (k: CostService) => services.find((x) => x.service === k)!;
  const ai = by('ai');

  // A subscription not entered is named when it is in use: a ledger row in the window, or a plan or refill known.
  const windowStart = Date.parse(`${addDays(today, -HISTORY_WINDOW_DAYS)}T00:00:00`);
  const inUse = (k: 'serpapi' | 'keepa'): boolean =>
    (k === 'serpapi' ? serpEv : keepaEv).some((e) => e.at >= windowStart) || (k === 'serpapi' ? input.serp.plan !== null : refill !== null);
  const unpriced = (['serpapi', 'keepa'] as const).filter((k) => by(k).monthlyPriceUsd === null && inUse(k));
  const fixed = round2((['serpapi', 'keepa'] as const).reduce((n, k) => n + (by(k).monthlyPriceUsd ?? 0), 0));
  const metered = ai.meteredUsd;
  const spent = round2(fixed + metered);
  const pricedFixed = (['serpapi', 'keepa'] as const).some((k) => by(k).monthlyPriceUsd !== null);
  const noForecast = !pricedFixed && ai.forecast.basis === 'none' && metered === 0;
  const fc = noForecast ? null : { mid: round2(fixed + ai.forecast.expected), low: round2(fixed + ai.forecast.low), high: round2(fixed + ai.forecast.high) };
  const budget = s.totalMonthlyUsd;
  const total = totalState(spent, budget, fc, ai.forecast.basis, today, unpriced.map((k) => by(k).label));

  const aiDays = new Map(ai.days.map((d) => [d.date, d.usd]));
  let cum = 0;
  const chart = datesBetween(`${month}-01`, today).map((date, i) => {
    const byService: Partial<Record<CostService, number>> = {};
    let usdDay = aiDays.get(date) ?? 0;
    if (usdDay > 0) byService.ai = round6(usdDay);
    if (i === 0) {
      for (const k of ['serpapi', 'keepa'] as const) {
        const p = by(k).monthlyPriceUsd;
        if (p !== null && p > 0) byService[k] = p;
        usdDay += p ?? 0;
      }
    }
    cum += usdDay;
    return { date, usd: round6(usdDay), cumulativeUsd: round6(cum), byService };
  });

  // Earlier months: the AI's own dollars, and a subscription at today's entered price in a month its ledger shows use
  // (the app does not know an older price; docs/decisions.md).
  const months = new Map<string, Partial<Record<CostService, number>>>();
  const put = (m: string, k: CostService, v: number) => {
    if (m >= month) return;
    const row = months.get(m) ?? {};
    row[k] = round6((row[k] ?? 0) + v);
    months.set(m, row);
  };
  for (const [m, v] of byMonth(aiEv, tz)) put(m, 'ai', v.usd);
  for (const k of ['serpapi', 'keepa'] as const) {
    const p = by(k).monthlyPriceUsd;
    if (p !== null) for (const [m] of byMonth(k === 'serpapi' ? serpEv : keepaEv, tz)) put(m, k, p);
  }
  const history = [...months.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 12)
    .map(([m, byService]) => ({ month: m, totalUsd: round2(Object.values(byService).reduce((n, v) => n + (v ?? 0), 0)), byService }));

  return {
    month, at: new Date(input.now).toISOString(),
    services: SERVICE_ORDER.map(by),
    total: {
      spentUsd: spent, fixedUsd: fixed, meteredUsd: metered,
      forecastUsd: fc?.mid ?? null, forecastLowUsd: fc?.low ?? null, forecastHighUsd: fc?.high ?? null,
      budgetUsd: budget, state: total.state, sentence: total.sentence, unpriced,
    },
    days: chart, history, settings: structuredClone(s),
  };
}

function totalState(spent: number, budget: number | null, fc: { mid: number; low: number; high: number } | null, basis: string, today: string, unpriced: string[]): { state: CostState; sentence: string } {
  const end = shortDay(`${monthOf(today)}-${String(daysInMonth(monthOf(today))).padStart(2, '0')}`);
  const forecast = fc === null ? '' : basis === 'history'
    ? `; about ${usd(fc.mid)} by ${end} (${usd(fc.low)} to ${usd(fc.high)})`
    : `; at most ${usd(fc.high)} by ${end}`;
  const missing = unpriced.length === 0 ? '' : ` ${unpriced.join(' and ')} ${unpriced.length === 1 ? 'is' : 'are'} not counted: no price entered.`;
  if (budget === null || budget <= 0) return { state: 'ok', sentence: `${usd(spent)} so far this month${forecast}.${missing}` };
  const pct = Math.floor((spent / budget) * 100);
  const head = `${usd(spent)} of your ${usd(budget)} budget so far (${pct}%)${forecast}.${missing}`;
  if (spent >= budget) return { state: 'over', sentence: `Budget reached: ${head}` };
  if (fc !== null && basis === 'history' && fc.mid > budget) return { state: 'expected_over', sentence: `Expected to pass your budget by ${end}: ${head}` };
  if (pct >= 80) return { state: 'approaching', sentence: head };
  return { state: 'ok', sentence: head };
}

