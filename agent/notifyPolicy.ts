// D2: which messages reach the owner and when (settings.notifications). Pure of I/O: the clock, the settings and the
// emit function are handed in, so tests drive it with a fake clock. Local time throughout (the owner's quiet hours are
// the Mac's clock). Held messages live in memory: a restart forgets them (the run's own state is in Deals and Review).
//
//   kind off          no notify event of that kind
//   quiet hours       events are held and sent as one at the end; 'scan' events are dropped
//   digest 'morning'  the run digests (deal, review, autopilot) wait for morningAt, then go as one message
//   digest 'off'      the run digests are not sent, to Telegram either
// Telegram follows the digest setting only; quiet hours and the kinds are about the Mac's notifications.

import type { NotificationSettings, NotifyEvent } from '../core/src/api/contract';

type Emit = Omit<NotifyEvent, 'id'>;
type Held = { event: Emit; text: string };

export interface PolicyDeps {
  settings: () => NotificationSettings;
  now: () => number;
  emit: (event: Emit) => void;
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** One message from several: the bodies in order, the counts added, one route only when they all agree. */
function merge(items: Emit[]): Emit {
  if (items.length === 1) return items[0]!;
  const kinds = new Set(items.map((e) => e.kind));
  const routes = new Set(items.map((e) => e.route));
  const counted = items.filter((e) => e.count !== undefined);
  return {
    kind: items.some((e) => e.kind === 'review') ? 'review' : items[0]!.kind,
    title: 'Split Finder',
    body: [...new Set(items.map((e) => e.body))].join('\n'),
    ...(counted.length ? { count: counted.reduce((n, e) => n + (e.count ?? 0), 0) } : {}),
    route: kinds.size === 1 && routes.size === 1 ? items[0]!.route : '/',
  };
}

export class NotifyPolicy {
  private quiet: Emit[] = [];
  private morning: Held[] = [];
  private morningDay: string | null = null;

  constructor(private readonly d: PolicyDeps) {}

  inQuietHours(at = this.d.now()): boolean {
    const q = this.d.settings().quietHours;
    if (!q.enabled) return false;
    const from = minutesOf(q.from);
    const to = minutesOf(q.to);
    if (from === to) return false;
    const date = new Date(at);
    const now = date.getHours() * 60 + date.getMinutes();
    return from < to ? now >= from && now < to : now >= from || now < to;
  }

  /** An event that is not a run digest (a test, an error): the kind switch, then quiet hours. */
  send(event: Emit): void {
    if (!this.d.settings().kinds[event.kind]) return;
    if (this.inQuietHours()) {
      if (event.kind !== 'scan') this.quiet.push(event);
      return;
    }
    this.d.emit(event);
  }

  /**
   * The run's digest. Returns the text Telegram should get now (null: none now). The notification goes out, is held
   * for quiet hours, or waits for the morning, as the settings say.
   */
  digest(event: Emit, text: string): string | null {
    const mode = this.d.settings().digest;
    if (mode === 'off') return null;
    if (mode === 'morning') {
      this.morning.push({ event, text });
      return null;
    }
    this.send(event);
    return text;
  }

  /**
   * Called on the clock: ends quiet hours and the morning's wait. Returns the Telegram text due now (the morning
   * digest), or null.
   */
  flush(): string | null {
    const s = this.d.settings();
    if (this.quiet.length > 0 && !this.inQuietHours()) {
      const held = this.quiet;
      this.quiet = [];
      this.d.emit(merge(held));
    }
    if (s.digest !== 'morning') return null;
    const date = new Date(this.d.now());
    if (this.morningDay === dayKey(date) || date.getHours() * 60 + date.getMinutes() < minutesOf(s.morningAt)) return null;
    this.morningDay = dayKey(date);
    if (this.morning.length === 0) return null;
    const items = this.morning;
    this.morning = [];
    const shown = items.filter((i) => s.kinds[i.event.kind]).map((i) => i.event);
    if (shown.length > 0) this.send(merge(shown));
    return [...new Set(items.map((i) => i.text))].join('\n');
  }
}
