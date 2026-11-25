// Home Depot's read pace (Nov 23, after the owner's scan 5). One budget for every Home Depot page the app asks the paired
// Chrome to read, in a scan and between scans: a minimum gap between any two reads, a cap per scan across every kind of
// read together (lists, bundle pages, set item pages, kit pages, part prices, BOGO pages, research pages), a daily cap for
// the slow drip between scans, and a cool-down after a refusal. Pure: the clock, the sleep, the random draw and where the
// state is kept are injected (the agent keeps it in runtime.hdPace).
//
// What it answers to: scan 5 read 22 list pages and 25 bundle pages (three at a time, a second apart) and about 15 set item
// pages in some five minutes, and Home Depot then answered "Error Page". A refusal is never retried or worked around: the
// only fixes are to read less, slower, and in a better order. docs/decisions.md, "Home Depot's pace".

import { dayOf } from '../tracking/state';

/**
 * The least time between the end of one Home Depot read and the start of the next, in a scan: 10 s, plus a random
 * 0 to 5 s (HD_GAP_JITTER_MS) so the reads do not tick like a clock. A person reading product pages reads one every 10 to
 * 60 seconds; scan 5 read three at a time a second apart and was refused within minutes.
 */
export const HD_GAP_MS = 10_000;
/** The random part of every gap, 0 to this many ms, drawn for each read. */
export const HD_GAP_JITTER_MS = 5_000;
/**
 * Home Depot pages one scan reads at most, all kinds together (each list page, bundle page, set item page, kit page, BOGO
 * page and research page is one; a part price is two: its search and its page). Scan 5 was refused after about 62.
 */
export const HD_PAGES_PER_SCAN = 40;
/** After a refusal no Home Depot page is read for this long (the rest of the scan included). */
export const HD_COOLDOWN_MS = 30 * 60_000;
/** A refusal right after a cool-down doubles it (30 min, 1 h, 2 h, 4 h), never past this. */
export const HD_COOLDOWN_MAX_MS = 8 * 60 * 60_000;
/** Between scans (the drip) a page is read at most this often: at most 40 an hour. */
export const HD_DRIP_GAP_MS = 90_000;
/** Pages the drip reads between scans in one day, at most (six hours of its pace). */
export const HD_DRIP_PAGES_PER_DAY = 240;
/**
 * The adaptive ceiling between scans (Nov 25, the owner's live data: 80 pages read between 5:00 and 9:00 AM were refused
 * four times in a row, backing off to a four-hour pause; 40 an hour sustained is too fast). Each refusal halves the
 * hourly ceiling, never below this floor: 40, 20, 10. At 10 an hour (one page every 6 minutes) the three Buy now deals'
 * Home Depot checks (one each every 4 hours: under 1 an hour) still fit with room for the watched deals and the backlog.
 */
export const HD_DRIP_PER_HOUR_FLOOR = 10;
/** After a refusal the ceiling is not raised for the rest of that day; from the next day it rises by this much... */
export const HD_DRIP_RAISE_STEP = 5;
/** ...for each stretch this long with no refusal (from 10 back to 40: six stretches, 36 hours with no refusal). */
export const HD_DRIP_RAISE_AFTER_MS = 6 * 60 * 60_000;
/**
 * A Home Depot list (a brand's Bundle list, its keyword search, the BOGO listing) is read again only this long after it
 * was last read through: lists change slowly. 22 hours, not 24, so a scan at the same hour each day still reads it.
 */
export const HD_LIST_REREAD_MS = 22 * 60 * 60_000;

export interface HdLimits {
  gapMs: number;
  jitterMs: number;
  pagesPerScan: number;
  cooldownMs: number;
  cooldownMaxMs: number;
  dripGapMs: number;
  dripPagesPerDay: number;
  /** The adaptive ceiling's floor, step and stretch (HD_DRIP_PER_HOUR_FLOOR, HD_DRIP_RAISE_STEP, HD_DRIP_RAISE_AFTER_MS). */
  dripFloorPerHour: number;
  raiseStep: number;
  raiseAfterMs: number;
}

