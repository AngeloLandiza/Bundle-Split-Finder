// What the Costs screen says and draws, as pure functions of the agent's CostsView (core/src/costs/types.ts): the
// sentences, the chart's scales and paths, the sliders' ranges and how a slider and its number stay one value, the
// words for a change and its undo, and which state becomes a notice. Nothing here fetches, reads the clock, or fills a
// missing figure in: a price nobody entered is "not entered", never $0 (CLAUDE.md rule 4).

import type { BudgetedService, CostDay, CostSettings, CostService, CostState, CostUnit, CostsView, ServiceBudgetSetting, ServiceCost } from '@core/costs/types';
import { count, money, plural } from './format';
import { niceScale, niceStep } from './chart';

export const BUDGETED: readonly BudgetedService[] = ['serpapi', 'keepa', 'ai'];
const FALLBACK_LABEL: Record<CostService, string> = { serpapi: 'SerpApi', keepa: 'Keepa', ai: 'AI', ebay: 'eBay', telegram: 'Telegram', amazon: 'Amazon seller API' };

export const isBudgeted = (s: CostService): s is BudgetedService => (BUDGETED as readonly string[]).includes(s);

/** The label the agent gave a service, or ours when the view does not carry it. */
export function labelOf(view: Pick<CostsView, 'services'>, service: CostService): string {
  return view.services.find((s) => s.service === service)?.label ?? FALLBACK_LABEL[service];
}

// ---------------------------------------------------------------- amounts and sentences

const NOUN: Record<Exclude<CostUnit, 'usd'>, [string, string]> = {
  searches: ['search', 'searches'],
  tokens: ['Keepa token', 'Keepa tokens'],
  calls: ['call', 'calls'],
  messages: ['message', 'messages'],
};

/** "150 searches", "$25.00", "1,180 Keepa tokens": a figure in the service's own unit. */
export function amount(n: number, unit: CostUnit): string {
  if (unit === 'usd') return money(n);
  const [one, many] = NOUN[unit];
  return plural(Math.round(n), one, many);
}

/** The unit's word alone, for after a figure that is already written ("about 96 of 150 searches"). */
export const unitNoun = (unit: CostUnit): string => (unit === 'usd' ? '' : NOUN[unit][1]);

/** Whole dollars from ten up ("$19"), cents below it ("$4.12"): a forecast is not exact to the cent. */
export function usdRound(n: number): string {
  return n >= 10 ? `$${count(Math.round(n))}` : money(n);
}

const unitFigure = (n: number, unit: CostUnit): string => (unit === 'usd' ? usdRound(n) : count(Math.round(n)));

/**
 * "about 96 of 150 searches; between 80 and 120" in the service's own unit. A range only when its two ends read differently.
 * When the forecast rests on settings (too little history) it is a bound, not a prediction: "at most about 96 ... at your current schedule and limits".
 */
export function forecastWords(s: ServiceCost): string {
  const f = s.forecast;
  if (f.basis === 'none') return 'Nothing to forecast: no use yet and nothing scheduled.';
  const limit = s.limit ?? s.planLimit;
  const noun = unitNoun(s.unit);
  const of = `${limit !== null ? ` of ${unitFigure(limit, s.unit)}` : ''}${noun ? ` ${noun}` : ''}`;
  if (f.basis === 'settings') return `at most about ${unitFigure(f.expected, s.unit)}${of} at your current schedule and limits`;
  const range = unitFigure(f.low, s.unit) === unitFigure(f.high, s.unit) ? '' : `; between ${unitFigure(f.low, s.unit)} and ${unitFigure(f.high, s.unit)}`;
  return `about ${unitFigure(f.expected, s.unit)}${of}${range}`;
}

/** The month's forecast in dollars as the headline, the chart's end label and the summary read it. Null when there is none. */
export function totalForecast(view: CostsView): { mid: number; bound: boolean; range: { low: number; high: number } | null } | null {
  const t = view.total;
  if (t.forecastUsd === null) return null;
  const live = view.services.filter((s) => s.forecast.basis !== 'none');
  const bound = live.length > 0 && live.every((s) => s.forecast.basis === 'settings');
  const lo = t.forecastLowUsd;
  const hi = t.forecastHighUsd;
  // "between $30 and $30" is not a range: with the same figure at both ends there is none.
  const range = !bound && lo !== null && hi !== null && usdRound(lo) !== usdRound(hi) ? { low: lo, high: hi } : null;
  return { mid: t.forecastUsd, bound, range };
}

