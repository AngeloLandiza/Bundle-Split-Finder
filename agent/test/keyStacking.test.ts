// Nov 25, key stacking: the owner may save more than one SerpApi and Keepa key, each from its own account, and everything
// that counts, limits and explains adjusts to the total. The owner's real scan store (fixtures/e2e-2026-11-23: parts waiting
// for an Amazon lookup), his store's other collections and ledgers shaped like his (fixtures/costs/after-scan6-ledgers), a
// fake SerpApi with one account per key that counts down with every search it answers, and a recorded Amazon search
// (fixtures/recorded). No network, no real key.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentState, AddKeyResponse, KeyCheck } from '../../core/src/api/contract';
import * as fx from '../../core/test/fixtures';
import { createAgent, type Agent } from '../app';
import { keySecrets, scrubKeyText } from '../keyChecks';
import { addKeyEntry, FIRST_KEY_ID, keyEntries, nextLabel, normalizeKeyLists, removeKeyEntry, renameKeyEntry, replaceFirstKey, withEntries } from '../keyList';
import { Store, type StoredKeys } from '../store';
import { scrub, secretsOf } from '../work';

const T0 = Date.UTC(2026, 10, 25, 15);
const AMAZON = readFileSync('fixtures/recorded/amazon-search-PCL206.json', 'utf8');
const SERP1 = 'serp-one-0123456789abcdef0123456789abcdef';
const SERP2 = 'serp-two-fedcba9876543210fedcba9876543210';
const KEEPA1 = 'keepa-one-0123456789abcdefghijklmnopqrstuvwxyz';
const KEEPA2 = 'keepa-two-zyxwvutsrqponmlkjihgfedcba9876543210';