export const HD_LIMITS: HdLimits = {
  gapMs: HD_GAP_MS, jitterMs: HD_GAP_JITTER_MS, pagesPerScan: HD_PAGES_PER_SCAN, cooldownMs: HD_COOLDOWN_MS,
  cooldownMaxMs: HD_COOLDOWN_MAX_MS, dripGapMs: HD_DRIP_GAP_MS, dripPagesPerDay: HD_DRIP_PAGES_PER_DAY,
  dripFloorPerHour: HD_DRIP_PER_HOUR_FLOOR, raiseStep: HD_DRIP_RAISE_STEP, raiseAfterMs: HD_DRIP_RAISE_AFTER_MS,
};

/** What is kept between reads, and between runs of the app. */
export interface HdPaceState {
  /** When the last read ended (epoch ms); null before the first. */
  lastEndedAt: number | null;
  /** No Home Depot page is read before this (epoch ms); null when not paused. */
  pausedUntil: number | null;
  /** Refusals since the last page that was read: the next cool-down doubles for each. */
  refusals: number;
  /** The last refusal: when, and what was being read. */
  lastRefusal: { at: number; what: string } | null;
  /** The owner's local day (YYYY-MM-DD) `dripPages` counts. */
  day: string;
  /** Pages the drip read on `day`. */
  dripPages: number;
  /**
   * The hourly ceiling between scans as last set (halved by a refusal), and when; null: the full ceiling. The ceiling in
   * force is worked out from these and the clock (dripCeiling): it is not reset at midnight.
   */
  perHour?: number | null;
  perHourAt?: number | null;
}

export const NEW_PACE_STATE: HdPaceState = { lastEndedAt: null, pausedUntil: null, refusals: 0, lastRefusal: null, day: '', dripPages: 0, perHour: null, perHourAt: null };

/** A stored state in its checked shape; anything else is a new state (never a guess). */
export function paceStateOf(v: unknown): HdPaceState {
  if (!v || typeof v !== 'object') return { ...NEW_PACE_STATE };
  const s = v as Partial<HdPaceState>;
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const r = s.lastRefusal;
  return {
    lastEndedAt: num(s.lastEndedAt), pausedUntil: num(s.pausedUntil), refusals: Math.max(0, Math.floor(num(s.refusals) ?? 0)),
    lastRefusal: r && typeof r === 'object' && num(r.at) !== null && typeof r.what === 'string' ? { at: r.at, what: r.what.slice(0, 120) } : null,
    day: typeof s.day === 'string' ? s.day : '', dripPages: Math.max(0, Math.floor(num(s.dripPages) ?? 0)),
    perHour: num(s.perHour) !== null && num(s.perHour)! > 0 ? Math.floor(num(s.perHour)!) : null, perHourAt: num(s.perHourAt),
  };
}

/** The full ceiling between scans, from the drip's gap (3600 s / 90 s = 40 an hour). */
export const fullPerHour = (limits: Pick<HdLimits, 'dripGapMs'> = HD_LIMITS): number => Math.floor((60 * 60_000) / limits.dripGapMs);

/** Midnight (local) after `at`. */
const nextMidnight = (at: number): number => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

/**
 * The hourly ceiling between scans in force at `now`. A refusal set it (perHour, at perHourAt); for the rest of that day it
 * stays; from the next midnight on, each full stretch of `raiseAfterMs` with no refusal raises it by `raiseStep`, up to
 * the full ceiling. So a day starts from what the day before ended at. Pure.
 */
export function dripCeiling(s: Pick<HdPaceState, 'perHour' | 'perHourAt'>, now: number, limits: HdLimits = HD_LIMITS): number {
  const full = fullPerHour(limits);
  if (s.perHour === null || s.perHour === undefined || s.perHour >= full) return full;
  const from = s.perHourAt === null || s.perHourAt === undefined ? now : nextMidnight(s.perHourAt);
  const steps = now > from ? Math.floor((now - from) / limits.raiseAfterMs) : 0;
  return Math.min(full, s.perHour + steps * limits.raiseStep);
}

