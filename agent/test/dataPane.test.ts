import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bundleKey } from '../../core/src/scan/types';
import { createAgent, type Agent } from '../app';

const SERP = 'serp-secret-0123456789abcdef';
const ANTHROPIC = 'sk-ant-secret-ZYXWVUTSRQP';
const TELEGRAM = '123456789:AAEhBP-telegram-secret';

let server: Server;
let agent: Agent;
let base: string;
let dir: string;

beforeEach(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  dir = mkdtempSync(join(tmpdir(), 'sf-data-'));
  agent = createAgent({ dataDir: dir, port, timers: false, shippedHelperVersion: null });
  server.on('request', agent.handle);
  agent.store.update('keys', (k) => ({ ...k, serpapi: SERP, anthropic: ANTHROPIC, telegram: { botToken: TELEGRAM, chatId: '42' } }));
});

afterEach(async () => {
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

async function plant(): Promise<void> {
  await agent.work.scanStore.putBundle({
    key: bundleKey('1'), retailer: 'homedepot', itemId: '1', title: `RYOBI kit ${SERP}`, brand: 'RYOBI', model: 'PCL1600K2',
    upc: null, price: 50, regularPrice: 90, percentOff: 44, link: null, seenAt: 1, split: { components: ['PCL1600K2'], status: 'resolved', notes: [`page said ${ANTHROPIC}`] },
  });
  agent.store.update('activity', (a) => ({
    ...a, errors: [{ id: 'err-1', at: '2026-11-23T00:00:00.000Z', sentence: `Request failed: https://x.test/?api_key=${SERP} and ${TELEGRAM}`, retry: null, resolvedAt: null }],
  }));
}

describe('GET /api/export/audit', () => {
  it('is a ui route', async () => {
    expect((await fetch(`${base}/api/export/audit`)).status).toBe(401);
  });

  it('holds the scan store, deals and activity, and no key even when one is planted in an error and a page text', async () => {
    await plant();
    const res = await ui('/api/export/audit');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="split-finder-audit-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = await res.text();
    for (const secret of [SERP, ANTHROPIC, TELEGRAM, '123456789:']) expect(text).not.toContain(secret);
    const file = JSON.parse(text) as { scanStore: { bundles: { title: string }[] }; activity: { errors: { sentence: string }[] }; keysSet: Record<string, boolean>; settings: object; app: { platform: string } };
    expect(file.scanStore.bundles[0]!.title).toBe('RYOBI kit [key]');
    expect(file.activity.errors[0]!.sentence).toContain('[key]');
    expect(file.keysSet).toMatchObject({ serpapi: true, keepa: false, telegram: true });
    expect(file.app.platform).toBeTruthy();
    expect(Object.keys(file.settings)).not.toContain('keys');
  });

  it('fails closed with a plain error when a key still shows (a key that is a number elsewhere)', async () => {
    agent.store.update('keys', (k) => ({ ...k, keepa: '987654321' }));
    await agent.work.scanStore.putBundle({
      key: bundleKey('2'), retailer: 'homedepot', itemId: '2', title: 'kit', brand: 'RYOBI', model: 'M', upc: null, price: 987654321, regularPrice: null, percentOff: null, link: null, seenAt: 1, split: null,
    });
    const res = await ui('/api/export/audit');
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('987654321');
  });
});

describe('POST /api/data/reset', () => {
  it('needs the word RESET', async () => {
    await plant();
    expect((await ui('/api/data/reset', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await ui('/api/data/reset', { method: 'POST', body: JSON.stringify({ confirm: 'reset' }) })).status).toBe(400);
    expect(await agent.work.scanStore.listBundles()).toHaveLength(1);
  });

  it('clears scan data, keeps keys, settings and pairing, and writes a backup without keys', async () => {
    await plant();
    agent.store.update('settings', (s) => ({ ...s, settings: { ...s.settings, searchesPerScan: 7 } }));
    agent.store.update('deals', (d) => ({ ...d, at: 'now' }));
    const res = await ui('/api/data/reset', { method: 'POST', body: JSON.stringify({ confirm: 'RESET' }) });
    expect(res.status).toBe(200);
    const { backup } = (await res.json()) as { reset: boolean; backup: string };
    expect(backup.startsWith(dir)).toBe(true);
    expect(existsSync(join(backup, 'scan', 'bundles.json'))).toBe(true);
    expect(readdirSync(join(backup, 'store')).sort()).not.toContain('keys.json');
    expect(readFileSync(join(backup, 'scan', 'bundles.json'), 'utf8')).toContain('RYOBI kit');

    expect(await agent.work.scanStore.listBundles()).toEqual([]);
    expect(agent.store.get('deals').at).toBeNull();
    expect(agent.store.get('activity').errors ?? []).toEqual([]);
    expect(agent.store.get('keys').serpapi).toBe(SERP);
    expect(agent.store.get('settings').settings.searchesPerScan).toBe(7);
  });

  it('refuses while something is writing, and deletes nothing', async () => {
    await plant();
    agent.work.writing = () => true;
    const res = await ui('/api/data/reset', { method: 'POST', body: JSON.stringify({ confirm: 'RESET' }) });
    expect(res.status).toBe(409);
    expect(await agent.work.scanStore.listBundles()).toHaveLength(1);
    expect(readdirSync(dir).filter((n) => n.startsWith('backup-'))).toEqual([]);
  });
});
