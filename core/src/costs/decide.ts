// The cost blocker (step 18): before a step that costs starts, may it run? Pure.
//
// It may when what was used plus the step's high estimate stays inside the owner's limit for the service and, for metered
// dollars (the AI), inside his total monthly budget. Otherwise the step does not run and the reason is a sentence he can
// act on. With `blockWhenOver` off the answer is a warning only (allowed, with the sentence), except the AI limit, which is
// a hard stop whatever the switch says, as `ai.monthlyCapUsd` always was. A limit of his only ever lowers what the app
// spends: nothing here raises a cap, and the reserve and per-scan rules (SearchBudget, TokenBudget) still hold on their own.

import type { CostDecision, CostService, CostUnit } from './types';
import { monthOf, nextMonth, shortDay } from './time';
import { amount, figure, usd } from './words';

/** A step that costs, as the blocker reads it. */
export interface CostStep {
  /** What it is, as the start of a sentence: "Review cards", "The scan's Amazon searches". */
  what: string;
  /** What not running it means, after `what`: "were not written", "were not made". */
  held: string;
  /** What it is expected to use, and the high end of that, in the service's unit. */
  expected: number;
  high: number;
}

/** Where the service stands this month. */
export interface CostRoom {
  service: CostService;
  unit: CostUnit;
  /** "AI", "SerpApi", "Keepa": the limit's name in a sentence. */
  label: string;
  used: number;
  /** The owner's limit, in the unit; null: none of his own. */
  limit: number | null;
  /** The total monthly budget, for metered dollars: what all services cost so far and the budget (null: none set). */
  total?: { spentUsd: number; budgetUsd: number | null };
  blockWhenOver: boolean;
  /** Local "YYYY-MM-DD": the limit renews on the 1st of the next month. */
  today: string;
}

const EPS = 1e-9;

function expectedWords(n: number, unit: CostUnit): string {
  return unit === 'usd' ? `expected to cost about ${usd(n)}` : `expected to use about ${amount(n, unit)}`;
}

function limitLeft(left: number, limit: number, unit: CostUnit, label: string): string {
  if (unit === 'usd') return `${usd(left)} of your ${usd(limit)} ${label} limit is left`;
  return `${figure(left)} of your ${label} limit of ${amount(limit, unit)} ${Math.round(left) === 1 ? 'is' : 'are'} left`;
}

export function decide(service: CostService, step: CostStep, room: CostRoom): CostDecision {
  const base = { service, expected: step.expected, high: step.high, used: room.used, limit: room.limit };
  const overLimit = room.limit !== null && room.used + step.high > room.limit + EPS;
  const budget = room.total?.budgetUsd ?? null;
  const overTotal = !overLimit && room.unit === 'usd' && room.total !== undefined && budget !== null && room.total.spentUsd + step.high > budget + EPS;
  if (!overLimit && !overTotal) return { ...base, allow: true, reason: null };
  const until = shortDay(`${nextMonth(monthOf(room.today))}-01`);
  const why = overLimit
    ? `${limitLeft(Math.max(0, room.limit! - room.used), room.limit!, room.unit, room.label)}. Raise the limit in Costs, or wait until ${until}.`
    : `${usd(Math.max(0, budget! - room.total!.spentUsd))} of your ${usd(budget!)} monthly budget is left. Raise the budget in Costs, or wait until ${until}.`;
  const reason = `${step.what} ${step.held}: ${expectedWords(step.high, room.unit)}, and ${why}`;
  // The AI limit is a hard stop whatever the switch says; everything else is a warning only when the blocker is off.
  const hard = overLimit && service === 'ai';
  if (!room.blockWhenOver && !hard) return { ...base, allow: true, reason: reason.replace(` ${step.held}:`, ' ran past a limit:') };
  return { ...base, allow: false, reason };
}