/** The ceiling after a refusal at a ceiling of `current`: halved, never below the floor. */
export const halvedCeiling = (current: number, limits: HdLimits = HD_LIMITS): number => Math.max(limits.dripFloorPerHour, Math.floor(current / 2));

/**
 * "between scans at most 40 are read an hour (240 a day)", or below the full ceiling "between scans at most 20 are read an
 * hour today, after Home Depot refused pages this morning (240 a day)". `refusedAt`: the last refusal.
 */
export function ceilingWords(perHour: number, refusedAt: number | null, now: number, limits: HdLimits = HD_LIMITS): string {
  const day = `(${limits.dripPagesPerDay} a day)`;
  if (perHour >= fullPerHour(limits) || refusedAt === null) return `between scans at most ${perHour} are read an hour ${day}`;
  const when = dayOf(refusedAt) === dayOf(now) ? `this ${partOfDay(refusedAt)}` : dayOf(refusedAt) === dayOf(now - 86_400_000) ? `yesterday ${partOfDay(refusedAt)}` : 'earlier';
  return `between scans at most ${perHour} are read an hour today, after Home Depot refused pages ${when} ${day}`;
}

const partOfDay = (at: number): string => {
  const h = new Date(at).getHours();
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
};

/**
 * A scan (or an owner's run: Read again, an AI question's research) reads at the scan gap within the scan cap; the drip at
 * its own gap within its daily cap; one page the owner asked for himself (a pasted link) at the scan gap, outside both caps.
 * Every mode keeps the cool-down.
 */
export type HdMode = 'scan' | 'drip' | 'owner';

export type HdBlock =
  /** A refusal started a cool-down: nothing is read before `until`. */
  | { reason: 'paused'; until: number }
  /** This scan's pages are used up. */
  | { reason: 'cap'; cap: number }
  /** The drip's pages for today are used up. */
  | { reason: 'daily'; cap: number };

/** A read that was not made because of the pace. Not a refusal: Home Depot was not asked. */
export class HdReadBlocked extends Error {
  constructor(readonly block: HdBlock, message = blockSentence(block)) {
    super(message);
    this.name = 'HdReadBlocked';
  }
}

/** A clock time in the owner's words ("6:40 PM"). The agent formats in the owner's time zone. */
export type ClockText = (at: number) => string;

const defaultClock: ClockText = (at) => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function blockSentence(b: HdBlock, clock: ClockText = defaultClock): string {
  if (b.reason === 'paused') return pausedSentence(b.until, clock);
  if (b.reason === 'cap') return `This scan read its ${b.cap} Home Depot pages; the rest are read between scans and next scan.`;
  return `Today's ${b.cap} Home Depot pages between scans are read; the rest continue tomorrow or in the next scan.`;
}

/** "Home Depot paused reading until 6:40 PM; the rest continue then." */
export const pausedSentence = (until: number, clock: ClockText = defaultClock): string =>
  `Home Depot paused reading until ${clock(until)}; the rest continue then.`;

/** How a read ended: read (the page came back), refused (Home Depot refused it), or failed (Chrome did not answer: not Home Depot). */
export type HdOutcome = 'read' | 'refused' | 'failed';

export interface HdTicket {
  /** Ends the read: records when, and a refusal starts the cool-down. Called once; later calls do nothing. */
  done(outcome: HdOutcome, what?: string): void;
}

export interface HdPaceDeps {
  now: () => number;
  /** Waits `ms`; rejects when `signal` fires. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 0 to 1, for the jitter. Default Math.random. */
  random?: () => number;
  load: () => HdPaceState;
  save: (s: HdPaceState) => void;
  limits?: Partial<HdLimits>;
}

