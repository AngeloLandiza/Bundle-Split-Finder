// The pace of the seller API: one request per 1/rate seconds per operation (SP_RATES, at or below Amazon's documented
// rates; the burst is not used), and the app's own cap a day per operation (SP_DAILY_CAPS). The clock and the wait are
// injected so tests run without time passing. Pure.

import { SP_DAILY_CAPS, SP_RATES, type SpOperation } from './types';

export interface LimiterDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  rates?: Partial<Record<SpOperation, number>>;
  caps?: Partial<Record<SpOperation, number>>;
  /** Calls already made today per operation (the ledger read at start), so a restart does not reset the cap. */
  usedToday?: Partial<Record<SpOperation, number>>;
  /** The day a count belongs to (YYYY-MM-DD); default UTC. */
  dayOf?: (ms: number) => string;
}

export class SpDailyCapError extends Error {
  constructor(readonly op: SpOperation, readonly cap: number) {
    super(`The app's own limit of ${cap} Amazon ${op} calls today is reached; it starts again tomorrow`);
    this.name = 'SpDailyCapError';
  }
}

export class SpLimiter {
  private readonly next = new Map<SpOperation, number>();
  private readonly used = new Map<SpOperation, number>();
  private day: string;
  /** Calls of one operation wait in line: a second caller is spaced after the first, never beside it. */
  private readonly queue = new Map<SpOperation, Promise<void>>();

  constructor(private readonly d: LimiterDeps) {
    this.day = this.dayOf(d.now());
    for (const [op, n] of Object.entries(d.usedToday ?? {})) this.used.set(op as SpOperation, n ?? 0);
  }

  private dayOf(ms: number): string {
    return this.d.dayOf ? this.d.dayOf(ms) : new Date(ms).toISOString().slice(0, 10);
  }

  intervalMs(op: SpOperation): number {
    const rate = this.d.rates?.[op] ?? SP_RATES[op];
    return Math.ceil(1000 / rate);
  }

  cap(op: SpOperation): number {
    return this.d.caps?.[op] ?? SP_DAILY_CAPS[op];
  }

  /** Calls of `op` counted today. */
  usedToday(op: SpOperation): number {
    this.roll();
    return this.used.get(op) ?? 0;
  }

  /** How many more calls of `op` the day's cap allows. */
  left(op: SpOperation): number {
    return Math.max(0, this.cap(op) - this.usedToday(op));
  }

  private roll(): void {
    const today = this.dayOf(this.d.now());
    if (today !== this.day) {
      this.day = today;
      this.used.clear();
    }
  }

  /**
   * Waits for `op`'s turn and counts the call. Throws SpDailyCapError (and waits for nothing) when the day's cap is
   * reached. `extraWaitMs`: a wait Amazon asked for (a 429's headers), added before the turn.
   */
  async take(op: SpOperation, extraWaitMs = 0): Promise<void> {
    const before = this.queue.get(op) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.queue.set(op, before.then(() => mine));
    try {
      await before;
      this.roll();
      if ((this.used.get(op) ?? 0) >= this.cap(op)) throw new SpDailyCapError(op, this.cap(op));
      const now = this.d.now();
      const at = Math.max(this.next.get(op) ?? 0, now + extraWaitMs);
      if (at > now) await this.d.sleep(at - now);
      this.used.set(op, (this.used.get(op) ?? 0) + 1);
      this.next.set(op, Math.max(at, this.d.now()) + this.intervalMs(op));
    } finally {
      release();
    }
  }
}