let agent: Agent | null = null;
let server: Server | null = null;
afterEach(async () => {
  await agent?.work.idle();
  agent?.close();
  agent = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

let ui: (path: string, init?: RequestInit) => Promise<Response>;

interface Account {
  left: number;
  /** 401 from account.json and search.json: SerpApi does not accept the key. */
  refused?: boolean;
  /** Only search.json answers 401 (the account check still works): the fall-over case. */
  searchRefused?: boolean;
}

interface World {
  dir: string;
  accounts: Record<string, Account>;
  /** Every search.json call, by the key it carried (answered or refused). */
  sent: string[];
}

function dataFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sf-stack-'));
  mkdirSync(join(dir, 'scan'), { recursive: true });
  for (const kind of ['bundles', 'catalog', 'matches', 'prices', 'listings', 'partPrices', 'reviews']) {
    copyFileSync(join('fixtures/e2e-2026-11-23/scan', `${kind}.json`), join(dir, 'scan', `${kind}.json`));
  }
  return dir;
}

async function open(dir: string, accounts: Record<string, Account>, o: { perScan?: number; reserve?: number } = {}): Promise<World> {
  const world: World = { dir, accounts, sent: [] };
  server = createServer();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let t = T0;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(typeof input === 'string' || input instanceof URL ? input : input.url));
    const key = url.searchParams.get('api_key') ?? '';
    const acct = world.accounts[key];
    if (url.pathname.endsWith('/account.json')) {
      if (!acct || acct.refused) return new Response(JSON.stringify({ error: 'Invalid API key.' }), { status: 401 });
      return new Response(JSON.stringify({ ...fx.SERPAPI_ACCOUNT_FREE, total_searches_left: acct.left, plan_searches_left: acct.left }), { status: 200 });
    }
    if (url.pathname.endsWith('/search.json')) {
      world.sent.push(key);
      if (!acct || acct.refused || acct.searchRefused) return new Response('{}', { status: 401 });
      if (url.searchParams.get('engine') !== 'amazon') return new Response(JSON.stringify({ error: 'not recorded here' }), { status: 404 });
      acct.left -= 1;
      return new Response(AMAZON, { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  agent = createAgent({ dataDir: dir, port, timers: false, fetchFn, now: () => (t += 1000), shippedHelperVersion: null });
  server.on('request', agent.handle);
  ui = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { Authorization: `Bearer ${agent!.auth.uiToken}`, 'Content-Type': 'application/json' } });
  agent.store.update('settings', (s) => ({
    ...s, settings: { ...s.settings, brands: ['RYOBI'], searchesPerScan: o.perScan ?? 18, reserve: o.reserve ?? 0, amazonRefreshViaKeepa: false }, ai: { ...s.ai, monthlyCapUsd: 0 },
  }));
  return world;
}

/** Two SerpApi keys saved through the app's own routes, as the owner would. */
async function twoKeys(): Promise<void> {
  expect((await ui('/api/keys/serpapi', { method: 'PUT', body: JSON.stringify({ key: SERP1 }) })).status).toBe(200);
  const r = await ui('/api/keys/serpapi/entries', { method: 'POST', body: JSON.stringify({ key: SERP2 }) });
  expect(r.status).toBe(200);
}

const stateOf = async () => (await (await ui('/api/state')).json()) as AgentState;
const ledger = (dir: string): { keyId?: string }[] =>
  existsSync(join(dir, 'serpapi-ledger.jsonl')) ? readFileSync(join(dir, 'serpapi-ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { keyId?: string }) : [];

describe('the stored list (agent/keyList.ts)', () => {
  it('a store from before key stacking reads as one key, Key 1, date not known; the plain field stays for an older build', () => {
    const old: StoredKeys = { serpapi: SERP1, keepa: KEEPA1, ebay: { appId: 'a', certId: 'c' } };
    expect(keyEntries(old, 'serpapi')).toEqual([{ id: FIRST_KEY_ID.serpapi, label: 'Key 1', addedAt: null, key: SERP1 }]);
    const { keys, changed } = normalizeKeyLists(old);
    expect(changed).toBe(true);
    expect(keys.serpapi).toBe(SERP1);
    expect(keys.keepa).toBe(KEEPA1);
    expect(keys.serpapiKeys).toHaveLength(1);
    expect(keys.ebay).toEqual({ appId: 'a', certId: 'c' });
    expect(normalizeKeyLists(keys).changed).toBe(false);
  });

  it('what an older build may have done since: replaced its one key, or removed it', () => {
    const r = addKeyEntry(normalizeKeyLists({ serpapi: SERP1 }).keys, 'serpapi', SERP2, '2026-11-25T10:00:00.000Z', undefined, 'serpapi-b');
    if (!r.ok) throw new Error('add');
    // Removed (an older build's Remove deletes the plain field): the first key goes, the second stays.
    const removed = { ...r.keys };
    delete removed.serpapi;
    expect(keyEntries(removed, 'serpapi').map((e) => e.key)).toEqual([SERP2]);
    // Replaced: the new value takes the first place, under the first key's label, with an id of its own.
    const replaced = { ...r.keys, serpapi: 'serp-new-from-old-build-0000000000000' };
    const read = keyEntries(replaced, 'serpapi');
    expect(read.map((e) => e.key)).toEqual(['serp-new-from-old-build-0000000000000', SERP2]);
    expect(read[0]).toMatchObject({ label: 'Key 1', addedAt: null });
    expect(read[0]!.id).not.toBe(FIRST_KEY_ID.serpapi);
  });

  it('adds, names, renames, replaces and removes; the plain field always follows the first key', () => {
    let keys: StoredKeys = {};
    const a = addKeyEntry(keys, 'keepa', KEEPA1, 'at1');
    if (!a.ok) throw new Error('a');
    keys = a.keys;
    expect(keys.keepa).toBe(KEEPA1);
    const b = addKeyEntry(keys, 'keepa', KEEPA2, 'at2', 'Partner');
    if (!b.ok) throw new Error('b');
    keys = b.keys;
    expect(keyEntries(keys, 'keepa').map((e) => e.label)).toEqual(['Key 1', 'Partner']);
    expect(addKeyEntry(keys, 'keepa', KEEPA2, 'at3')).toEqual({ ok: false, reason: 'duplicate' });
    expect(nextLabel(keyEntries(keys, 'keepa'))).toBe('Key 3');
    const renamed = renameKeyEntry(keys, 'keepa', a.id, '  Mine \n ');
    if (!renamed.ok) throw new Error('rename');
    expect(keyEntries(renamed.keys, 'keepa')[0]!.label).toBe('Mine');
    expect(renameKeyEntry(keys, 'keepa', a.id, '   ')).toEqual({ ok: false, reason: 'label' });
    const gone = removeKeyEntry(keys, 'keepa', a.id);
    if (!gone.ok) throw new Error('remove');
    expect(gone.keys.keepa).toBe(KEEPA2);
    expect(withEntries(gone.keys, 'keepa', []).keepa).toBeUndefined();
    const first = replaceFirstKey(keys, 'keepa', 'keepa-three-0000000000000000000000000000000', 'at4', 'keepa-c');
    expect(keyEntries(first.keys, 'keepa').map((e) => e.id)).toEqual(['keepa-c', b.id]);
  });
});

describe('a real old store opens with the new build', () => {
  it('migrates its one key per service to a list once, keeps the plain field, keeps the file owner-only, and reads the old ledgers', async () => {
    const dir = dataFolder();
    mkdirSync(join(dir, 'store'), { recursive: true });
    // The owner's real collections (after scan 6) and a keys.json in the shape every build before key stacking wrote.
    for (const name of ['activity', 'deals', 'review', 'tracking']) copyFileSync(join('fixtures/e2e-2026-11-23/after-scan6/store', `${name}.json`), join(dir, 'store', `${name}.json`));
    writeFileSync(join(dir, 'store', 'meta.json'), JSON.stringify({ version: 1, createdAt: '2026-11-22T20:00:00.000Z', migratedFrom: [] }));
    writeFileSync(join(dir, 'store', 'keys.json'), JSON.stringify({ serpapi: SERP1, keepa: KEEPA1, ebay: { appId: 'app', certId: 'cert' } }), { mode: 0o600 });
    for (const f of ['serpapi-ledger.jsonl', 'keepa-ledger.jsonl']) copyFileSync(join('fixtures/costs/after-scan6-ledgers', f), join(dir, f));

    const s = Store.open(dir);
    const onDisk = JSON.parse(readFileSync(join(dir, 'store', 'keys.json'), 'utf8')) as StoredKeys;
    expect(onDisk.serpapi).toBe(SERP1);
    expect(onDisk.serpapiKeys).toEqual([{ id: 'serpapi-1', label: 'Key 1', addedAt: null, key: SERP1 }]);
    expect(onDisk.keepaKeys).toEqual([{ id: 'keepa-1', label: 'Key 1', addedAt: null, key: KEEPA1 }]);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'store', 'keys.json')).mode & 0o777).toBe(0o600);
    // An older build opening this file again finds its key where it always was.
    expect((JSON.parse(readFileSync(join(dir, 'store', 'keys.json'), 'utf8')) as { serpapi?: string }).serpapi).toBe(SERP1);
    expect(s.get('activity').runs.length).toBeGreaterThan(0);
    s.close();

    // The agent over it: the old ledger rows (no key id) are Key 1's; the state names the key, never its value.
    const w = await open(dir, { [SERP1]: { left: 120 } });
    await agent!.work.lookUpAll(0);
    const st = await stateOf();
    expect(st.keyEntries?.serpapi).toEqual([expect.objectContaining({ id: 'serpapi-1', label: 'Key 1', addedAt: null, searchesLeft: 120, searchesPerMonth: 250 })]);
    expect(JSON.stringify(st)).not.toContain(SERP1);
    expect(JSON.stringify(st)).not.toContain(KEEPA1);
    expect(w.sent).toEqual([]);
  });
});