/** What the headline says about the dollars: so far, the forecast (a bound when it rests on settings), and the total budget. */
export function moneySentence(view: CostsView): string {
  const t = view.total;
  const f = totalForecast(view);
  const N = daysInMonth(view.month);
  let s = `${money(t.spentUsd)} so far this month`;
  if (f) {
    s += `; ${f.bound ? 'at most about' : 'expected about'} ${usdRound(f.mid)} by ${dayLabel(view.month, N)}${f.bound ? ' at your current schedule and limits' : ''}${f.range ? ` (between ${usdRound(f.range.low)} and ${usdRound(f.range.high)})` : ''}`;
  }
  if (t.budgetUsd === null) return `${s}, and no total budget is set.`;
  const end = f ? f.mid : t.spentUsd;
  return `${s}, ${end <= t.budgetUsd ? 'inside' : 'over'} your ${usdRound(t.budgetUsd)} total.`;
}

/** The service name as a sentence starts with it: "AI (Anthropic)" reads "AI". */
export const shortLabel = (s: Pick<ServiceCost, 'label'>): string => s.label.replace(/\s*\(.*\)\s*$/, '');

export interface Trouble {
  service: CostService;
  label: string;
  state: Exclude<CostState, 'ok'>;
  /** The agent's own sentence for the state. */
  sentence: string;
  /** What was held back, in plain words, when something was. */
  heldBack: string | null;
}

/** The services that are not fine, worst first (the order of the view breaks a tie): the list under the headline. */
export function troubles(view: CostsView): Trouble[] {
  return view.services
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.state !== 'ok')
    .sort((a, b) => SEVERITY[b.s.state] - SEVERITY[a.s.state] || a.i - b.i)
    .map(({ s }) => ({
      service: s.service,
      label: s.label,
      state: s.state as Exclude<CostState, 'ok'>,
      sentence: s.sentence,
      heldBack: s.blocked.length ? `Held back: ${s.blocked.map((b) => b.what).join('; ')}.` : null,
    }));
}

/**
 * The headline's first sentence when a service is not fine: the worst one, in words ("AI is at 97% of its limit. Held back:
 * Review cards."), so the first thing on the screen is the trouble, not "inside your budget". Null when every service is fine.
 */
export function troubleLead(view: CostsView): string | null {
  const first = troubles(view)[0];
  if (!first) return null;
  const s = view.services.find((x) => x.service === first.service)!;
  const name = shortLabel(s);
  const cap = s.limit ?? s.planLimit;
  const pct = cap && cap > 0 ? Math.round((s.used / cap) * 100) : null;
  const reach = s.forecast.limitReachedOn;
  let lead: string;
  switch (first.state) {
    case 'over':
      lead = `${name} is at its limit.`;
      break;
    case 'expected_over':
      lead = reach ? `${name} is expected to reach its limit on ${dayLabel(reach.slice(0, 7), dayOf(reach))}.` : `${name} is expected to pass its limit this month.`;
      break;
    case 'approaching':
      lead = `${name} is nearing its limit${pct !== null ? ` (${pct}%)` : ''}.`;
      break;
    default:
      lead = pct !== null ? `${name} is at ${pct}% of its limit.` : `${name} had something held back.`;
  }
  const more = troubles(view).length - 1;
  return `${lead}${first.heldBack ? ` ${first.heldBack}` : ''}${more > 0 ? ` ${more === 1 ? '1 other service needs a look' : `${more} other services need a look`}.` : ''}`;
}

/** What the service costs: "$0.00 a month: free plan", "Price not entered", "$4.12 so far". `missing` marks the price nobody entered. */
export function costWords(s: ServiceCost): { text: string; missing: boolean } {
  if (s.unit === 'usd') {
    const so = `${money(s.meteredUsd)} so far`;
    return { text: s.forecastUsd !== null && s.forecastUsd > s.meteredUsd ? `${so}, about ${usdRound(s.forecastUsd)} by month end` : so, missing: false };
  }
  if (s.service === 'ebay' || s.service === 'telegram' || s.service === 'amazon') return { text: 'Free', missing: false };
  if (s.monthlyPriceUsd === null) return { text: 'Price not entered', missing: true };
  if (s.monthlyPriceUsd === 0) return { text: '$0.00 a month: free plan', missing: false };
  return { text: `${money(s.monthlyPriceUsd)} a month`, missing: false };
}

