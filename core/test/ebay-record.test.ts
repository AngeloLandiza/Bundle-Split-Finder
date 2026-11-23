import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EbayClient } from '../src/ebay/client';
import { runEbayRecord } from '../../scripts/ebay-record-cli';

const FIX = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const body = (f: string): unknown => (JSON.parse(readFileSync(join(FIX, 'ebay', f), 'utf8')) as { response: unknown }).response;
const SEARCH = body('browse-search-PCL206B-2026-11-19.json');
const ITEM = body('browse-item-237179711800-2026-11-19.json');

function tmpFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ebay-rec-'));
  mkdirSync(join(dir, 'validation'));
  copyFileSync(join(FIX, 'validation', 'hd-part-prices-2026-11-18.json'), join(dir, 'validation', 'hd-part-prices-2026-11-18.json'));
  return dir;
}

function fakeClient(): { make: () => EbayClient; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(String(url));
    if (url.includes('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }));
    return new Response(JSON.stringify(url.includes('/item_summary/search') ? SEARCH : ITEM));
  }) as unknown as typeof fetch;
  return { make: () => new EbayClient({ appId: 'a', certId: 'c', fetchFn, maxSearches: 60, maxItemReads: 400 }), urls };
}

describe('ebay:record', () => {
  it('--dry-run lists the 49 parts, makes no call and reads no key', async () => {
    const lines: string[] = [];
    const code = await runEbayRecord(['--dry-run'], {
      log: (l) => lines.push(l), dir: FIX, env: () => { throw new Error('read a variable'); },
      makeClient: () => { throw new Error('built a client'); },
    });
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('search "RYOBI PCL206"');
    expect(text).toContain('Planned: 49 searches');
    expect(text).toContain('at most 8 per part');
  });

  it('refuses without exactly one valid flag, and without keys', async () => {
    const log = (): void => {};
    expect(await runEbayRecord([], { log, dir: FIX, env: () => undefined })).toBe(2);
    expect(await runEbayRecord(['--run', '--dry-run'], { log, dir: FIX, env: () => undefined })).toBe(2);
    const lines: string[] = [];
    expect(await runEbayRecord(['--run'], { log: (l) => lines.push(l), dir: tmpFixtures(), env: () => undefined })).toBe(1);
    expect(lines.join('')).toContain('PRD_EBAY_APP_ID');
  });

  it('--run writes the recording with parsed summaries, kept, dropped and items, and prints counts only', async () => {
    const dir = tmpFixtures();
    const lines: string[] = [];
    const f = fakeClient();
    const code = await runEbayRecord(['--run'], {
      log: (l) => lines.push(l), dir, env: () => 'SECRETVALUE', makeClient: f.make, now: () => new Date('2026-11-19T12:00:00Z'),
    });
    expect(code).toBe(0);
    const rec = JSON.parse(readFileSync(join(dir, 'ebay', 'validation-2026-11-19.json'), 'utf8')) as {
      recordedAt: string; incomplete?: boolean; parts: Record<string, { query: string; total: number; summaries: unknown[]; kept: string[]; dropped: unknown[]; items: Record<string, { descriptionText: string }> }>;
    };
    expect(rec.recordedAt).toBe('2026-11-19T12:00:00.000Z');
    expect(rec.incomplete).toBeUndefined();
    expect(Object.keys(rec.parts)).toHaveLength(49);
    const p = rec.parts.PCL206!;
    expect(p.query).toBe('RYOBI PCL206');
    expect(p.total).toBe(47);
    expect(p.summaries).toHaveLength(10);
    expect(Object.keys(p.items).sort()).toEqual([...p.kept].sort());
    expect(p.kept.length + p.dropped.length).toBe(10);
    expect(f.urls.filter((u) => u.includes('/item/')).length).toBeLessThanOrEqual(49 * 8);
    expect(JSON.stringify(rec)).not.toMatch(/"seller"(?!ItemRevision)|feedback/i);
    expect(lines.join('\n')).not.toContain('SECRETVALUE');
    expect(lines.join('\n')).toMatch(/Made 49 searches and \d+ item reads/);
  });
});