describe('Settings, Keys: another key', () => {
  it('adds a second key with its own check, renames and removes it; no answer ever holds a key', async () => {
    await open(dataFolder(), { [SERP1]: { left: 60 }, [SERP2]: { left: 143 } });
    await ui('/api/keys/serpapi', { method: 'PUT', body: JSON.stringify({ key: SERP1 }) });
    const added = (await (await ui('/api/keys/serpapi/entries', { method: 'POST', body: JSON.stringify({ key: SERP2 }) })).json()) as AddKeyResponse;
    expect(added).toMatchObject({ saved: true, check: { ok: true, detail: '143 of 250 searches left' } });
    let st = await stateOf();
    expect(st.keyEntries?.serpapi?.map((e) => [e.label, e.searchesLeft])).toEqual([['Key 1', 60], ['Key 2', 143]]);
    expect(st.budget.serpLeft).toBe(203);
    expect(st.keyChecks?.serpapi).toMatchObject({ ok: true, detail: '2 of 2 keys accepted' });

    const dup = await ui('/api/keys/serpapi/entries', { method: 'POST', body: JSON.stringify({ key: SERP2 }) });
    expect(dup.status).toBe(400);
    expect((await ui('/api/keys/ebay/entries', { method: 'POST', body: JSON.stringify({ key: 'x' }) })).status).toBe(404);

    expect((await ui(`/api/keys/serpapi/entries/${added.id}`, { method: 'PATCH', body: JSON.stringify({ label: 'Partner' }) })).status).toBe(200);
    const check = (await (await ui(`/api/keys/serpapi/entries/${added.id}/check`, { method: 'POST', body: '{}' })).json()) as { check: KeyCheck };
    expect(check.check).toEqual({ ok: true, detail: '143 of 250 searches left' });
    st = await stateOf();
    expect(st.keyEntries?.serpapi?.[1]).toMatchObject({ label: 'Partner', check: { ok: true } });
    expect(JSON.stringify(st)).not.toContain(SERP2);

    expect((await ui(`/api/keys/serpapi/entries/${added.id}`, { method: 'DELETE' })).status).toBe(200);
    st = await stateOf();
    expect(st.keyEntries?.serpapi?.map((e) => e.label)).toEqual(['Key 1']);
    expect(st.budget.serpLeft).toBe(60);
    expect(agent!.store.get('keys').serpapi).toBe(SERP1);
  });

  it('Remove on the service removes every key, as Remove did with one', async () => {
    await open(dataFolder(), { [SERP1]: { left: 60 }, [SERP2]: { left: 143 } });
    await twoKeys();
    await ui('/api/keys/serpapi', { method: 'DELETE' });
    const st = await stateOf();
    expect(st.keys.serpapi).toBe(false);
    expect(st.keyEntries).toBeUndefined();
    expect(agent!.store.get('keys').serpapiKeys).toBeUndefined();
  });
});

