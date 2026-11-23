import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

/** Minimal HTTP exercise of agent routes without importing server.ts listen side-effect. */
describe('agent HTTP surface', () => {
  let server: Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  it('responds on scan start and pending', async () => {
    const { requestScan, peekPendingScan, clearPendingScan } = await import('../scanQueue');
    clearPendingScan();
    server = createServer((req, res) => {
      if (req.url === '/api/scan/start' && req.method === 'POST') {
        const pending = requestScan();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, pending }));
        return;
      }
      if (req.url === '/api/scan/pending' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, pending: peekPendingScan() }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const start = await fetch(`http://127.0.0.1:${port}/api/scan/start`, { method: 'POST' });
    const body = (await start.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const pending = await fetch(`http://127.0.0.1:${port}/api/scan/pending`);
    const peek = (await pending.json()) as { pending: { id: string } | null };
    expect(peek.pending).not.toBeNull();
    clearPendingScan();
  });
});