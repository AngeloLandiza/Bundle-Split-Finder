// Rung 2 of the listing ladder in the agent: the owner's "Confirm listing" click, done by the agent after a scan and in
// the drip, right after the catalog check (core/src/scan/autoConfirm.ts chooses; this file spends). Each read is the
// paid Verify (core/src/scan/paid.ts runPaid, one SerpApi amazon_product page) through SerpApiClient under a
// SearchBudget built from a fresh account check: never the reserve (the scheduled policy), never more than the per-scan
// cap, never more than today's allowance. Off when Settings say so (lookups.autoVerify false).

import type { ExtensionSettings } from '../core/src/settings';
import { budgetPolicyFor } from '../core/src/settings';
import { autoConfirmSentence, autoConfirmTargets, dayOf, verifyAllowanceToday, type AutoConfirmTarget } from '../core/src/scan/autoConfirm';
import type { MatchRecord, ScanStore } from '../core/src/scan/types';
import { type AccountInfo, type KeyAccount, pooledAccount, SearchBudget } from '../core/src/serpapi/budget';
import type { BundleSignals } from '../core/src/tracking/signals';
import { unconfirmedReason } from '../core/src/keepa/verify';
import { REPICK_SEARCH_EVERY_MS } from './verifyMatches';

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
  /** Counted listings no automatic rung will read, with why (unconfirmableOf); what the deal's words and notes say. */
  unconfirmable?: Unconfirmable;
  /** Round 2: when each part was last searched on Keepa for a better listing (verifyMatches.ts repickUnconfirmed). */
  searchedAt?: Record<string, number>;
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
  /** A fresh free account check (account.json); key stacking: each saved key's own, by key id. */
  account: () => Promise<AccountInfo | KeyAccount[]>;
  /** One paid Verify of the target within `budget` (runPaid with a SerpApiClient on that budget). */
  verify: (t: AutoConfirmTarget, budget: SearchBudget) => Promise<void>;
  /** 'scan': the scan's own cap applies, less what it spent (`usedThisScan`); 'drip': today's allowance only. */
  mode: 'scan' | 'drip';
  usedThisScan?: number;
  now: () => number;
  shouldStop: () => boolean;
  /** Nov 23: counted for the scan's "Listing confirmation" step; each listing read is one item. */
  progress?: { add(n: number): void; item(ms: number | null): void };
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
  const checked = await d.account();
  // Key stacking: the allowance reads the keys' total; the budget charges each search to one key.
  const account = Array.isArray(checked) ? pooledAccount(checked.map((k) => k.account)) : checked;
  const allowance = verifyAllowanceToday(account, d.ext.reserve, d.perDay, state.spent, d.now());
  if (allowance === 0) {
    d.saveState({ ...state, exhaustedDay: today });
    done.waiting = targets.length;
    return done;
  }
  const policy = budgetPolicyFor(d.ext, 'scheduled', d.mode === 'scan' ? d.usedThisScan ?? 0 : 0);
  const budget = new SearchBudget(checked, { reserve: policy.reserve, maxPerRun: Math.min(policy.maxPerRun, allowance) });
  // What the allowance can read, not every listing that waits: the step's total is what will be read.
  d.progress?.add(Math.min(targets.length, Math.max(0, allowance)));
  for (const t of targets) {
    if (d.shouldStop() || !budget.canSpend(1)) break;
    const before = budget.spentThisRun;
    const startedAt = d.now();
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
    d.progress?.item(spent > 0 ? d.now() - startedAt : null);
    const after = (await d.store.listMatches()).filter((m) => m.asin === t.asin);
    if (after.some(isConfirmed)) done.confirmed += 1;
  }
  done.waiting = targets.length - done.tried.length;
  done.summary = autoConfirmSentence(done.tried, done.confirmed, done.searches);
  return done;
}

export interface QueueInput {
  /** Listings the catalog check (rungs 0 and 1) will read in the drip, when the drip runs and Keepa can pull. */
  catalog: string[];
  /** The drip's next round (epoch ms), or null when it is off or Keepa cannot pull. */
  dripNextAt: number | null;
  /** Listings rung 2 will read: [] unless rung2CanRun. */
  verify: string[];
  /** Rung 2's next look (epoch ms). */
  verifyNextAt: number | null;
  state: AutoConfirmState | undefined;
  now: number;
}