describe('searches over two keys', () => {
  it('each lookup goes to the key with the most searches left; the ledger names the key; the balance is the sum', async () => {
    const w = await open(dataFolder(), { [SERP1]: { left: 60 }, [SERP2]: { left: 63 } });
    await twoKeys();
    const k2 = keyEntries(agent!.store.get('keys'), 'serpapi')[1]!.id;
    expect(await agent!.work.lookUpAll(5)).toMatchObject({ started: true, viaSerpapi: 5 });
    await agent!.work.idle();
    // 60 and 63: key 2 three times (63, 62, 61 → 60), then the tie goes to key 1, then key 2.
    expect(w.sent).toEqual([SERP2, SERP2, SERP2, SERP1, SERP2]);
    const rows = ledger(w.dir);
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.keyId === k2)).toHaveLength(4);
    expect(readFileSync(join(w.dir, 'serpapi-ledger.jsonl'), 'utf8')).not.toContain('serp-');
    expect(agent!.work.serpLeft()).toBe(118);
  });

  it('the reserve is on the total: 40 and 50 left under a reserve of 100 spend nothing on a scan', async () => {
    const w = await open(dataFolder(), { [SERP1]: { left: 40 }, [SERP2]: { left: 50 } }, { reserve: 100 });
    await twoKeys();
    agent!.work.scanNow();
    await agent!.work.idle();
    expect(w.sent).toEqual([]);
    expect(agent!.store.get('activity').runs.at(-1)!.summary).toContain('Searches are at your reserve (90 searches left, you keep 100)');
  });

  it('the per-scan cap is on the total: two keys, a cap of 3, three searches', async () => {
    const w = await open(dataFolder(), { [SERP1]: { left: 100 }, [SERP2]: { left: 100 } }, { perScan: 3 });
    await twoKeys();
    await agent!.work.lookUpAll(40, true);
    await agent!.work.idle();
    expect(w.sent).toHaveLength(3);
  });

  it('a refused key does not stop the scan: the other key pays, and the notice names the key by its label', async () => {
    const w = await open(dataFolder(), { [SERP1]: { left: 100 }, [SERP2]: { left: 200 } });
    await twoKeys();
    w.accounts[SERP2]!.refused = true;
    expect(await agent!.work.lookUpAll(2)).toMatchObject({ started: true, viaSerpapi: 2 });
    await agent!.work.idle();
    expect(w.sent).toEqual([SERP1, SERP1]);
    const st = await stateOf();
    expect(st.keyProblems?.serpapi).toBeUndefined();
    expect(st.keyEntryProblems).toEqual([expect.objectContaining({ service: 'serpapi', label: 'Key 2', problem: expect.stringMatching(/^SerpApi Key 2 is not accepted\./) })]);
    expect(st.keyEntries?.serpapi?.[1]?.check).toMatchObject({ ok: false });
    expect(st.budget.serpLeft).toBe(98);
  });

  it('every key refused is what one refused key was: nothing starts, and the service says so', async () => {
    const w = await open(dataFolder(), { [SERP1]: { left: 100, refused: true }, [SERP2]: { left: 200, refused: true } });
    await twoKeys();
    const r = await agent!.work.lookUpAll(2);
    expect(r).toMatchObject({ started: false, reason: 'SerpApi did not accept this key.' });
    expect(w.sent).toEqual([]);
    const st = await stateOf();
    expect(st.keyProblems?.serpapi).toMatch(/^Every SerpApi key was refused\. Key 1: /);
    expect(st.keyEntryProblems).toBeUndefined();
  });

  it('a key whose search is refused falls over once to the next key: one charge, one ledger row', async () => {
    const w = await open(dataFolder(), { [SERP1]: { left: 100 }, [SERP2]: { left: 200, searchRefused: true } });
    await twoKeys();
    const k1 = keyEntries(agent!.store.get('keys'), 'serpapi')[0]!.id;
    await agent!.work.lookUpAll(1);
    await agent!.work.idle();
    expect(w.sent).toEqual([SERP2, SERP1]);
    expect(ledger(w.dir)).toEqual([expect.objectContaining({ keyId: k1 })]);
    expect(w.accounts[SERP1]!.left + w.accounts[SERP2]!.left).toBe(299);
    // The next lookup of the same run goes straight to key 1: key 2 is marked for the run, never tried twice.
    w.sent.length = 0;
    await agent!.work.lookUpAll(2);
    await agent!.work.idle();
    expect(w.sent.filter((k) => k === SERP2)).toHaveLength(1);
  });
});

describe('every key is scrubbed', () => {
  it('from sentences, errors and the crash line: the second key as much as the first', () => {
    const keys = normalizeKeyLists({ serpapi: SERP1, keepa: KEEPA1 }).keys;
    const a = addKeyEntry(keys, 'serpapi', SERP2, 'at');
    const b = a.ok ? addKeyEntry(a.keys, 'keepa', KEEPA2, 'at') : a;
    if (!b.ok) throw new Error('add');
    const said = `failed with ${SERP2} and ${encodeURIComponent(KEEPA2)} and ${SERP1}`;
    expect(scrubKeyText(said, b.keys)).toBe('failed with [key] and [key] and [key]');
    expect(scrub(`x ${SERP2} y ${KEEPA2}`, b.keys)).toBe('x [key] y [key]');
    expect(secretsOf(b.keys)).toEqual(expect.arrayContaining([SERP1, SERP2, KEEPA1, KEEPA2]));
    expect(keySecrets(b.keys)).toEqual(expect.arrayContaining([SERP2, KEEPA2]));
  });
});
