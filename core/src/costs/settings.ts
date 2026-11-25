// The owner's cost settings (step 18): checked as they come in (PATCH /api/settings `costs`), and the one AI limit.
// Pure.
//
// The AI limit is ONE value: `costs.services.ai.monthlyLimit` is where it lives, and `ai.monthlyCapUsd` (which every AI
// pass, the eBay judge and the briefs have always read) is kept equal to it on every write (syncAiLimit). A store from
// before step 18 moves its cap into the costs once (agent/store.ts, COSTS_AI_LIMIT_MIGRATION).

import { DEFAULT_COST_SETTINGS, type BudgetedService, type CostSettings, type ServiceBudgetSetting } from './types';

export const BUDGETED_SERVICES: readonly BudgetedService[] = ['serpapi', 'keepa', 'ai'];

/** The cost settings of stored settings, with the AI limit read from the AI cap when the store has none yet. */
export function costSettingsOf(app: { costs?: CostSettings; ai: { monthlyCapUsd: number } }): CostSettings {
  const base = structuredClone(app.costs ?? DEFAULT_COST_SETTINGS);
  if (!app.costs) base.services.ai.monthlyLimit = app.ai.monthlyCapUsd;
  return base;
}

/**
 * Keeps the two names of the AI limit equal after a change from `before` to `after`: a changed `ai.monthlyCapUsd` is
 * copied into the costs, else a changed costs AI limit into `ai.monthlyCapUsd`. Returns `after` changed, or as it was.
 */
export function syncAiLimit<T extends { costs?: CostSettings; ai: { monthlyCapUsd: number } }>(before: T, after: T): T {
  const cap = after.ai.monthlyCapUsd;
  const limit = after.costs?.services.ai.monthlyLimit;
  if (cap !== before.ai.monthlyCapUsd || !after.costs) {
    if (after.costs && limit === cap) return after;
    const costs = costSettingsOf({ ai: { monthlyCapUsd: cap }, ...(after.costs ? { costs: after.costs } : {}) });
    costs.services.ai.monthlyLimit = cap;
    return { ...after, costs };
  }
  if (typeof limit === 'number' && limit !== cap) return { ...after, ai: { ...after.ai, monthlyCapUsd: limit } };
  return after;
}

const isMoney = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Applies a `costs` patch to the current cost settings, or says what is wrong in one sentence. Prices and limits are
 * finite and not negative (or null: not entered, no limit); the AI's price stays null (it is metered) and its limit is a
 * number (0 turns the AI off); the warn percent is 50 to 100.
 */
export function patchCostSettings(cur: CostSettings, patch: unknown): { ok: true; value: CostSettings } | { ok: false; error: string } {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return { ok: false, error: 'costs must be a JSON object.' };
  const p = patch as Record<string, unknown>;
  const next = structuredClone(cur);
  if ('totalMonthlyUsd' in p) {
    if (p.totalMonthlyUsd !== null && !isMoney(p.totalMonthlyUsd)) return { ok: false, error: 'costs.totalMonthlyUsd must be dollars of 0 or more, or null for no budget.' };
    next.totalMonthlyUsd = p.totalMonthlyUsd as number | null;
  }
  if ('blockWhenOver' in p) {
    if (typeof p.blockWhenOver !== 'boolean') return { ok: false, error: 'costs.blockWhenOver must be true or false.' };
    next.blockWhenOver = p.blockWhenOver;
  }
  if ('services' in p) {
    const s = p.services;
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return { ok: false, error: 'costs.services must be a JSON object.' };
    for (const [name, v] of Object.entries(s as Record<string, unknown>)) {
      if (!(BUDGETED_SERVICES as readonly string[]).includes(name)) return { ok: false, error: `costs.services.${name} is not a service with a budget (serpapi, keepa, ai).` };
      const service = name as BudgetedService;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: `costs.services.${service} must be a JSON object.` };
      const o = v as Record<string, unknown>;
      const out: ServiceBudgetSetting = { ...next.services[service] };
      const at = `costs.services.${service}`;
      if ('monthlyPriceUsd' in o) {
        if (service === 'ai' && o.monthlyPriceUsd !== null) return { ok: false, error: `${at}.monthlyPriceUsd stays null: the AI is paid by use, counted from each call.` };
        if (o.monthlyPriceUsd !== null && !isMoney(o.monthlyPriceUsd)) return { ok: false, error: `${at}.monthlyPriceUsd must be dollars of 0 or more, or null for not entered.` };
        out.monthlyPriceUsd = o.monthlyPriceUsd as number | null;
      }
      if ('monthlyLimit' in o) {
        if (service === 'ai' && !isMoney(o.monthlyLimit)) return { ok: false, error: `${at}.monthlyLimit must be dollars of 0 or more (0 turns the AI off).` };
        if (o.monthlyLimit !== null && !isMoney(o.monthlyLimit)) return { ok: false, error: `${at}.monthlyLimit must be a number of 0 or more, or null for no limit of your own.` };
        out.monthlyLimit = o.monthlyLimit as number | null;
      }
      if ('warnAtPercent' in o) {
        const w = o.warnAtPercent;
        if (typeof w !== 'number' || !Number.isFinite(w) || w < 50 || w > 100) return { ok: false, error: `${at}.warnAtPercent must be from 50 to 100.` };
        out.warnAtPercent = w;
      }
      next.services[service] = out;
    }
  }
  return { ok: true, value: next };
}