/**
 * What a deal's words rest on: the listings some automatic rung will really read, and the earliest next look. Only a rung
 * that can run is queued (round 2, Nov 23: an allowance of 0 queued rung 2 for the next day, every day, and the deal said
 * "being confirmed" with nothing behind it). Nothing is queued without a time.
 */
export function confirmationQueue(q: QueueInput): { queue: string[]; nextAt: number | null } {
  const at: number[] = [];
  const queue = new Set<string>();
  if (q.dripNextAt !== null && q.catalog.length > 0) {
    q.catalog.forEach((a) => queue.add(a));
    at.push(q.dripNextAt);
  }
  if (q.verify.length > 0 && q.verifyNextAt !== null) {
    q.verify.forEach((a) => queue.add(a));
    at.push(q.verifyNextAt);
  }
  return { queue: [...queue], nextAt: at.length > 0 ? Math.min(...at) : null };
}

/**
 * Whether rung 2 can read anything today, without a call: on, a SerpApi key, not paused, today's allowance not spent, and
 * the last known account (AgentRuntime.serp) above the reserve. With no account known yet, one free check will say.
 */
export function rung2CanRun(i: {
  enabled: boolean; hasKey: boolean; paused: boolean; serp: { left: number } | null; reserve: number; perDay: number | null | undefined;
  state: AutoConfirmState | undefined; now: number;
}): boolean {
  if (!i.enabled || !i.hasKey || i.paused) return false;
  const today = dayOf(i.now);
  if (i.state?.exhaustedDay === today) return false;
  if (i.serp === null) return true;
  const spent = i.state?.day === today ? i.state.spent : 0;
  return verifyAllowanceToday({ totalSearchesLeft: i.serp.left, renewalDate: null }, i.reserve, i.perDay, spent, i.now) > 0;
}

/** Whether the drip's Keepa pulls can run: tokens above the reserve now, or a refill that will bring them. */
export function keepaCanPull(keepa: { tokensLeft: number; refillRate?: number } | null, reserve: number): boolean {
  return keepa === null || keepa.tokensLeft - reserve >= 1 || (keepa.refillRate ?? 0) > 0;
}

/** A counted listing no automatic rung will read: its part and why it stays unconfirmed (verify.ts unconfirmedReason). */
export type Unconfirmable = Record<string, { key: string; model: string; reason: string }>;

/**
 * The counted listings nobody confirmed (the signals' `unconfirmed`) that are not in `queue`, each with its reason from
 * what was read: the catalog check's last answer and the listing's stored brand field.
 */
export async function unconfirmableOf(store: ScanStore, signals: Record<string, Pick<BundleSignals, 'options'>>, queue: readonly string[]): Promise<Unconfirmable> {
  const waiting = new Set(queue);
  const asins = new Set(Object.values(signals).flatMap((s) => s.options.flatMap((o) => o.unconfirmed ?? [])).filter((a) => !waiting.has(a)));
  const out: Unconfirmable = {};
  if (asins.size === 0) return out;
  for (const m of await store.listMatches()) {
    if (!m.asin || !asins.has(m.asin) || out[m.asin]) continue;
    const check = [...(m.catalogChecks ?? [])].reverse().find((c) => c.asin === m.asin) ?? null;
    const listing = await store.getListing(m.asin);
    out[m.asin] = { key: m.key, model: m.model, reason: unconfirmedReason({ brand: m.brand, model: m.model }, listing?.brand ?? null, check?.reason ?? null) };
  }
  return out;
}

/**
 * The parts whose counted listing no rung could confirm and that may still be re-picked: each listing in `unconfirmable`
 * whose part was not searched on Keepa within REPICK_SEARCH_EVERY_MS. Its free re-pick from stored rows runs with it.
 */
export function repickTargets(state: AutoConfirmState | undefined, now: number): { key: string; model: string; asin: string; reason: string }[] {
  const searched = state?.searchedAt ?? {};
  return Object.entries(state?.unconfirmable ?? {})
    .filter(([, u]) => searched[u.key] === undefined || now - searched[u.key]! >= REPICK_SEARCH_EVERY_MS)
    .map(([asin, u]) => ({ key: u.key, model: u.model, asin, reason: u.reason }));
}
