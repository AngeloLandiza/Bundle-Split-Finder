// Step 18: what the services cost, in the agent. The costs view (GET /api/costs and /api/state's short form) is built here
// from the data folder's ledgers, Activity's runs, the suggestions and the settings; the cost blocker's answer for a step
// (decide) and its record (hold); the warnings due (due). The numbers are core/src/costs; this file only reads and keeps.
// No network, no key: the ledgers never hold one.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentState } from '../core/src/api/contract';
import { decide as decideStep, type CostRoom, type CostStep } from '../core/src/costs/decide';
import { HISTORY_WINDOW_DAYS, MIN_HISTORY_RUNS } from '../core/src/costs/forecast';
import { costSettingsOf } from '../core/src/costs/settings';
import { addDays, localDate, monthOf, previousMonth } from '../core/src/costs/time';
import type { CostDecision, CostService, CostsView } from '../core/src/costs/types';
import { parseKeepaLedger, type KeepaLedgerRow } from '../core/src/costs/usage';
import { buildCostsView, type CostsInput } from '../core/src/costs/view';
import { costWarnings, type CostWarning } from '../core/src/costs/warnings';
import { parseLedger } from '../core/src/serpapi/balance';
import type { CostRuntime, Store, StoreData } from './store';

export const SERP_LEDGER_FILE = 'serpapi-ledger.jsonl';
export const KEEPA_LEDGER_FILE = 'keepa-ledger.jsonl';

const KEEP_BLOCKED = 50;
const KEEP_COUNT_DAYS = 400;

/** The AI's name in the costs: its provider when every pipeline has the same one. */
export function aiLabel(ai: StoreData['settings']['ai']): string {
  const providers = new Set([ai.judge, ai.assist, ai.research, ...(ai.brief ? [ai.brief] : [])].map((p) => p.provider));
  if (providers.size !== 1) return 'AI';
  return providers.has('anthropic') ? 'AI (Anthropic)' : 'AI (OpenAI-compatible)';
}

const emptyRuntime = (): CostRuntime => ({ sent: [], blocked: {}, counts: {} });

/** The costs' inputs from a data folder's store collections and ledger texts (also what `npm run costs` reads). */
export function costsInputOf(data: Pick<StoreData, 'settings' | 'runtime' | 'suggestions' | 'activity'>, ledgers: { serp: { at: string }[]; keepa: KeepaLedgerRow[] }, now: number, tz?: string): CostsInput {
  const app = data.settings;
  const rt = data.runtime;
  const lookups = app.lookups;
  // The listing check's searches a day (rung 2): its own setting, or automatic (at most 5), or none when it is off.
  const verifyPerDay = lookups?.autoVerify === false ? 0 : lookups?.verifySearchesPerDay ?? 5;
  return {
    now, ...(tz ? { tz } : {}),
    settings: costSettingsOf(app),
    schedule: app.settings.schedule,
    lastScheduledRunAt: rt.lastScheduledRunAt,
    caps: { searchesPerScan: app.settings.searchesPerScan, verifySearchesPerDay: verifyPerDay },
    serp: { rows: ledgers.serp, plan: rt.serp ? { perMonth: rt.serp.perMonth, planName: rt.serp.planName ?? null } : null },
    keepa: { rows: ledgers.keepa, refillPerMin: rt.keepa?.refillRate ?? null },
    ai: { suggestions: data.suggestions, runs: data.activity.runs, label: aiLabel(app.ai) },
    counts: rt.costs?.counts ?? {},
    runs: data.activity.runs,
    blocked: rt.costs?.blocked ?? {},
  };
}

/** The percentiles of what past scans used of one service: the median and the 90th, or null below MIN_HISTORY_RUNS scans. */
export function scanHistory(runs: StoreData['activity']['runs'], pick: (r: StoreData['activity']['runs'][number]) => number, now: number): { expected: number; high: number } | null {
  const since = now - HISTORY_WINDOW_DAYS * 86_400_000;
  const xs = runs.filter((r) => r.kind === 'scan' && r.status !== 'running' && Date.parse(r.startedAt) >= since).map(pick).filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length < MIN_HISTORY_RUNS) return null;
  const at = (p: number) => xs[Math.round(p * (xs.length - 1))]!;
  return { expected: at(0.5), high: at(0.9) };
}

export class CostBook {
  private files = new Map<string, { size: number; mtimeMs: number; text: string }>();
  /** The last view, kept while nothing it reads changed (a store write, a ledger row, the minute). */
  private memo: { key: string; view: CostsView } | null = null;
  private version = 0;

  constructor(private readonly d: { store: Store; dataDir: string; now: () => number; tz?: string }) {
    d.store.onChange(() => {
      this.version += 1;
    });
  }

  private stamp(file: string): string {
    try {
      const st = statSync(join(this.d.dataDir, file));
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return '-';
    }
  }

  /** A ledger's text, read again only when the file changed. Missing: empty. */
  private read(file: string): string {
    const path = join(this.d.dataDir, file);
    try {
      const st = statSync(path);
      const hit = this.files.get(file);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.text;
      const text = readFileSync(path, 'utf8');
      this.files.set(file, { size: st.size, mtimeMs: st.mtimeMs, text });
      return text;
    } catch {
      return '';
    }
  }

  input(): CostsInput {
    const { store } = this.d;
    const data = { settings: store.get('settings'), runtime: store.get('runtime'), suggestions: store.get('suggestions'), activity: store.get('activity') };
    return costsInputOf(data, { serp: parseLedger(this.read(SERP_LEDGER_FILE)), keepa: parseKeepaLedger(this.read(KEEPA_LEDGER_FILE)) }, this.d.now(), this.d.tz);
  }