/** The services whose price is missing, in words, right under the answer: "Keepa's monthly price is not entered, so it is not in these totals." */
export function unpricedSentence(view: CostsView): string | null {
  const names = view.total.unpriced.map((s) => labelOf(view, s));
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]}’s monthly price is not entered, so it is not in these totals.`;
  const last = names[names.length - 1];
  return `${names.slice(0, -1).join(', ')} and ${last}: their monthly prices are not entered, so they are not in these totals.`;
}

/** The warn mark's place on a meter, 0..1; null when there is no limit to be a share of. */
export function meterOf(s: ServiceCost, warnAtPercent: number): { value: number; max: number; warnAt: number } | null {
  const max = s.limit ?? s.planLimit;
  if (max === null || !(max > 0)) return null;
  return { value: s.used, max, warnAt: Math.max(0, Math.min(1, warnAtPercent / 100)) };
}

/** A word and a mark for each state: the state is never colour alone. `mark` picks the glyph (a check for fine, the warning otherwise). */
export const STATE_WORDS: Record<CostState, string> = {
  ok: 'Within its limit',
  approaching: 'Approaching its limit',
  expected_over: 'Expected to pass its limit',
  over: 'At its limit',
  blocked: 'Something was held back',
};
export const stateMark = (s: CostState): 'check' | 'warning' => (s === 'ok' ? 'check' : 'warning');
export const SEVERITY: Record<CostState, number> = { ok: 0, approaching: 1, expected_over: 2, over: 3, blocked: 4 };

/** A service with no limit of its own and no plan limit has nothing to be within: its state says so. */
export function stateLabel(s: ServiceCost): string {
  if (s.state === 'ok' && s.limit === null && s.planLimit === null) return s.unit === 'usd' ? 'No limit set' : 'No limit';
  return STATE_WORDS[s.state];
}

// ---------------------------------------------------------------- the limits: range, and a slider that is one value with its field

export interface SliderRange {
  min: number;
  max: number;
  step: number;
}

const stepOfMax = (max: number): number => (max <= 100 ? 1 : max <= 1000 ? 5 : 25);
const ceilTo = (n: number, to: number): number => Math.ceil(n / to) * to;

/**
 * What each slider spans: searches up to the plan's limit (250 when the plan is not known), Keepa tokens up to the
 * monthly ceiling the account check gave, AI dollars 0 to 100, the total budget in fives up to well past the forecast.
 * A value the owner typed above the end stretches the range; the slider never lies about a saved figure.
 */
export function limitRange(key: BudgetedService | 'total', view: CostsView): SliderRange {
  const svc = key === 'total' ? null : view.services.find((s) => s.service === key);
  const current = key === 'total' ? view.settings.totalMonthlyUsd : view.settings.services[key].monthlyLimit;
  let max: number;
  let step: number;
  if (key === 'serpapi') {
    max = svc?.planLimit ?? 250;
    max = Math.max(max, current ?? 0);
    step = stepOfMax(max);
  } else if (key === 'keepa') {
    max = Math.max(svc?.planLimit ?? Math.max(10_000, (svc?.used ?? 0) * 2), current ?? 0);
    step = Math.max(1, niceStep(max, 100));
  } else if (key === 'ai') {
    max = Math.max(100, current ?? 0);
    step = 1;
  } else {
    max = Math.max(200, ceilTo((view.total.forecastHighUsd ?? view.total.spentUsd) * 2, 50), current ?? 0);
    step = 5;
  }
  return { min: 0, max, step };
}

const unitOfKey = (key: BudgetedService | 'total', view: CostsView): CostUnit => (key === 'total' ? 'usd' : (view.services.find((s) => s.service === key)?.unit ?? 'usd'));

export type LimitInput = { ok: true; value: number } | { ok: false; message: string };

/** What was typed in a limit's number field: a figure or a sentence on why not. Counts are whole; dollars are to the cent. */
export function limitInput(raw: string, unit: CostUnit): LimitInput {
  const t = raw.trim();
  if (t === '') return { ok: false, message: 'Enter a number, or choose No limit.' };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, message: 'Enter a number.' };
  if (n < 0) return { ok: false, message: 'A limit cannot be below 0.' };
  if (n > 10_000_000) return { ok: false, message: 'That is more than any plan allows.' };
  return { ok: true, value: unit === 'usd' ? Math.round(n * 100) / 100 : Math.round(n) };
}

/** A figure from the slider: snapped to its step inside its range. */
export function snap(v: number, r: SliderRange): number {
  const k = Math.round((v - r.min) / r.step);
  return Math.max(r.min, Math.min(r.max, Math.round((r.min + k * r.step) * 1e6) / 1e6));
}

/** Where the slider's thumb sits for a value: a value beyond the range pegs at the end (the number field still holds it). */
export const sliderAt = (value: number, r: SliderRange): number => Math.max(r.min, Math.min(r.max, value));

/** The text a number field shows for a value: whole counts, dollars without a trailing zero run ("25", "12.5"). */
export const fieldText = (value: number | null): string => (value === null ? '' : String(value));

/**
 * One value, two controls: typing in the field or moving the slider both land here, and what the other control shows
 * follows. `value` is what to save (null = the field is not valid yet, nothing to save); `text` is the field; `thumb` the slider.
 */
export function syncLimit(from: { by: 'slider'; value: number } | { by: 'field'; text: string }, range: SliderRange, unit: CostUnit): { value: number | null; text: string; thumb: number; error: string | null } {
  if (from.by === 'slider') {
    const v = snap(from.value, range);
    return { value: v, text: fieldText(v), thumb: v, error: null };
  }
  const r = limitInput(from.text, unit);
  if (!r.ok) return { value: null, text: from.text, thumb: range.min, error: r.message };
  return { value: r.value, text: from.text, thumb: sliderAt(r.value, range), error: null };
}

/** What "No limit" is turned back off to: the plan's own limit when there is one, else a figure the slider can start from. */
export function limitToStartAt(key: BudgetedService | 'total', view: CostsView): number {
  const r = limitRange(key, view);
  const svc = key === 'total' ? null : view.services.find((s) => s.service === key);
  if (key === 'ai') return 25;
  if (key === 'total') return Math.max(snap(Math.ceil((view.total.forecastHighUsd ?? 0) / 5) * 5, r), 40);
  return snap(svc?.planLimit ?? Math.max(svc?.used ?? 0, r.max / 2), r);
}

export const rangeUnit = unitOfKey;

/**
 * What a limit means for the month: set below what is already used, the rest of the month's spending stops; set under the
 * forecast, some steps may be held back. Null when nothing needs saying.
 */
export function limitNote(s: ServiceCost, limit: number | null, blockWhenOver: boolean): string | null {
  if (limit === null) return s.planLimit !== null ? `The plan’s own limit of ${amount(s.planLimit, s.unit)} still holds.` : null;
  if (s.used >= limit) {
    return blockWhenOver
      ? `Already at ${amount(s.used, s.unit)}; nothing more will be spent this month.`
      : `Already at ${amount(s.used, s.unit)}. Holding back is off, so you are warned but nothing is stopped.`;
  }
  if (s.forecast.basis !== 'none' && s.forecast.expected > limit) {
    return blockWhenOver
      ? `About ${amount(s.forecast.expected, s.unit)} are expected by month end, so some steps will be held back.`
      : `About ${amount(s.forecast.expected, s.unit)} are expected by month end, so you will be warned.`;
  }
  return null;
}

// ---------------------------------------------------------------- settings: one field at a time, with its patch, words and undo

export type CostField = { kind: 'limit'; service: BudgetedService } | { kind: 'warn'; service: BudgetedService } | { kind: 'price'; service: BudgetedService } | { kind: 'total' } | { kind: 'block' };
export type CostValue = number | boolean | null;

/** What PATCH /api/settings takes under `costs`: only what changed; null clears a limit, a price or the total. */
export interface CostSettingsPatch {
  totalMonthlyUsd?: number | null;
  blockWhenOver?: boolean;
  services?: Partial<Record<BudgetedService, Partial<ServiceBudgetSetting>>>;
}

export const fieldKey = (f: CostField): string => (f.kind === 'total' || f.kind === 'block' ? f.kind : `${f.kind}:${f.service}`);

export function readField(s: CostSettings, f: CostField): CostValue {
  switch (f.kind) {
    case 'limit':
      return s.services[f.service].monthlyLimit;
    case 'warn':
      return s.services[f.service].warnAtPercent;
    case 'price':
      return s.services[f.service].monthlyPriceUsd;
    case 'total':
      return s.totalMonthlyUsd;
    case 'block':
      return s.blockWhenOver;
  }
}

export function patchOf(f: CostField, v: CostValue): CostSettingsPatch {
  switch (f.kind) {
    case 'limit':
      return { services: { [f.service]: { monthlyLimit: v as number | null } } };
    case 'warn':
      return { services: { [f.service]: { warnAtPercent: v as number } } };
    case 'price':
      return { services: { [f.service]: { monthlyPriceUsd: v as number | null } } };
    case 'total':
      return { totalMonthlyUsd: v as number | null };
    case 'block':
      return { blockWhenOver: v as boolean };
  }
}

/** The settings with one field changed (a new object; the old one is the undo's "before"). */
export function withField(s: CostSettings, f: CostField, v: CostValue): CostSettings {
  switch (f.kind) {
    case 'total':
      return { ...s, totalMonthlyUsd: v as number | null };
    case 'block':
      return { ...s, blockWhenOver: v as boolean };
    default: {
      const key = f.kind === 'limit' ? 'monthlyLimit' : f.kind === 'warn' ? 'warnAtPercent' : 'monthlyPriceUsd';
      return { ...s, services: { ...s.services, [f.service]: { ...s.services[f.service], [key]: v } } };
    }
  }
}

/** Two patches as one: later values win, object by object. */
export function mergeCostPatch(a: CostSettingsPatch, b: CostSettingsPatch): CostSettingsPatch {
  const services: NonNullable<CostSettingsPatch['services']> = { ...(a.services ?? {}) };
  for (const k of Object.keys(b.services ?? {}) as BudgetedService[]) services[k] = { ...(services[k] ?? {}), ...(b.services?.[k] ?? {}) };
  return { ...a, ...(b.totalMonthlyUsd !== undefined ? { totalMonthlyUsd: b.totalMonthlyUsd } : {}), ...(b.blockWhenOver !== undefined ? { blockWhenOver: b.blockWhenOver } : {}), ...(Object.keys(services).length ? { services } : {}) };
}

/** One sentence for a change, as it reads next to its Undo. */
export function describeChange(f: CostField, before: CostValue, after: CostValue, view: Pick<CostsView, 'services'>): string {
  const num = (v: CostValue): number | null => (typeof v === 'number' ? v : null);
  switch (f.kind) {
    case 'limit': {
      const unit = view.services.find((s) => s.service === f.service)?.unit ?? 'usd';
      const w = (v: CostValue) => (num(v) === null ? 'no limit' : amount(num(v)!, unit));
      return `${labelOf(view, f.service)} limit changed from ${w(before)} to ${w(after)}.`;
    }
    case 'warn':
      return `${labelOf(view, f.service)} warning moved from ${before}% to ${after}% of its limit.`;
    case 'price': {
      const w = (v: CostValue) => (num(v) === null ? 'not entered' : `${money(num(v)!)} a month`);
      return `${labelOf(view, f.service)} price changed from ${w(before)} to ${w(after)}.`;
    }
    case 'total': {
      const w = (v: CostValue) => (num(v) === null ? 'no budget' : money(num(v)!));
      return `Total budget changed from ${w(before)} to ${w(after)}.`;
    }
    case 'block':
      return after === true ? 'Anything expected to pass a limit will be held back.' : 'Steps expected to pass a limit will run; you are warned instead.';
  }
}

// ---------------------------------------------------------------- the chart

export interface ChartBox {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
}

export interface ChartPoint {
  day: number;
  date: string;
  cum: number;
  x: number;
  y: number;
}

export interface ChartLabel {
  key: 'so-far' | 'forecast' | 'range' | 'budget' | 'today';
  text: string;
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
}

export interface ChartGeometry {
  box: ChartBox;
  monthDays: number;
  x: (day: number) => number;
  y: (usd: number) => number;
  yTicks: { usd: number; y: number; label: string }[];
  xTicks: { day: number; x: number; label: string }[];
  points: ChartPoint[];
  /** The solid line so far, or '' while there is one day (a dot is drawn instead). */
  solid: string;
  /** The dashed forecast from today to month end, or null when it cannot be drawn (no forecast, or the month is over). */
  dashed: string | null;
  /** The low-to-high wedge from today's point to the month's last day, or null. */
  band: string | null;
  budget: { y: number; x1: number; x2: number } | null;
  today: ChartPoint;
  labels: ChartLabel[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11" gives 30. */
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(y ?? 2000, m ?? 1, 0).getDate();
}

/** "Nov 14" for a day of "2026-11". */
export function dayLabel(month: string, day: number): string {
  return `${MONTHS[(Number(month.slice(5, 7)) || 1) - 1]} ${day}`;
}

/** The day of the month in "2026-11-14". */
export const dayOf = (date: string): number => Number(date.slice(8, 10));

const fixed = (n: number): string => n.toFixed(1);

/** Whole dollars on an axis or an end label: "$20". Under $10 keeps cents so $0.40 is not "$0". */
export const axisUsd = (n: number): string => (Math.abs(n) >= 10 || Number.isInteger(n) ? `$${count(Math.round(n))}` : money(n));

/**
 * The chart's geometry: the days so far as a solid cumulative line, the forecast from today to month end as a dashed
 * line with its range as a wedge, the budget as a rule, today marked. Null when there are no days to draw (the agent
 * has nothing yet). The forecast is drawn only when the agent gave one: nothing is extrapolated here.
 */
export function costChart(view: CostsView, box: ChartBox): ChartGeometry | null {
  const days = [...view.days].sort((a, b) => a.date.localeCompare(b.date));
  if (days.length === 0) return null;
  const N = daysInMonth(view.month);
  const plotW = Math.max(1, box.width - box.margin.left - box.margin.right);
  const plotH = Math.max(1, box.height - box.margin.top - box.margin.bottom);
  const x = (d: number): number => box.margin.left + (N <= 1 ? 0 : ((Math.min(N, Math.max(1, d)) - 1) / (N - 1)) * plotW);

  const last = days[days.length - 1]!;
  const total = view.total;
  const hasForecast = total.forecastUsd !== null && dayOf(last.date) < N;
  const hi = Math.max(1, last.cumulativeUsd, hasForecast ? (total.forecastHighUsd ?? total.forecastUsd ?? 0) : 0, total.budgetUsd ?? 0);
  const scale = niceScale(0, hi, 3);
  const y = (usd: number): number => box.margin.top + plotH - ((usd - scale.min) / (scale.max - scale.min)) * plotH;

  const points: ChartPoint[] = days.map((d) => ({ day: dayOf(d.date), date: d.date, cum: d.cumulativeUsd, x: x(dayOf(d.date)), y: y(d.cumulativeUsd) }));
  const today = points[points.length - 1]!;
  const solid = points.length > 1 ? points.map((p, i) => `${i ? 'L' : 'M'}${fixed(p.x)} ${fixed(p.y)}`).join('') : '';

  let dashed: string | null = null;
  let band: string | null = null;
  const labels: ChartLabel[] = [];
  if (hasForecast) {
    const ex = x(N);
    const mid = total.forecastUsd!;
    dashed = `M${fixed(today.x)} ${fixed(today.y)}L${fixed(ex)} ${fixed(y(mid))}`;
    const tf = totalForecast(view);
    if (tf?.range) {
      band = `M${fixed(today.x)} ${fixed(today.y)}L${fixed(ex)} ${fixed(y(tf.range.high))}L${fixed(ex)} ${fixed(y(tf.range.low))}Z`;
      labels.push({ key: 'range', text: `${axisUsd(tf.range.low)} to ${axisUsd(tf.range.high)}`, x: ex + 6, y: y(mid) + 12, anchor: 'start' });
    }
    labels.push({ key: 'forecast', text: `${tf?.bound ? 'at most ' : 'about '}${axisUsd(mid)}`, x: ex + 6, y: y(mid) + 1, anchor: 'start' });
  }
  const nearLeft = today.x - box.margin.left < 56;
  labels.push({ key: 'so-far', text: money(last.cumulativeUsd), x: today.x + (nearLeft ? 4 : -4), y: today.y + 16, anchor: nearLeft ? 'start' : 'end' });
  labels.push({ key: 'today', text: 'Today', x: today.x, y: box.margin.top - 4, anchor: today.x > box.width - box.margin.right - 20 ? 'end' : 'middle' });

  let budget: ChartGeometry['budget'] = null;
  if (total.budgetUsd !== null) {
    budget = { y: y(total.budgetUsd), x1: box.margin.left, x2: box.margin.left + plotW };
    labels.push({ key: 'budget', text: `Budget ${axisUsd(total.budgetUsd)}`, x: box.margin.left + 4, y: budget.y - 5, anchor: 'start' });
  }

  const tickDays = N >= 3 ? [1, Math.round((1 + N) / 2), N] : [1, N];
  return {
    box,
    monthDays: N,
    x,
    y,
    yTicks: scale.ticks.map((t) => ({ usd: t, y: y(t), label: axisUsd(t) })),
    xTicks: [...new Set(tickDays)].map((d) => ({ day: d, x: x(d), label: dayLabel(view.month, d) })),
    points,
    solid,
    dashed,
    band,
    budget,
    today,
    labels,
  };
}

/** The point nearest a pointer position, by x. */
export function nearestPoint(g: ChartGeometry, px: number): number {
  let best = 0;
  g.points.forEach((p, i) => {
    if (Math.abs(p.x - px) < Math.abs(g.points[best]!.x - px)) best = i;
  });
  return best;
}

/** What hover or focus on one day reads: its dollars by service, then the month so far. */
export function dayReadout(view: CostsView, index: number): string {
  const d = [...view.days].sort((a, b) => a.date.localeCompare(b.date))[index];
  if (!d) return '';
  const parts = view.services
    .filter((s) => isBudgeted(s.service))
    .map((s) => `${s.label} ${money(d.byService[s.service] ?? 0)}`);
  return `${dayLabel(view.month, dayOf(d.date))}: ${money(d.usd)} that day (${parts.join(', ')}); ${money(d.cumulativeUsd)} so far this month.`;
}

/** The text alternative: the three figures a sighted reader gets from the end labels and the rule. */
export function chartSummary(view: CostsView): string {
  const last = [...view.days].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  const t = view.total;
  const parts = [`Dollars this month: ${money(t.spentUsd)} so far${last ? ` on ${dayLabel(view.month, dayOf(last.date))}` : ''}.`];
  const f = totalForecast(view);
  if (f) {
    parts.push(`${f.bound ? 'At most about' : 'Expected about'} ${usdRound(f.mid)} by the end of the month${f.bound ? ' at your current schedule and limits' : ''}${f.range ? `, between ${usdRound(f.range.low)} and ${usdRound(f.range.high)}` : ''}.`);
  } else parts.push('There is no forecast yet.');
  parts.push(t.budgetUsd !== null ? `Your total budget is ${money(t.budgetUsd)}.` : 'No total budget is set.');
  return parts.join(' ');
}

/** The line under the chart: how the forecast was made, and that it is an estimate. */
export function forecastNote(view: CostsView): string {
  const live = view.services.filter((s) => s.forecast.basis !== 'none');
  if (live.length === 0) return 'No forecast yet: nothing has been used this month and nothing is scheduled. Any forecast is an estimate, not a bill.';
  // The chart is in dollars, so its note is the method of what drives the dollars (the metered service); each service's
  // own method belongs to its row. On the owner's real screen (Nov 25) every service's sentence was joined here and the
  // same "Only 2 days of history…" opening read three times over.
  const dollars = live.filter((s) => s.unit === 'usd');
  const methods = [...new Set((dollars.length ? dollars : live).map((s) => s.forecast.method.trim()).filter(Boolean))];
  const onSettings = live.every((s) => s.forecast.basis === 'settings');
  // A method on settings already opens with why (too little history), so nothing is put in front of it.
  return `${methods.join(' ')} ${onSettings ? 'It is a bound, not a bill.' : 'The forecast is an estimate, not a bill.'}`.replace(/\s+/g, ' ').trim();
}

export interface NumbersTable {
  head: string[];
  rows: string[][];
  /** The forecast and the budget, as plain lines under the table. */
  lines: string[];
}

/** The chart's numbers for anyone who cannot read it: a row a day, dollars by service. */
export function numbersTable(view: CostsView): NumbersTable {
  const cols = view.services.filter((s) => isBudgeted(s.service));
  const rows = [...view.days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => [dayLabel(view.month, dayOf(d.date)), ...cols.map((s) => money(d.byService[s.service] ?? 0)), money(d.usd), money(d.cumulativeUsd)]);
  const t = view.total;
  const lines: string[] = [];
  if (t.forecastUsd !== null) lines.push(`Month end, expected: ${money(t.forecastUsd)}${t.forecastLowUsd !== null && t.forecastHighUsd !== null ? `, between ${money(t.forecastLowUsd)} and ${money(t.forecastHighUsd)}` : ''}.`);
  lines.push(t.budgetUsd !== null ? `Total budget: ${money(t.budgetUsd)}.` : 'Total budget: not set.');
  lines.push(`Fixed prices so far: ${money(t.fixedUsd)}. Metered so far: ${money(t.meteredUsd)}.`);
  return { head: ['Day', ...cols.map((s) => s.label), 'That day', 'So far'], rows, lines };
}

// ---------------------------------------------------------------- the daily strip

export interface StripBar {
  date: string;
  used: number;
  x: number;
  width: number;
  height: number;
}

/** One bar a day across the month so far; zero days draw nothing (a gap, not a hairline); the tallest fills the height. */
export function stripBars(days: readonly CostDay[], monthDays: number, w: number, h: number): { bars: StripBar[]; peak: { used: number; date: string } | null } {
  const slot = w / Math.max(1, monthDays);
  const width = Math.max(1, slot - 1);
  const peakDay = days.reduce<CostDay | null>((p, d) => (d.used > (p?.used ?? 0) ? d : p), null);
  const max = peakDay?.used ?? 0;
  const bars = days
    .filter((d) => d.used > 0)
    .map((d) => {
      const height = Math.max(1, Math.round((d.used / max) * h));
      return { date: d.date, used: d.used, x: (dayOf(d.date) - 1) * slot, width, height };
    });
  return { bars, peak: peakDay ? { used: peakDay.used, date: peakDay.date } : null };
}

// ---------------------------------------------------------------- the notice

export interface CostNotice {
  state: Exclude<CostState, 'ok'>;
  tone: 'quiet' | 'attention';
  title: string;
  body: string;
  /** Which service it is about, or null for the month's total budget. */
  service: CostService | null;
}

/**
 * The one warning the notice region shows, from the view's states: the worst across the services and the total
 * (held back, then over, then expected to pass, then approaching), the lowest-noise wording for it. Approaching is quiet;
 * the rest need him. Null when everything is fine.
 */
export function costNotice(view: CostsView | null): CostNotice | null {
  if (!view) return null;
  let best: { state: CostState; s: ServiceCost | null } = { state: view.total.state, s: null };
  for (const s of view.services) if (SEVERITY[s.state] > SEVERITY[best.state]) best = { state: s.state, s };
  if (best.state === 'ok') return null;
  const state = best.state;
  const tone = state === 'approaching' ? 'quiet' : 'attention';
  const s = best.s;
  if (!s) {
    const title = state === 'over' ? 'The month is over your budget.' : state === 'expected_over' ? 'The month is expected to pass your budget.' : state === 'blocked' ? 'Something was held back to stay inside your budget.' : 'The month is nearing your budget.';
    return { state, tone, title, body: moneySentence(view), service: null };
  }
  const name = s.label;
  switch (state) {
    case 'blocked': {
      const b = s.blocked[0];
      const more = s.blocked.length > 1 ? ` ${s.blocked.length - 1} more held back.` : '';
      return { state, tone, title: `${name}: something was held back.`, body: b ? `${b.what}. ${b.why}${more}` : s.sentence, service: s.service };
    }
    case 'over':
      return { state, tone, title: `${name} is at its limit.`, body: `${s.sentence} Nothing more will be spent on it this month.`, service: s.service };
    case 'expected_over':
      return { state, tone, title: s.forecast.limitReachedOn ? `${name} is expected to reach its limit on ${dayLabel(s.forecast.limitReachedOn.slice(0, 7), dayOf(s.forecast.limitReachedOn))}.` : `${name} is expected to pass its limit this month.`, body: s.sentence, service: s.service };
    default:
      return { state, tone, title: `${name} is nearing its limit.`, body: s.sentence, service: s.service };
  }
}
