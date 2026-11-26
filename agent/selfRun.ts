// Running without the owner (Nov 25): he scheduled a 7:00 scan and wants it to happen without him. This keeps the three things that
// takes besides the schedule itself: Chrome open when a scan needs it, "Open at login" on once, and a weekly summary.
// It never changes a power setting (a sleeping computer cannot scan; the catch-up says so afterwards), never opens anything but his
// ordinary Chrome, and never closes a Chrome it did not open. The rules are core/src/selfRun; this file reads the stores and acts.

import type { Purchase } from '../core/src/api/contract';
import {
  attemptSentence, chromeWanted, connectedSentence, type ChromeAttempt, mayScanWithoutChrome, chromeSentence,
} from '../core/src/selfRun/chrome';
import { weekUse, weekUseByKey, weeklyDecision, weeklyOf, weeklySummary, type WeeklySummary } from '../core/src/selfRun/weekly';
import { localDate } from '../core/src/costs/time';
import type { CostBook } from './costs';
import type { ChromeControl } from './openChrome';
import type { SelfRunRuntime, Store } from './store';
import { asksAboutEbay, openReviewCount } from './views';

export interface SelfRunDeps {
  store: Store;
  now: () => number;
  /** Absent: Chrome is never started (tests that do not give a fake; a dev agent). */
  chrome?: ChromeControl;
  helperConnected: () => boolean;
  /** When the next scheduled scan is due (ISO), or null. */
  nextScanAt: () => string | null;
  /** A scan, a drip round or an answer is working now. */
  busy: () => boolean;
  /** Reads waiting for the helper. */
  jobsWaiting: () => number;
  hdPausedUntil: () => number | null;
  /** One sentence in Activity. */
  record: (sentence: string) => void;
  changed: () => void;
  costs: Pick<CostBook, 'input' | 'view'>;
  /** The weekly message, on each channel the owner has on. */
  announceWeekly: (summary: WeeklySummary) => Promise<void>;
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export class SelfRun {
  private chromeBusy = false;
  private weeklyBusy = false;

  constructor(private readonly d: SelfRunDeps) {}

  private rt(): SelfRunRuntime {
    return this.d.store.get('runtime').selfRun ?? {};
  }

  private set(patch: Partial<SelfRunRuntime>): void {
    this.d.store.update('runtime', (r) => ({ ...r, selfRun: { ...(r.selfRun ?? {}), ...patch } }));
  }

  /** The scheduler's look, every tick. Never throws: a failure here must not stop a scan. */
  async tick(): Promise<void> {
    try {
      this.login();
      await this.chromeStep();
      await this.weeklyStep();
    } catch {
      // The step's own record says what failed; the schedule goes on.
    }
  }

  // ------------------------------------------------------------------ Chrome

  /** The scan the schedule counts next, by its anchor: the same until that scan starts (so one try to open Chrome for each). */
  scanKey(): string {
    const r = this.d.store.get('runtime');
    const anchors = [r.lastScheduledRunAt, r.scheduleFrom ?? null].filter((t): t is number => t !== null);
    return `scan:${anchors.length ? Math.max(...anchors) : 0}`;
  }

  /** The app tried to start Chrome for the next scan and the wait is over (or the start failed): the scan may go on without it. */
  mayScanWithoutChrome(): boolean {
    return mayScanWithoutChrome(this.rt().chrome, this.scanKey(), this.d.now(), this.d.helperConnected());
  }

  /** The sentence for the scan with this key (its `scanKey()` from before it started) that ran without Chrome after the app tried to open it, or null. */
  closedSentence(key: string): string | null {
    return chromeSentence(this.rt().chrome, key);
  }

  private async chromeStep(): Promise<void> {
    const { chrome, store } = this.d;
    if (!chrome || this.chromeBusy) return;
    this.chromeBusy = true;
    try {
      const now = this.d.now();
      const settings = store.get('settings');
      const connected = this.d.helperConnected();
      let last = this.rt().chrome;

      // The helper came up after the app started Chrome: one line in Activity.
      if (connected && last && last.result === 'started' && last.connectedAt === undefined && now - last.at < 60 * 60_000) {
        last = { ...last, connectedAt: now };
        this.set({ chrome: last });
        this.d.record(connectedSentence(last));
      }

      // How long Home Depot pages have waited with Chrome closed.
      const pages = store.get('runtime').hdBacklog?.pages ?? 0;
      const dripOn = settings.lookups?.drip !== false;
      const waiting = !connected && dripOn && pages > 0;
      const since = this.rt().pagesWaitingSince ?? null;
      if (waiting && since === null) this.set({ pagesWaitingSince: now });
      else if (!waiting && since !== null) this.set({ pagesWaitingSince: null });

      await this.closeAfterScan(last, settings.scan?.closeChromeAfter === true);

      const next = this.d.nextScanAt();
      const nextAt = next === null ? null : Date.parse(next);
      const wanted = chromeWanted({
        now, setting: settings.scan?.openChrome !== false, scheduled: settings.settings.schedule.mode !== 'manual', paused: store.get('agent').paused,
        helperConnected: connected, busy: this.d.busy(), nextScanAt: nextAt, scanKey: this.scanKey(),
        pagesWaitingSince: waiting ? since ?? now : null, hdPausedUntil: this.d.hdPausedUntil(), today: localDate(now), last,
      });
      if (!wanted) return;

      // Only a Chrome the app starts is one it may close later: note whether one was running.
      const wasRunning = await chrome.running().catch(() => true);
      const result = await chrome.open().catch(() => ({ ok: false as const, why: 'Chrome could not be started.' }));
      const attempt: ChromeAttempt = {
        key: wanted.key, reason: wanted.reason, at: this.d.now(), result: result.ok ? 'started' : 'failed', weStarted: result.ok && !wasRunning,
        ...(result.ok ? {} : { why: result.why }),
      };
      this.set({ chrome: attempt });
      this.d.record(attemptSentence(attempt, wanted.reason === 'scan' && nextAt !== null && nextAt > now ? clock(nextAt) : null));
      this.d.changed();
    } finally {
      this.chromeBusy = false;
    }
  }

  /**
   * After the scan the Chrome was started for: quit it, when the owner chose that and the app started it. Never a Chrome that was
   * already running, never while anything is working or a read waits, and once.
   */
  private async closeAfterScan(last: ChromeAttempt | undefined, wanted: boolean): Promise<void> {
    const { chrome, store } = this.d;
    if (!chrome || !wanted || !last || !last.weStarted || last.result !== 'started' || last.reason !== 'scan' || last.closedAt !== undefined) return;
    const ran = store.get('runtime').lastScheduledRunAt;
    if (ran === null || ran <= last.at || this.d.busy() || this.d.jobsWaiting() > 0) return;
    const closedAt = this.d.now();
    this.set({ chrome: { ...last, closedAt } });
    if (await chrome.quit().catch(() => false)) this.d.record('Closed the Chrome that Split Finder opened for the scan.');
  }

  // ------------------------------------------------------------------ open at login

  /**
   * With a schedule set, the app starts with the computer: a scan at 7:00 needs it running. Looked at once, the first time a schedule
   * is seen: off becomes on, with a line in Activity and a quiet notice offering Turn off. Never again, so a switch he turns off
   * stays off; a manual schedule is left alone.
   */
  login(): void {
    if (this.rt().login) return;
    const s = this.d.store.get('settings');
    if (s.settings.schedule.mode === 'manual') return;
    const now = this.d.now();
    if (s.shell.launchAtLogin) {
      this.set({ login: { at: now, turnedOn: false } });
      return;
    }
    this.d.store.update('settings', (cur) => ({ ...cur, shell: { ...cur.shell, launchAtLogin: true }, updatedAt: new Date(now).toISOString() }));
    this.set({ login: { at: now, turnedOn: true }, loginNotice: true });
    this.d.record('Open at login is on, because you set a schedule: scans run only while Split Finder is running. Turn it off in Settings, General.');
    this.d.changed();
  }

  /** The owner closed the notice; `turnOff` also turns the setting off (he stays in charge: it is not turned on again). */
  answerLoginNotice(turnOff: boolean): void {
    if (turnOff) {
      this.d.store.update('settings', (cur) => ({ ...cur, shell: { ...cur.shell, launchAtLogin: false }, updatedAt: new Date(this.d.now()).toISOString() }));
      this.d.record('Open at login is off, as you chose.');
    }
    this.set({ loginNotice: false });
    this.d.changed();
  }

  // ------------------------------------------------------------------ the weekly summary

  private async weeklyStep(): Promise<void> {
    if (this.weeklyBusy) return;
    this.weeklyBusy = true;
    try {
      const { store } = this.d;
      const now = this.d.now();
      const s = store.get('settings');
      const decision = weeklyDecision(now, weeklyOf(s.notifications), this.rt().weekly);
      if (decision.action === 'none') return;
      if (decision.action === 'seed') {
        this.set({ weekly: decision.sent });
        return;
      }
      // Recorded before it is sent: a restart in between loses one message, never sends two. With the kind off it is passed over.
      this.set({ weekly: { key: decision.key, at: now } });
      if (!s.notifications.kinds.weekly) return;
      await this.d.announceWeekly(this.summary(decision.from, now));
    } finally {
      this.weeklyBusy = false;
    }
  }

  /** The summary for a period, built from the stores as they are now. */
  summary(from: number, now: number): WeeklySummary {
    const { store } = this.d;
    const costsInput = this.d.costs.input();
    return weeklySummary({
      now, from,
      bundles: store.get('deals').bundles,
      tracking: store.get('tracking'),
      purchases: store.get('outcomes').purchases as Purchase[],
      openQuestions: openReviewCount(store.get('review'), asksAboutEbay(store.get('settings'))),
      costs: this.d.costs.view(),
      week: weekUse(costsInput, from, now),
      weekByKey: weekUseByKey(costsInput, from, now),
      runs: store.get('activity').runs,
      pagesWaiting: store.get('runtime').hdBacklog?.pages ?? null,
      paused: store.get('agent').paused,
    });
  }
}