/**
 * The one gate every Home Depot read goes through. One read at a time (a second waits for the first to end), the gap
 * kept from the end of the last read whatever its kind, the caps counted when a read starts (a read that is refused still
 * reached Home Depot), and a refusal pausing every read for the cool-down.
 */
export class HdPace {
  readonly limits: HdLimits;
  private runPages = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly d: HdPaceDeps) {
    this.limits = { ...HD_LIMITS, ...d.limits };
  }

  /** A scan (or an owner's run) starts: its page count starts from 0. */
  beginRun(): void {
    this.runPages = 0;
  }

  /** Pages the current run has read (asked for). */
  get pagesThisRun(): number {
    return this.runPages;
  }

  state(): HdPaceState {
    return this.today(this.d.load());
  }

  /** When reading continues after a refusal (epoch ms), or null when it is not paused. */
  pausedUntil(): number | null {
    const until = this.d.load().pausedUntil;
    return until !== null && until > this.d.now() ? until : null;
  }

  /** The hourly ceiling between scans in force now (dripCeiling). */
  dripPerHour(): number {
    return dripCeiling(this.d.load(), this.d.now(), this.limits);
  }

  /** The least time between two reads between scans now: an hour over the ceiling in force (90 s at 40, 6 min at 10). */
  dripGapMs(): number {
    return Math.max(this.limits.dripGapMs, Math.ceil((60 * 60_000) / this.dripPerHour()));
  }

  /** The words of the ceiling in force ("between scans at most 20 are read an hour today, after …"). */
  ceilingWords(): string {
    return ceilingWords(this.dripPerHour(), this.d.load().lastRefusal?.at ?? null, this.d.now(), this.limits);
  }

  /** Why no page may be read now in `mode`, or null. */
  blocked(mode: HdMode): HdBlock | null {
    const until = this.pausedUntil();
    if (until !== null) return { reason: 'paused', until };
    if (mode === 'scan' && this.runPages >= this.limits.pagesPerScan) return { reason: 'cap', cap: this.limits.pagesPerScan };
    if (mode === 'drip' && this.state().dripPages >= this.limits.dripPagesPerDay) return { reason: 'daily', cap: this.limits.dripPagesPerDay };
    return null;
  }

  /** Pages `mode` may still read: this run's (scan) or today's (drip); 0 while paused. */
  left(mode: HdMode): number {
    if (this.pausedUntil() !== null) return 0;
    if (mode === 'owner') return Number.POSITIVE_INFINITY;
    return mode === 'scan' ? Math.max(0, this.limits.pagesPerScan - this.runPages) : Math.max(0, this.limits.dripPagesPerDay - this.state().dripPages);
  }

  /**
   * Waits for the reads before it and for the gap, then counts one page and returns its ticket. Throws HdReadBlocked when
   * the pace allows no read now (nothing is counted), and what `sleep` throws when `signal` fires.
   */
  async take(mode: HdMode, signal?: AbortSignal): Promise<HdTicket> {
    const before = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => {
      release = r;
    });
    await before;
    try {
      let block = this.blocked(mode);
      if (block) throw new HdReadBlocked(block);
      const last = this.d.load().lastEndedAt;
      const gap = (mode === 'drip' ? this.dripGapMs() : this.limits.gapMs) + Math.floor((this.d.random ?? Math.random)() * this.limits.jitterMs);
      const wait = last === null ? 0 : last + gap - this.d.now();
      if (wait > 0) await this.d.sleep(wait, signal);
      if (signal?.aborted) throw new Error('stopped');
      block = this.blocked(mode);
      if (block) throw new HdReadBlocked(block);
      if (mode === 'scan') this.runPages += 1;
      else if (mode === 'drip') {
        const s = this.state();
        this.d.save({ ...s, dripPages: s.dripPages + 1 });
      }
    } catch (e) {
      release();
      throw e;
    }
    let ended = false;
    return {
      done: (outcome, what) => {
        if (ended) return;
        ended = true;
        try {
          this.end(outcome, what ?? 'a page');
        } finally {
          release();
        }
      },
    };
  }

  private end(outcome: HdOutcome, what: string): void {
    const at = this.d.now();
    const s = this.today(this.d.load());
    if (outcome === 'refused') {
      const refusals = s.refusals + 1;
      const pause = Math.min(this.limits.cooldownMaxMs, this.limits.cooldownMs * 2 ** (refusals - 1));
      // The adaptive ceiling: halved from the one in force, for the rest of the day (dripCeiling).
      const perHour = halvedCeiling(dripCeiling(s, at, this.limits), this.limits);
      this.d.save({ ...s, lastEndedAt: at, refusals, pausedUntil: at + pause, lastRefusal: { at, what: what.slice(0, 120) }, perHour, perHourAt: at });
    } else if (outcome === 'read') {
      this.d.save({ ...s, lastEndedAt: at, refusals: 0, pausedUntil: null });
    } else this.d.save({ ...s, lastEndedAt: at });
  }

  /** The state with the drip's count of another day reset. */
  private today(s: HdPaceState): HdPaceState {
    const day = dayOf(this.d.now());
    return s.day === day ? s : { ...s, day, dripPages: 0 };
  }
}

