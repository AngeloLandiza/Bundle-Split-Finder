import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Store } from '../store';

const open: Store[] = [];
function openStore(dir: string): Store {
  const s = Store.open(dir);
  open.push(s);
  return s;
}
afterEach(() => {
  while (open.length) open.pop()!.close();
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sf-store-'));
}

describe('agent store', () => {
  it('starts with defaults and keeps an update across a reopen', () => {
    const dir = tempDir();
    const s = openStore(dir);
    expect(s.get('settings').autopilot).toBe(true);
    expect(s.get('jobs')).toEqual([]);
    s.update('settings', (cur) => ({ ...cur, askAfterScan: true }));
    s.close();
    const again = openStore(dir);
    expect(again.get('settings').askAfterScan).toBe(true);
  });

  it('hands out copies: changing what get returns changes nothing stored', () => {
    const s = openStore(tempDir());
    s.get('settings').settings.brands.push('MILWAUKEE');
    expect(s.get('settings').settings.brands).not.toContain('MILWAUKEE');
  });

  it('writes by rename and leaves no temp files; keys and pairing are owner-only', () => {
    const dir = tempDir();
    const s = openStore(dir);
    s.update('keys', () => ({ serpapi: 'k-test' }));
    const files = readdirSync(join(dir, 'store'));
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'store', 'keys.json')).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'store', 'pairing.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('tells listeners which collection changed', () => {
    const s = openStore(tempDir());
    const seen: string[] = [];
    s.onChange((name) => seen.push(name));
    s.update('review', (cur) => ({ ...cur, at: 'x' }));
    expect(seen).toEqual(['review']);
  });

  it('refuses a second writer while the first holds the lock', () => {
    const dir = tempDir();
    openStore(dir);
    // A lock held by a live process that is not this one: the parent of this test runner.
    writeFileSync(join(dir, 'store', 'store.lock'), String(process.ppid));
    expect(() => Store.open(dir)).toThrow(/Another Split Finder agent/);
  });

  it('takes over a lock left by a process that is gone', () => {
    const dir = tempDir();
    const first = Store.open(dir);
    first.close();
    writeFileSync(join(dir, 'store', 'store.lock'), '999999');
    expect(() => openStore(dir)).not.toThrow();
  });

  it('migrates the pre-step-13 files once, and does not read them again', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'app-settings.json'),
      JSON.stringify({ version: 1, updatedAt: 'u', appPrimaryUi: false, askAfterScan: true, serpApiKey: 'legacy-serp', settings: { searchesPerScan: 7 } }),
    );
    writeFileSync(join(dir, 'app-secrets.json'), JSON.stringify({ keepaApiKey: 'legacy-keepa', ebayAppId: 'a', ebayCertId: 'c' }));
    writeFileSync(join(dir, 'deals-panel.json'), JSON.stringify({ at: 'p', bundles: [{ key: 'B' }] }));
    writeFileSync(
      join(dir, 'deals-snapshot.json'),
      JSON.stringify({
        at: 's',
        bundles: [{ key: 'B', brand: 'DEWALT', model: 'X', title: 'Kit', section: 'confirmed', itemId: 1 }],
        openQuestions: [{ id: 'split:B', kind: 'split', answer: null }],
        openEbayQuestions: [{ id: 'DEWALT:A|9' }],
        aiSuggestions: [{ key: 'k', questionId: 'split:B' }],
      }),
    );
    writeFileSync(join(dir, 'scan-pending.json'), JSON.stringify({ id: 'scan-1', requestedAt: 'r' }));
    writeFileSync(join(dir, 'review-queue.json'), JSON.stringify([{ id: 'split:B', answer: { none: true }, queuedAt: 'q' }]));
    writeFileSync(join(dir, 'hd-read-pending.json'), JSON.stringify({ id: 'hd-1', itemIds: [123], requestedAt: 'r' }));

    const s = openStore(dir);
    expect(s.get('settings').appPrimaryUi).toBe(false);
    expect(s.get('settings').settings.searchesPerScan).toBe(7);
    expect(s.get('keys')).toEqual({ serpapi: 'legacy-serp', keepa: 'legacy-keepa', ebay: { appId: 'a', certId: 'c' } });
    expect(JSON.stringify(s.get('settings'))).not.toContain('legacy-serp');
    expect(s.get('deals').bundles).toHaveLength(1);
    expect(s.get('deals').auditBundles[0]?.model).toBe('X');
    expect(s.get('review').questions[0]?.id).toBe('split:B');
    expect(s.get('review').ebayQuestions).toHaveLength(1);
    expect(s.get('suggestions')).toHaveLength(1);
    expect(s.get('outbox').scan?.id).toBe('scan-1');
    expect(s.get('outbox').reviewAnswers).toHaveLength(1);
    expect(s.get('jobs')[0]).toMatchObject({ id: 'hd-1', kind: 'page', status: 'queued', input: { itemIds: ['123'] } });
    const meta = JSON.parse(readFileSync(join(dir, 'store', 'meta.json'), 'utf8')) as { migratedFrom: string[] };
    expect(meta.migratedFrom).toContain('app-secrets.json');
    s.close();

    // A legacy file changed after the migration is not read again.
    writeFileSync(join(dir, 'scan-pending.json'), JSON.stringify({ id: 'scan-2', requestedAt: 'r' }));
    const again = openStore(dir);
    expect(again.get('outbox').scan?.id).toBe('scan-1');
    expect(existsSync(join(dir, 'app-secrets.json'))).toBe(true);
  });
});
