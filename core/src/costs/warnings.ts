// The costs' warnings (step 18), once each a month: a service at its warn percent, a forecast that first passes a limit
// before the month ends (with the day), a limit reached; the same three for the total budget. Pure: the agent keeps the
// keys already sent (runtime) and sends what this returns through its notification outbox and Telegram.
// A held step's own message (the blocker) is the agent's: at most one per service per run.

import { shortDay } from './time';
import type { CostService, CostsView } from './types';
import { usd } from './words';

export interface CostWarning {
  /** "2026-11:serpapi:approaching": remembered so the same warning is never sent twice in a month. */
  key: string;
  service: CostService | 'total';
  kind: 'approaching' | 'expected_over' | 'over';
  title: string;
  body: string;
}

const RANK = { approaching: 0, expected_over: 1, over: 2 } as const;

/**
 * The warnings due now that were not sent this month. When several of one service are due at once, only the most serious
 * is returned and the lesser ones' keys come with it (`alsoSent`), so they are not sent later either.
 */
export function costWarnings(view: CostsView, sent: readonly string[]): { warnings: CostWarning[]; alsoSent: string[] } {
  const done = new Set(sent);
  const warnings: CostWarning[] = [];
  const alsoSent: string[] = [];
  const pick = (due: CostWarning[]) => {
    const fresh = due.filter((w) => !done.has(w.key));
    if (fresh.length === 0) return;
    // A warning less serious than one already sent this month says nothing new.
    const top = due.reduce((a, b) => (RANK[b.kind] > RANK[a.kind] ? b : a));
    if (!done.has(top.key)) warnings.push(top);
    for (const w of fresh) if (w !== top) alsoSent.push(w.key);
  };
  for (const s of view.services) {
    const limit = s.limit;
    if (limit === null || limit <= 0) continue;
    const key = (k: string) => `${view.month}:${s.service}:${k}`;
    const due: CostWarning[] = [];
    const pct = Math.floor((s.used / limit) * 100);
    const warnAt = view.settings.services[s.service as 'serpapi' | 'keepa' | 'ai']?.warnAtPercent ?? 80;
    if (pct >= warnAt) due.push({ key: key('approaching'), service: s.service, kind: 'approaching', title: `${s.label}: ${Math.min(pct, 100)}% of your limit used`, body: s.sentence });
    if (s.forecast.basis === 'history' && s.forecast.limitReachedOn !== null && s.used < limit) {
      due.push({
        key: key('expected_over'), service: s.service, kind: 'expected_over', title: `${s.label} is expected to reach your limit on ${shortDay(s.forecast.limitReachedOn)}`,
        body: `${s.forecast.method} Raise the limit in Costs, or the app holds back what would pass it.`,
      });
    }
    if (s.used >= limit) due.push({ key: key('over'), service: s.service, kind: 'over', title: `${s.label}: limit reached`, body: `${s.sentence} What would pass it is held back until next month or a higher limit in Costs.` });
    pick(due);
  }
  const t = view.total;
  if (t.budgetUsd !== null && t.budgetUsd > 0) {
    const key = (k: string) => `${view.month}:total:${k}`;
    const due: CostWarning[] = [];
    if (t.spentUsd >= t.budgetUsd * 0.8) due.push({ key: key('approaching'), service: 'total', kind: 'approaching', title: `Costs: ${Math.min(100, Math.floor((t.spentUsd / t.budgetUsd) * 100))}% of your budget used`, body: t.sentence });
    if (t.state === 'expected_over') due.push({ key: key('expected_over'), service: 'total', kind: 'expected_over', title: `Costs are expected to pass your ${usd(t.budgetUsd)} budget`, body: t.sentence });
    if (t.spentUsd >= t.budgetUsd) due.push({ key: key('over'), service: 'total', kind: 'over', title: 'Costs: budget reached', body: t.sentence });
    pick(due);
  }
  return { warnings, alsoSent };
}

