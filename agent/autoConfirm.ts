// Rung 2 of the listing ladder in the agent: the owner's "Confirm listing" click, done by the agent after a scan and in
// the drip, right after the catalog check (core/src/scan/autoConfirm.ts chooses; this file spends). Each read is the
// paid Verify (core/src/scan/paid.ts runPaid, one SerpApi amazon_product page) through SerpApiClient under a
// SearchBudget built from a fresh account check: never the reserve (the scheduled policy), never more than the per-scan
// cap, never more than today's allowance. Off when Settings say so (lookups.autoVerify false).

import type { ExtensionSettings } from '../core/src/settings';
import { budgetPolicyFor } from '../core/src/settings';
import { autoConfirmSentence, autoConfirmTargets, dayOf, verifyAllowanceToday, type AutoConfirmTarget } from '../core/src/scan/autoConfirm';
import type { MatchRecord, ScanStore } from '../core/src/scan/types';
import { type AccountInfo, SearchBudget } from '../core/src/serpapi/budget';
import type { BundleSignals } from '../core/src/tracking/signals';

/** What rung 2 keeps between runs (AgentRuntime.autoConfirm): today's spend and every listing it read. */
export interface AutoConfirmState {
  day: string;
  spent: number;
  /** ASINs read by rung 2, each once: a listing's fields do not go stale. */
  tried: string[];
  /** The day whose allowance ran out (rung 2 then waits for the next UTC day). */
  exhaustedDay?: string;
  /** Listings some automatic rung will read, and when the next look is (epoch ms); what a deal's words rest on. */
  queue?: string[];
  nextAt?: number | null;
}

export interface AutoConfirmDeps {
  store: ScanStore;
  signals: Record<string, BundleSignals>;
  alerts: { minProfit: number; minRoiPercent: number };
  /** The deals' parts as published: which part of a bundle holds a listing. */
  bundles: { key: string; brand: string; parts: { model: string; asin: string | null }[] }[];
  ext: ExtensionSettings;
  /** lookups.verifySearchesPerDay: a number, or null for the automatic allowance. */
  perDay: number | null;
  /** Whether Keepa reads listings (a key and Keepa on): rung 2 then waits for the catalog check. */
  keepaReads: boolean;
  state: AutoConfirmState | undefined;
  saveState: (s: AutoConfirmState) => void;
  /** A fresh free account check (account.json). */
  account: () => Promise<AccountInfo>;
  /** One paid Verify of the target within `budget` (runPaid with a SerpApiClient on that budget). */
  verify: (t: AutoConfirmTarget, budget: SearchBudget) => Promise<void>;
  /** 'scan': the scan's own cap applies, less what it spent (`usedThisScan`); 'drip': today's allowance only. */
  mode: 'scan' | 'drip';
  usedThisScan?: number;
  now: () => number;
  shouldStop: () => boolean;
}

export interface AutoConfirmDone {
  tried: AutoConfirmTarget[];
  confirmed: number;
  searches: number;
  /** One sentence for Activity, or null when nothing was read. */
  summary: string | null;
  /** Listings still waiting for a read (the allowance or the budget stopped it). */
  waiting: number;
}

const isConfirmed = (m: MatchRecord | null | undefined): boolean => !!m && m.status === 'matched' && (m.grade === 'exact' || m.grade === 'strong');

/** The listings rung 2 would read now, in order (no spend). */
export async function autoConfirmWanted(d: Pick<AutoConfirmDeps, 'store' | 'signals' | 'alerts' | 'bundles' | 'keepaReads' | 'state'>): Promise<AutoConfirmTarget[]> {
  const matches = await d.store.listMatches();
  const tried = new Set(d.state?.tried ?? []);
  const byAsin = new Map<string, MatchRecord[]>();
  for (const m of matches) if (m.asin) byAsin.set(m.asin, [...(byAsin.get(m.asin) ?? []), m]);
  const eligible = (asin: string): boolean => {
    if (tried.has(asin)) return false;
    const held = (byAsin.get(asin) ?? []).filter((m) => m.decidedBy === 'auto' && m.status === 'matched' && m.grade === 'probable');
    if (held.length === 0) return false;
    // Rungs 0 and 1 first: with Keepa on, the catalog check must have read the listing (and left it unknown).
    return !d.keepaReads || held.some((m) => (m.catalogChecks ?? []).some((c) => c.asin === asin));
  };
  const bundles = new Map(d.bundles.map((b) => [b.key, b]));
  return autoConfirmTargets({
    signals: d.signals, alerts: d.alerts, eligible,
    partOf: (key, asin) => {
      const b = bundles.get(key);
      const p = b?.parts.find((x) => x.asin === asin);
      return b && p ? { brand: b.brand, model: p.model } : null;
    },
  });
}

