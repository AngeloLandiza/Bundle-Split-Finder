// Nov 25: the owner's Amazon seller account in the agent, read-only (docs/sp-api-notes-2026-11-25.md). Before he buys,
// each part of a deal that is Buy now or within reach of it is checked against his own account: may he list it, will FBA
// take it, and what Amazon would charge him for it. The rules are core/src/amazon/seller.ts; the calls are
// core/src/amazon/spapi/client.ts. This file keeps the client, the ledger (spapi-ledger.jsonl), the day's use, the first
// answers as samples, and the records (tracking.sellerChecks) the signals, the estimate and the inspector read.
//
// Rule 3: the credentials are read from the store here and given only to the client, which sends them only to
// api.amazon.com and sellingpartnerapi-na.amazon.com. Nothing here writes a credential anywhere: the ledger has the
// operation, the status and the count; a sample is scrubbed by the client; a problem sentence is the client's (scrubbed).

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  checksWanted,
  feesAtPrice,
  sellerAccountTag,
  sellerParts,
  sellerRetryAt,
  type SellerLookup,
  type SellerPartCheck,
  type SellerProblem,
} from '../core/src/amazon/seller';
import { SpApiClient, SpApiError } from '../core/src/amazon/spapi/client';
import { SAMPLES_PER_OPERATION, SP_DAILY_CAPS, SP_OPERATIONS, type SellerCredentials, type SpCallRow, type SpOperation, type SpSample } from '../core/src/amazon/spapi/types';
import type { AmazonFeesLookup } from '../core/src/scan/report';
import type { BundleRow, ScanReport } from '../core/src/scan/types';
import type { TrendLookup } from '../core/src/tracking/signals';
import { retrackReport, type SignalOpts } from '../core/src/tracking/state';
import { SELLER_USER_AGENT } from './keyChecks';
import type { Store } from './store';

export const SPAPI_LEDGER_FILE = 'spapi-ledger.jsonl';
/** At most this many listings are read in one pass (each a listing read and an FBA read, about 1 s apiece). */
export const MAX_CHECKS_PER_PASS = 40;
/** Records of listings no deal holds any more are dropped after this. */
const KEEP_UNUSED_MS = 30 * 86_400_000;

export interface SellerHost {
  store: Store;
  fetchFn: typeof fetch;
  now: () => number;
  dataDir: string;
  sleep?: (ms: number) => Promise<void>;
  /** Costs: one more seller API call today. */
  count?: (n: number) => void;
  /** A rejection of the credentials (null: they work again), for the Keys pane. */
  onKeyProblem?: (sentence: string | null) => void;
  /** Tests: the two Amazon addresses. */
  spUrls?: { tokenUrl: string; baseUrl: string };
}

export interface SellerPassOutcome {
  /** Listings whose listing and FBA answers were read. */
  checked: number;
  /** Listings whose fee estimate was read (with or without an estimate). */
  feesRead: number;
  /** Why the pass stopped early, in words; null when it did not. */
  stopped: string | null;
}

