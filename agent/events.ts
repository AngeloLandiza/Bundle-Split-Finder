// GET /api/events: server-sent events to the desktop UI and the shell (step 13). Each event is
// `id`, `event: <name>` and one `data:` line of JSON; a comment line every 20 s keeps idle
// connections open through anything that times them out.

import type { ServerResponse } from 'node:http';

import type { AgentEventName, AgentEvents } from '../core/src/api/contract';

export const PING_MS = 20_000;

/** W4: the data object also says its own name (`type`), and a `state` event carries the state whole as `state` too. */
export function formatEvent(id: number, name: string, data: unknown): string {
  const body = typeof data === 'object' && data !== null && !Array.isArray(data) ? { ...data, type: name, ...(name === 'state' ? { state: data } : {}) } : data;
  return `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(body)}\n\n`;
}

export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private nextId = 1;
  private pinger: ReturnType<typeof setInterval> | null = null;

  /** Opens the stream on `res` and keeps it until the client goes away. `first` is sent at once. */
  attach(res: ServerResponse, first?: { name: AgentEventName; data: unknown }): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    if (first) res.write(formatEvent(this.nextId++, first.name, first.data));
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
    if (!this.pinger) {
      this.pinger = setInterval(() => {
        for (const c of this.clients) c.write(': ping\n\n');
      }, PING_MS);
      this.pinger.unref?.();
    }
  }

  publish<K extends AgentEventName>(name: K, data: AgentEvents[K]): void {
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
  }
}