/** Rung 2: read the wanted listings within today's allowance. Never throws for a refusal: it stops and says so. */
export async function runAutoConfirm(d: AutoConfirmDeps): Promise<AutoConfirmDone> {
  const done: AutoConfirmDone = { tried: [], confirmed: 0, searches: 0, summary: null, waiting: 0 };
  const targets = await autoConfirmWanted(d);
  if (targets.length === 0) return done;
  const today = dayOf(d.now());
  const state: AutoConfirmState = d.state && d.state.day === today ? { ...d.state, tried: [...d.state.tried] } : { day: today, spent: 0, tried: [...(d.state?.tried ?? [])] };
  const account = await d.account();
  const allowance = verifyAllowanceToday(account, d.ext.reserve, d.perDay, state.spent, d.now());
  if (allowance === 0) {
    d.saveState({ ...state, exhaustedDay: today });
    done.waiting = targets.length;
    return done;
  }
  const policy = budgetPolicyFor(d.ext, 'scheduled', d.mode === 'scan' ? d.usedThisScan ?? 0 : 0);
  const budget = new SearchBudget(account, { reserve: policy.reserve, maxPerRun: Math.min(policy.maxPerRun, allowance) });
  for (const t of targets) {
    if (d.shouldStop() || !budget.canSpend(1)) break;
    const before = budget.spentThisRun;
    try {
      await d.verify(t, budget);
    } catch {
      // A page that cannot be read, a refusal, a network error: the listing is not read again; the next one is tried.
    }
    const spent = budget.spentThisRun - before;
    state.spent += spent;
    if (budget.spentThisRun >= allowance) state.exhaustedDay = today;
    state.tried.push(t.asin);
    d.saveState(state);
    done.tried.push(t);
    done.searches += spent;
    const after = (await d.store.listMatches()).filter((m) => m.asin === t.asin);
    if (after.some(isConfirmed)) done.confirmed += 1;
  }
  done.waiting = targets.length - done.tried.length;
  done.summary = autoConfirmSentence(done.tried, done.confirmed, done.searches);
  return done;
}

/** Start of the next UTC day after `at` (epoch ms). */
const nextDay = (at: number): number => {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

export interface QueueInput {
  /** Listings the catalog check (rungs 0 and 1) will read in the drip, when the drip runs. */
  catalog: string[];
  /** The drip's next round (epoch ms), or null when it is off. */
  dripNextAt: number | null;
  /** Listings rung 2 would read, when it is on and has a SerpApi key; [] otherwise. */
  verify: string[];
  /** Rung 2's next look (epoch ms). */
  verifyNextAt: number | null;
  state: AutoConfirmState | undefined;
  now: number;
}

/**
 * What a deal's words rest on: the listings some automatic rung will really read, and the earliest next look. Rung 2's
 * listings wait for the next UTC day when today's allowance is spent. Nothing is queued without a time.
 */
export function confirmationQueue(q: QueueInput): { queue: string[]; nextAt: number | null } {
  const at: number[] = [];
  const queue = new Set<string>();
  if (q.dripNextAt !== null && q.catalog.length > 0) {
    q.catalog.forEach((a) => queue.add(a));
    at.push(q.dripNextAt);
  }
  if (q.verify.length > 0) {
    const exhausted = q.state?.exhaustedDay === dayOf(q.now);
    const when = exhausted ? nextDay(q.now) : q.verifyNextAt;
    if (when !== null) {
      q.verify.forEach((a) => queue.add(a));
      at.push(when);
    }
  }
  return { queue: [...queue], nextAt: at.length > 0 ? Math.min(...at) : null };
}