/** A record that says every part may be listed and FBA takes it: the dry run that finds deals about to be announced. */
const PASS_ALL: SellerLookup = {
  check: (asin) => ({ asin, account: '', listing: { at: 0, status: 'allowed', reasons: [] }, fba: { at: 0, eligible: true, reasons: [] }, fees: null }),
  selfShip: () => false,
};

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class SellerAccount {
  private cached: { fp: string; client: SpApiClient } | null = null;

  constructor(private readonly h: SellerHost) {}

  credentials(): SellerCredentials | null {
    const k = this.h.store.get('keys').amazonSeller;
    return k && k.clientId && k.clientSecret && k.refreshToken && k.sellerId ? k : null;
  }

  connected(): boolean {
    return this.credentials() !== null;
  }

  /** The tag of the connected account (sellerAccountTag); null without one. */
  account(): string | null {
    const c = this.credentials();
    return c ? sellerAccountTag(c.sellerId) : null;
  }

  /** Calls counted while a pass runs, written to the store once at its end (each store write is a file write). */
  private batch: { n: number; day: string; used: Partial<Record<SpOperation, number>> } | null = null;

  /** The ledger row, the day's use, the costs count: every call made by any client on this account. */
  private onCall = (row: SpCallRow): void => {
    try {
      appendFileSync(join(this.h.dataDir, SPAPI_LEDGER_FILE), `${JSON.stringify(row)}\n`);
    } catch {
      // The ledger is the record; a failed write never stops a check.
    }
    const one = { n: 1, day: utcDay(Date.parse(row.at)), used: row.op === 'token' ? {} : { [row.op]: 1 } };
    if (this.batch && this.batch.day === one.day) {
      this.batch.n += 1;
      if (row.op !== 'token') this.batch.used[row.op] = (this.batch.used[row.op] ?? 0) + 1;
      return;
    }
    if (this.batch) this.flushCalls();
    if (this.batch === null && this.batching) this.batch = one;
    else this.countCalls(one);
  };

  private batching = false;

  private flushCalls(): void {
    if (this.batch) this.countCalls(this.batch);
    this.batch = null;
  }

  private countCalls(c: { n: number; day: string; used: Partial<Record<SpOperation, number>> }): void {
    this.h.count?.(c.n);
    if (Object.keys(c.used).length === 0) return;
    this.h.store.update('runtime', (r) => {
      const u = r.spapiUsage?.day === c.day ? r.spapiUsage.used : {};
      const used = { ...u };
      for (const [op, n] of Object.entries(c.used) as [SpOperation, number][]) used[op] = (used[op] ?? 0) + n;
      return { ...r, spapiUsage: { day: c.day, used } };
    });
  }

  private onSample = (s: SpSample): void => {
    this.h.store.update('runtime', (r) => {
      const kept = r.spapiSamples ?? [];
      if (kept.filter((x) => x.op === s.op).length >= SAMPLES_PER_OPERATION) return r;
      return { ...r, spapiSamples: [...kept, s] };
    });
  };

  /** What a key check's own client reports through (agent/keyChecks.ts KeyCheckDeps.spHooks). */
  hooks(): { onCall: (row: SpCallRow) => void; onSample: (s: SpSample) => void } {
    return { onCall: this.onCall, onSample: this.onSample };
  }

  /** The calls of each operation today and the app's cap a day, for Settings. */
  usage(): { used: Record<SpOperation, number>; caps: Record<SpOperation, number> } {
    const u = this.h.store.get('runtime').spapiUsage;
    const today = utcDay(this.h.now());
    const used = Object.fromEntries(SP_OPERATIONS.map((op) => [op, u?.day === today ? u.used[op] ?? 0 : 0])) as Record<SpOperation, number>;
    return { used, caps: { ...SP_DAILY_CAPS } };
  }

  /** The client on the stored credentials (one per set of credentials, so its token and pace are kept); null without them. */
  client(): SpApiClient | null {
    const c = this.credentials();
    if (!c) {
      this.cached = null;
      return null;
    }
    const fp = JSON.stringify([c.clientId, c.clientSecret, c.refreshToken, c.sellerId]);
    if (this.cached?.fp === fp) return this.cached.client;
    const rt = this.h.store.get('runtime');
    const today = utcDay(this.h.now());
    const kept: Partial<Record<SpCallRow['op'], number>> = {};
    for (const s of rt.spapiSamples ?? []) kept[s.op] = (kept[s.op] ?? 0) + 1;
    const client = new SpApiClient({
      credentials: c, fetchFn: this.h.fetchFn, now: this.h.now, userAgent: SELLER_USER_AGENT,
      ...(this.h.sleep ? { sleep: this.h.sleep } : {}), ...(this.h.spUrls ?? {}),
      onCall: this.onCall, onSample: this.onSample, samplesKept: kept,
      limits: { usedToday: rt.spapiUsage?.day === today ? rt.spapiUsage.used : {} },
    });
    this.cached = { fp, client };
    return client;
  }

  /** The records and the owner's self-ship choices, for the signals; undefined when no account is connected. */
  lookup(): SellerLookup | undefined {
    const account = this.account();
    if (account === null) return undefined;
    const t = this.h.store.get('tracking');
    const checks = t.sellerChecks ?? {};
    const self = t.selfShip ?? {};
    return {
      check: (asin) => (checks[asin]?.account === account ? checks[asin] : undefined),
      selfShip: (asin) => self[asin] !== undefined,
    };
  }

  /**
   * Amazon's fee estimate for the estimate (core/src/scan/report.ts ReportOptions.amazonFees): read with this account at
   * exactly the price used, and not for a part he ships himself (the estimate is FBA's). Undefined without an account.
   */
  amazonFees(): AmazonFeesLookup | undefined {
    const account = this.account();
    if (account === null) return undefined;
    const t = this.h.store.get('tracking');
    const checks = t.sellerChecks ?? {};
    const self = t.selfShip ?? {};
    return (asin, price) => (self[asin] !== undefined ? undefined : feesAtPrice(checks[asin], account, price));
  }

  /** The owner ships this listing himself (or no longer): remembered by ASIN. */
  setSelfShip(asin: string, on: boolean): void {
    this.h.store.update('tracking', (t) => {
      const next = { ...(t.selfShip ?? {}) };
      if (on) next[asin] = new Date(this.h.now()).toISOString();
      else delete next[asin];
      return { ...t, selfShip: next };
    });
  }

  /** The pass's records, written to the store once at its end (the tracking collection is large; one write, not one a call). */
  private flush(pending: ReadonlyMap<string, SellerPartCheck>): void {
    if (pending.size === 0) return;
    this.h.store.update('tracking', (t) => ({ ...t, sellerChecks: { ...(t.sellerChecks ?? {}), ...Object.fromEntries(pending) } }));
  }

  /**
   * The deals that are Buy now or within reach of it (an estimate that clears his thresholds, or a watched deal with an
   * estimate), each with whether it is about to be announced for the first time: judged Buy now with every seller check
   * passing, with alerts on, and not announced yet.
   */
  candidates(report: Pick<ScanReport, 'bundles' | 'review'>, trend: TrendLookup, opts: SignalOpts): { parts: BundleRow['parts']; firstAnnounce: boolean }[] {
    const t = this.h.store.get('tracking');
    const app = this.h.store.get('settings');
    const now = this.h.now();
    const reach = report.bundles.filter((b) => {
      if (!b.options.some((o) => o.estimate)) return false;
      const sig = t.signals[b.key];
      return t.watch[b.key]?.watched === true || (sig?.options.some((o) => o.meetsThresholds || o.buyNow) ?? false);
    });
    if (reach.length === 0) return [];
    const dry = app.alerts.enabled ? retrackReport(t, { bundles: reach, review: report.review }, trend, app.alerts, now, { ...opts, seller: PASS_ALL }).state.signals : {};
    return reach.map((b) => ({
      parts: b.options.filter((o) => o.estimate).flatMap((o) => o.parts),
      firstAnnounce: (dry[b.key]?.buyNow ?? null) !== null && t.announced?.[b.key] === undefined,
    }));
  }

  /**
   * One pass: every listing of a candidate deal whose record is missing or stale (core checksWanted) is read, at most
   * MAX_CHECKS_PER_PASS, each through the client's pace. A rejection of the credentials, a refusal (403), Amazon's limit,
   * an outage or the day's cap stops the pass; an answer that cannot be read is kept as that listing's problem and the pass
   * goes on. Never throws.
   */
  async refresh(report: Pick<ScanReport, 'bundles' | 'review'>, trend: TrendLookup, opts: SignalOpts, shouldStop: () => boolean = () => false): Promise<SellerPassOutcome> {
    const out: SellerPassOutcome = { checked: 0, feesRead: 0, stopped: null };
    const client = this.client();
    const account = this.account();
    if (!client || account === null) return out;
    this.prune(report, account);
    const stored = this.h.store.get('tracking').sellerChecks ?? {};
    // Refused credentials wait for him; a pass runs only while none is refused, so their listings are tried again now.
    const checks = Object.fromEntries(Object.entries(stored).map(([a, c]) => [a, c.problem?.untilKey ? (({ problem: _p, ...rest }) => rest)(c) : c]));
    const wanted = checksWanted(this.candidates(report, trend, opts), (a) => checks[a], account, this.h.now()).slice(0, MAX_CHECKS_PER_PASS);
    const pending = new Map<string, SellerPartCheck>();
    const write = (asin: string, f: (c: SellerPartCheck) => SellerPartCheck) => {
      const had = pending.get(asin) ?? checks[asin];
      pending.set(asin, f(had && had.account === account ? had : { asin, account, listing: null, fba: null, fees: null }));
    };
    this.batching = true;
    try {
      await this.pass(client, wanted, write, out, shouldStop);
    } finally {
      this.batching = false;
      this.flushCalls();
      this.flush(pending);
    }
    return out;
  }

  private async pass(
    client: SpApiClient, wanted: ReturnType<typeof checksWanted>, write: (asin: string, f: (c: SellerPartCheck) => SellerPartCheck) => void,
    out: SellerPassOutcome, shouldStop: () => boolean,
  ): Promise<void> {
    /** The problem a failure leaves on a listing: the client's words (scrubbed) and when it is tried again. */
    const problemOf = (err: unknown): SellerProblem => {
      const now = this.h.now();
      if (!(err instanceof SpApiError)) return { at: now, text: 'the check went wrong inside the app', retryAt: sellerRetryAt('other', now) };
      if (err.kind === 'rejected') return { at: now, text: 'Amazon did not accept your seller account', retryAt: sellerRetryAt('other', now), untilKey: true };
      return { at: now, text: err.message, retryAt: sellerRetryAt(err.kind === 'cap' ? 'cap' : err.kind === 'unreadable' ? 'unreadable' : 'other', now) };
    };
    // Whether a failure ends the pass: an answer that cannot be read, or a refusal of one listing (400/404), does not.
    const stops = (err: unknown): boolean => !(err instanceof SpApiError) || !(err.kind === 'unreadable' || (err.kind === 'denied' && err.status !== 403));
    const stopWith = (err: unknown, p: SellerProblem, rest: readonly { asin: string }[]): void => {
      if (err instanceof SpApiError && err.kind === 'rejected') this.h.onKeyProblem?.(err.message);
      // Every listing this pass did not reach carries the same why and when, so none is held in silence.
      for (const w of rest) write(w.asin, (c) => ({ ...c, problem: p }));
      out.stopped = p.text;
    };
    const full = wanted.filter((x) => x.full);
    for (let i = 0; i < full.length; i += 1) {
      const w = full[i]!;
      if (shouldStop()) break;
      try {
        const r = await client.restrictions(w.asin);
        write(w.asin, (c) => ({ ...c, listing: { at: this.h.now(), status: r.status, reasons: r.reasons } }));
        const e = await client.eligibility(w.asin);
        write(w.asin, (c) => {
          const { problem: _p, ...rest } = c;
          return { ...rest, fba: { at: this.h.now(), eligible: e.eligible, reasons: e.reasons } };
        });
        // The credentials work: a rejection said before is cleared (once a pass).
        if (out.checked === 0) this.h.onKeyProblem?.(null);
        out.checked += 1;
      } catch (err) {
        const p = problemOf(err);
        write(w.asin, (c) => ({ ...c, problem: p }));
        if (stops(err)) return stopWith(err, p, full.slice(i + 1));
      }
    }
    const feeItems = wanted.filter((x) => x.fees).map((x) => ({ asin: x.asin, price: x.price }));
    if (feeItems.length > 0 && !shouldStop()) {
      try {
        for (const f of await client.fees(feeItems)) {
          write(f.asin, (c) => {
            const { feesRetryAt: _r, ...rest } = c;
            return {
              ...rest, feesAskedAt: f.price,
              fees: f.estimate ? { at: this.h.now(), price: f.price, total: f.estimate.total, referral: f.estimate.referral, other: f.estimate.other, lines: f.estimate.lines } : c.fees,
            };
          });
          out.feesRead += 1;
        }
      } catch (err) {
        // A fee read that failed is tried again on the next cadence; the estimate keeps Keepa's figures meanwhile.
        const p = problemOf(err);
        for (const f of feeItems) write(f.asin, (c) => ({ ...c, feesRetryAt: p.retryAt }));
        if (err instanceof SpApiError && err.kind === 'rejected') this.h.onKeyProblem?.(err.message);
        out.stopped = p.text;
      }
    }
  }

  /** Records of another account, and of listings no deal has held for KEEP_UNUSED_MS, are dropped. */
  private prune(report: Pick<ScanReport, 'bundles'>, account: string): void {
    const held = new Set(report.bundles.flatMap((b) => b.options.flatMap((o) => sellerParts(o.parts).map((p) => p.asin!))));
    const now = this.h.now();
    const t = this.h.store.get('tracking');
    const all = t.sellerChecks ?? {};
    const keep = Object.fromEntries(Object.entries(all).filter(([asin, c]) => {
      if (c.account !== account) return false;
      if (held.has(asin)) return true;
      const at = Math.max(c.listing?.at ?? 0, c.fba?.at ?? 0, c.fees?.at ?? 0);
      return now - at <= KEEP_UNUSED_MS;
    }));
    if (Object.keys(keep).length !== Object.keys(all).length) this.h.store.update('tracking', (x) => ({ ...x, sellerChecks: keep }));
  }
}