  view(): CostsView {
    const key = `${this.version}|${this.stamp(SERP_LEDGER_FILE)}|${this.stamp(KEEPA_LEDGER_FILE)}|${Math.floor(this.d.now() / 60_000)}`;
    if (this.memo?.key === key) return structuredClone(this.memo.view);
    const view = buildCostsView(this.input());
    this.memo = { key, view };
    return structuredClone(view);
  }

  /** /api/state's short form. */
  short(view = this.view()): NonNullable<AgentState['budget']['costs']> {
    return {
      state: view.total.state, sentence: view.total.sentence,
      attention: view.services.filter((s) => s.state !== 'ok').map((s) => ({ service: s.service, state: s.state, sentence: s.sentence })),
    };
  }

  /** Where a service stands for the blocker. */
  room(service: CostService, view = this.view()): CostRoom {
    const s = view.services.find((x) => x.service === service)!;
    return {
      service, unit: s.unit, label: service === 'ai' ? 'AI' : s.label, used: s.used, limit: s.limit,
      total: { spentUsd: view.total.spentUsd, budgetUsd: view.total.budgetUsd },
      blockWhenOver: view.settings.blockWhenOver, today: localDate(this.d.now(), this.d.tz),
    };
  }

  /**
   * What the owner's limit still leaves this month, in the service's unit, while the blocker holds it (the AI's always);
   * null when nothing of his limits the service. A per-run cap is lowered to this, never raised.
   */
  left(service: CostService): number | null {
    const room = this.room(service);
    if (room.limit === null || (!room.blockWhenOver && service !== 'ai')) return null;
    const left = Math.max(0, room.limit - room.used);
    return room.unit === 'usd' ? Math.round(left * 100) / 100 : Math.floor(left);
  }

  /** The cost blocker's answer for one step (core/src/costs/decide.ts). */
  decide(service: CostService, step: CostStep): CostDecision {
    return decideStep(service, step, this.room(service));
  }

  /**
   * The AI dollars the AI passes may spend this month: the AI limit, lowered to what the total budget leaves when the
   * blocker holds the budget. `spentUsd` is the AI spend as the passes count it (views.ts aiSpentThisMonth).
   */
  aiCapUsd(spentUsd: number): number {
    const app = this.d.store.get('settings');
    const cap = app.ai.monthlyCapUsd;
    const costs = costSettingsOf(app);
    if (!costs.blockWhenOver || costs.totalMonthlyUsd === null) return cap;
    const view = this.view();
    return Math.max(0, Math.min(cap, spentUsd + Math.max(0, costs.totalMonthlyUsd - view.total.spentUsd)));
  }

  /**
   * Records a step the blocker held (CostBlocked, this month) and says whether its message is due: at most one per service
   * for `runKey` (a run's id, or the day for work between scans).
   */
  hold(service: CostService, what: string, why: string, runKey: string): boolean {
    const now = this.d.now();
    const at = new Date(now).toISOString();
    const month = monthOf(localDate(now, this.d.tz));
    const key = `${month}:${service}:held:${runKey}`;
    let due = false;
    this.d.store.update('runtime', (r) => {
      const c = this.fresh(r.costs);
      const list = (c.blocked[service] ?? []).filter((b) => !(b.what === what && localDate(Date.parse(b.at), this.d.tz) === localDate(now, this.d.tz)));
      c.blocked[service] = [...list, { what, why, at }].slice(-KEEP_BLOCKED);
      due = !c.sent.includes(key);
      if (due) c.sent.push(key);
      return { ...r, costs: c };
    });
    return due;
  }

  /** The cost warnings due now and not sent this month; marked sent as they are returned. */
  due(): CostWarning[] {
    const view = this.view();
    const sent = this.fresh(this.d.store.get('runtime').costs).sent;
    const { warnings, alsoSent } = costWarnings(view, sent);
    if (warnings.length === 0 && alsoSent.length === 0) return [];
    this.d.store.update('runtime', (r) => {
      const c = this.fresh(r.costs);
      c.sent = [...new Set([...c.sent, ...warnings.map((w) => w.key), ...alsoSent])];
      return { ...r, costs: c };
    });
    return warnings;
  }

  /** Counts eBay calls or Telegram messages on today's local day. */
  count(kind: 'ebay' | 'telegram' | 'amazon', n: number): void {
    if (!(n > 0)) return;
    const today = localDate(this.d.now(), this.d.tz);
    this.d.store.update('runtime', (r) => {
      const c = this.fresh(r.costs);
      const day = { ...(c.counts[today] ?? {}) };
      day[kind] = (day[kind] ?? 0) + n;
      c.counts[today] = day;
      return { ...r, costs: c };
    });
  }

  /** The runtime record with what is too old dropped: blocked steps of earlier months, sent keys before last month, counts past KEEP_COUNT_DAYS. */
  private fresh(c: CostRuntime | undefined): CostRuntime {
    const out = structuredClone(c ?? emptyRuntime());
    const today = localDate(this.d.now(), this.d.tz);
    const month = monthOf(today);
    const keep = new Set([month, previousMonth(month)]);
    out.sent = out.sent.filter((k) => keep.has(k.slice(0, 7)));
    for (const k of Object.keys(out.blocked) as CostService[]) out.blocked[k] = (out.blocked[k] ?? []).filter((b) => monthOf(localDate(Date.parse(b.at), this.d.tz)) === month);
    const oldest = addDays(today, -KEEP_COUNT_DAYS);
    for (const d of Object.keys(out.counts)) if (d < oldest) delete out.counts[d];
    return out;
  }
}

