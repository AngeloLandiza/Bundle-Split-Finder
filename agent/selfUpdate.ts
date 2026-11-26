// Nov 25, self-update: the agent's half (docs/decisions.md, "The app updates itself from GitHub releases").
//
// The shell (src-tauri/src/updater.rs) looks at GitHub, downloads and verifies; it never decides alone when to install.
// It tells the agent what it found (POST /api/update/report), offers a verified update every 20 s (POST
// /api/update/pending) and installs only when the answer says now (core/src/release/update.ts installDecision). The agent
// keeps what the owner sees: Settings' "last checked", the notices ("Version X is ready" with Install now; after an
// update "Split Finder was updated to X"), and one Activity line for each thing that happened.
//
// What the shell sends is untrusted text from the network (a version, notes, an error): checked and cut to size in core,
// and scrubbed of every stored key here before it is kept. Nothing here downloads or runs anything.

import type { UpdateNotice, UpdaterState, VersionEntry } from '../core/src/api/contract';
import { parseSemver } from '../core/src/release/note';
import {
  checkFailedSentence, installDecision, notInstalledSentence, PENDING_FRESH_MS, readyMessage, readyTitle, updatedTitle,
  type CheckReport, type InstallDecision, type PendingReport, type RunningWork,
} from '../core/src/release/update';
import type { SelfUpdateRuntime, Store, StoredKeys } from './store';

const KEEP = 20;

const EMPTY: SelfUpdateRuntime = { checkedAt: null, outcome: null, installing: null, updated: null, requested: null, announced: [] };

/** Why a copy cannot update itself, as Settings says it (the shell's SPLIT_FINDER_UPDATER). */
export function updaterWhy(availability: string | null): string | undefined {
  if (availability === 'on') return undefined;
  if (availability === 'no-key') return 'This copy was built without the update key, so it cannot update itself. It tells you when a new version is ready, with a link.';
  if (availability === 'dev') return 'A development build does not update itself.';
  return 'Updates work only in the installed app.';
}

export interface SelfUpdateDeps {
  store: Store;
  now: () => number;
  /** The running app's version (x.y.z), null outside the app. */
  appVersion: string | null;
  /** The shell's SPLIT_FINDER_UPDATER: "on", or why not ("dev", "no-key"); null when no shell said. */
  availability: string | null;
  /** What is running now (work.ts), or null when nothing is. */
  working: () => RunningWork;
  nextScanAt: () => string | null;
  /** The new-version message on the channels the owner has on (work.ts announceVersion). */
  announce: (text: string) => Promise<void>;
  /** Removes every stored key from a sentence (work.ts scrub). */
  scrub: (text: string, keys: StoredKeys) => string;
  changed: () => void;
}

export class SelfUpdate {
  /** What the shell holds now, from its last offer. Memory only: a shell that stops offering it no longer has it. */
  private pending: (PendingReport & { at: number }) | null = null;
  private lastWhy: string | undefined;

  constructor(private readonly d: SelfUpdateDeps) {}

  get can(): boolean {
    return this.d.availability === 'on';
  }

  private rt(): SelfUpdateRuntime {
    return { ...EMPTY, ...(this.d.store.get('runtime').selfUpdate ?? {}) };
  }

  private save(patch: Partial<SelfUpdateRuntime>): void {
    this.d.store.update('runtime', (r) => ({ ...r, selfUpdate: { ...EMPTY, ...(r.selfUpdate ?? {}), ...patch } }));
  }

  /** One line in Activity's "New versions", scrubbed of every stored key. */
  private record(version: string, sentence: string): void {
    const clean = this.d.scrub(sentence, this.d.store.get('keys'));
    const entry: VersionEntry = { id: `upd-${version}-${this.d.now()}`, at: new Date(this.d.now()).toISOString(), version, sentence: clean };
    this.d.store.update('runtime', (r) => {
      const rel = r.release ?? { checkedAt: null, latest: null, announced: [], dismissed: [], history: [] };
      return { ...r, release: { ...rel, history: [...rel.history, entry].slice(-KEEP) } };
    });
  }

  private lastSentence(): string | undefined {
    return this.d.store.get('runtime').release?.history.at(-1)?.sentence;
  }

  private settings(): { looking: boolean; automatic: boolean } {
    const u = this.d.store.get('settings').updates;
    return { looking: u?.tellMeAboutNewVersion !== false, automatic: u?.installAutomatically !== false };
  }

  /**
   * At start: an install that began before this start either finished (the app now runs that version: the calm notice
   * and an Activity line) or did not (still the old version: one Activity line). Either way the note is cleared.
   */
  atStart(): void {
    const { installing } = this.rt();
    if (!installing) return;
    if (this.d.appVersion !== null && this.d.appVersion === installing.version) {
      this.save({ installing: null, requested: null, updated: { version: installing.version, notes: installing.notes } });
      this.record(installing.version, updatedTitle(installing.version));
    } else {
      this.save({ installing: null, requested: null });
      this.record(installing.version, notInstalledSentence(installing.version, this.d.appVersion ?? installing.from));
    }
    this.d.changed();
  }