/** Pages the drip reads in an hour at most, from its gap (3600 s / 90 s = 40). */
export const dripPagesPerHour = (limits: Pick<HdLimits, 'dripGapMs'> = HD_LIMITS): number => Math.floor((60 * 60_000) / limits.dripGapMs);

/**
 * The honest words for what waits: "139 sets wait for 220 Home Depot pages; between scans at most 40 are read an hour
 * (240 a day), and each scan reads up to 40." While paused, the pause leads. Nothing when no page waits. Every figure comes
 * from the constants and the count; no time to finish is promised.
 */
export function backlogSentence(i: {
  pages: number; sets: number; bundles?: number; pausedUntil: number | null; limits?: HdLimits; clock?: ClockText; dripOn?: boolean;
  /** The ceiling in force (HdPace.ceilingWords): absent, the full one. */
  ceiling?: string;
}): string | null {
  if (i.pages <= 0) return null;
  const limits = i.limits ?? HD_LIMITS;
  const who = [
    ...(i.sets > 0 ? [`${i.sets} ${i.sets === 1 ? 'set' : 'sets'}`] : []),
    ...((i.bundles ?? 0) > 0 ? [`${i.bundles} ${i.bundles === 1 ? 'bundle' : 'bundles'}`] : []),
  ];
  const pages = `${i.pages} Home Depot ${i.pages === 1 ? 'page' : 'pages'}`;
  const waiting = who.length > 0 ? `${who.join(' and ')} ${i.sets + (i.bundles ?? 0) === 1 ? 'waits' : 'wait'} for ${pages}` : `${pages} ${i.pages === 1 ? 'waits' : 'wait'}`;
  const pace = i.dripOn === false
    ? `each scan reads up to ${limits.pagesPerScan}`
    : `${i.ceiling ?? `between scans at most ${dripPagesPerHour(limits)} are read an hour (${limits.dripPagesPerDay} a day)`}, and each scan reads up to ${limits.pagesPerScan}`;
  const head = `${waiting}; ${pace}.`;
  return i.pausedUntil !== null ? `${pausedSentence(i.pausedUntil, i.clock)} ${head}` : head;
}

/**
 * The shortest time the drip alone needs for `pages` at these limits, in hours: its hourly pace, and no more than its daily
 * cap each day. A floor, not a promise: scans read more, a refusal pauses.
 */
export function dripHoursFor(pages: number, limits: HdLimits = HD_LIMITS): number {
  if (pages <= 0) return 0;
  const perHour = dripPagesPerHour(limits);
  const perDay = Math.min(limits.dripPagesPerDay, perHour * 24);
  const fullDays = Math.floor(pages / perDay);
  const rest = pages - fullDays * perDay;
  return fullDays * 24 + rest / perHour;
}
