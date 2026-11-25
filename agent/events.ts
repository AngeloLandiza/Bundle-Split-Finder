// GET /api/events: server-sent events to the desktop UI and the shell (step 13). Each event is
// `id`, `event: <name>` and one `data:` line of JSON; a comment line every 20 s keeps idle
// connections open through anything that times them out.

import type { ServerResponse } from 'node:http';

import type { AgentEventName, AgentEvents } from '../core/src/api/contract';

export const PING_MS = 20_000;
/** Nov 25, supervision: notify events kept while the shell is not listening (it reconnects after the agent restarts). */
export const HELD_NOTIFY_MAX = 5;
export const HELD_NOTIFY_MS = 10 * 60_000;

/** W4: the data object also says its own name (`type`), and a `state` event carries the state whole as `state` too. */
export function formatEvent(id: number, name: string, data: unknown): string {
  const body = typeof data === 'object' && data !== null && !Array.isArray(data) ? { ...data, type: name, ...(name === 'state' ? { state: data } : {}) } : data;
  return `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(body)}\n\n`;
}

export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  /** The desktop shell's streams (`GET /api/events?client=shell`): the ones that turn notify into a system notification. */
  private readonly shells = new Set<ServerResponse>();
  /** Notify events published while no shell stream was open, with when; the next shell stream gets them. */
  private held: { at: number; data: unknown }[] = [];
  private nextId = 1;
  private pinger: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Opens the stream on `res` and keeps it until the client goes away. `first` is sent at once. A shell stream also gets
   * the notify events held while no shell listened (at most HELD_NOTIFY_MAX, none older than HELD_NOTIFY_MS): after the
   * agent restarts, its first message is published before the shell has reconnected.
   */
  attach(res: ServerResponse, first?: { name: AgentEventName; data: unknown }, opts: { shell?: boolean } = {}): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    if (first) res.write(formatEvent(this.nextId++, first.name, first.data));
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
      this.shells.delete(res);
    });
    if (opts.shell) {
      this.shells.add(res);
      const since = this.now() - HELD_NOTIFY_MS;
      for (const h of this.held.splice(0)) if (h.at >= since) res.write(formatEvent(this.nextId++, 'notify', h.data));
    }
    if (!this.pinger) {
      this.pinger = setInterval(() => {
        for (const c of this.clients) c.write(': ping\n\n');
      }, PING_MS);
      this.pinger.unref?.();
    }
  }

  publish<K extends AgentEventName>(name: K, data: AgentEvents[K]): void {
    if (name === 'notify' && this.shells.size === 0) this.held = [...this.held, { at: this.now(), data }].slice(-HELD_NOTIFY_MAX);
    if (!this.clients.size) return;
    const text = formatEvent(this.nextId++, name, data);
    for (const c of this.clients) c.write(text);
  }

  get size(): number {
    return this.clients.size;
  }

  close(): void {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.shells.clear();
    this.held = [];
  }
}