  /** POST /api/update/report: a look found nothing newer, or failed (one Activity line, not repeated while it is the last). */
  report(r: CheckReport): void {
    this.save({ checkedAt: this.d.now(), outcome: r.outcome });
    if (r.outcome === 'failed') {
      const sentence = this.d.scrub(checkFailedSentence(r.why), this.d.store.get('keys'));
      if (this.lastSentence() !== sentence) this.record(this.d.appVersion ?? '', sentence);
    }
    this.d.changed();
  }

  /**
   * POST /api/update/pending: the shell holds a verified update and asks whether to install now. Yes is written down first
   * (the version, its notes, the version installing it), so the next start can say whether it finished.
   */
  async offer(p: PendingReport): Promise<InstallDecision> {
    const first = this.pending?.version !== p.version;
    this.pending = { ...p, at: this.d.now() };
    const rt = this.rt();
    if (first) this.save({ checkedAt: this.d.now(), outcome: 'found' });
    const { looking, automatic } = this.settings();
    const decision = installDecision({
      running: this.d.appVersion, candidate: p.version, now: this.d.now(), looking, automatic, requested: rt.requested === p.version,
      working: this.d.working(), nextScanAt: this.d.nextScanAt(),
    });
    if (decision.install) {
      this.save({ installing: { version: p.version, from: this.d.appVersion ?? '', notes: p.notes, at: this.d.now() }, requested: null, updated: null });
      this.d.changed();
      return decision;
    }
    const why = decision.wait === 'owner' ? undefined : decision.why;
    const notice = this.lastWhy !== why;
    this.lastWhy = why;
    // Waiting for him: told once per version, in Activity and on his channels (the "new version" kind switch).
    if (decision.wait === 'owner' && !rt.announced.includes(p.version)) {
      this.save({ announced: [...rt.announced, p.version].slice(-KEEP) });
      this.record(p.version, readyTitle(p.version));
      await this.d.announce(readyMessage(p.version, p.notes)).catch(() => undefined);
      this.d.changed();
    } else if (first || notice) {
      this.d.changed();
    }
    return decision;
  }

  /** The update the shell holds now (offered within PENDING_FRESH_MS), if it is newer than the running version. */
  ready(): (PendingReport & { at: number }) | null {
    const p = this.pending;
    if (!p || this.d.now() - p.at > PENDING_FRESH_MS) return null;
    if (installDecision({ running: this.d.appVersion, candidate: p.version, now: 0, looking: true, automatic: true, requested: true, working: null, nextScanAt: null }).install !== true) return null;
    return p;
  }

  /** POST /api/update/install-now: he pressed Install now. It installs at the shell's next offer, once nothing is running. */
  installNow(version: string): { ok: true } | { ok: false; why: string } {
    const p = this.ready();
    if (!p || p.version !== version) return { ok: false, why: `Version ${version} is not downloaded yet. Split Finder looks again within 6 hours.` };
    this.save({ requested: version });
    this.d.changed();
    return { ok: true };
  }

  /** He closed the notice. An "updated" notice is gone for good; a "ready" one is closed for that version (versionCheck's list). */
  dismiss(version: string): void {
    const rt = this.rt();
    if (rt.updated?.version === version) this.save({ updated: null });
  }

  /** The notice for the window, or undefined. */
  notice(dismissed: readonly string[]): UpdateNotice | undefined {
    const rt = this.rt();
    const date = new Date(this.d.now()).toLocaleDateString('en-CA');
    if (rt.updated) return { kind: 'updated', version: rt.updated.version, date, notes: rt.updated.notes, link: null };
    const p = this.ready();
    if (!p || dismissed.includes(p.version)) return undefined;
    const { looking, automatic } = this.settings();
    if (!looking) return undefined;
    // Installing by itself: nothing to say before it has happened.
    if (automatic && rt.requested !== p.version) return undefined;
    const waiting = rt.requested === p.version ? this.lastWhy : undefined;
    return { kind: 'ready', version: p.version, date, notes: p.notes, link: null, ...(waiting ? { waiting } : {}) };
  }

  /** Settings, General. */
  state(): UpdaterState {
    const rt = this.rt();
    const why = this.can ? undefined : updaterWhy(this.d.availability);
    const ready = this.ready();
    return {
      can: this.can,
      ...(why ? { why } : {}),
      version: parseSemver(this.d.appVersion) ? this.d.appVersion : null,
      checkedAt: rt.checkedAt === null ? null : new Date(rt.checkedAt).toISOString(),
      outcome: rt.outcome,
      ...(ready ? { ready: ready.version } : {}),
    };
  }
}
