// The scan's records in the agent (step 13, W4): core's ScanStore over JSON files, one per record kind, under
// <dataDir>/scan/. Each kind is held in memory and written whole (temp file, then rename) on every put, so a crash
// leaves the old or the new file, and a scan that was "running" is continued by the next run (runner.ts startJob).
// The agent process is the only writer (the store lock in store.ts). Also the agent's response cache, one file per
// key under <dataDir>/cache/, the same layout as scripts/node-store.ts FileCache but in the app's data folder.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Cache, CacheEntry } from '../core/src/serpapi/client';
import type {
  BundleRecord, CatalogCursor, CatalogRecord, ConfirmedPrice, EbayOwnerAnswer, EbayValueRecord, JudgementRecord, ListingRecord, MatchRecord,
  PartPriceRecord, PriceRecord, ReviewItem, ScanJob, ScanStore,
} from '../core/src/scan/types';
import { writeFileAtomic } from './store';

/** Scans kept on file, newest first; older ones are dropped (the runner reads the newest two). */
const KEEP_SCANS = 50;

interface Kinds {
  bundles: BundleRecord;
  catalog: CatalogRecord;
  matches: MatchRecord;
  prices: PriceRecord;
  listings: ListingRecord;
  cursors: CatalogCursor;
  reviews: ReviewItem;
  partPrices: PartPriceRecord;
  confirmedPrices: ConfirmedPrice;
  ebayValues: EbayValueRecord;
  judgements: JudgementRecord;
  ebayAnswers: EbayOwnerAnswer;
  scans: ScanJob;
}
type Kind = keyof Kinds;
const KINDS: readonly Kind[] = [
  'bundles', 'catalog', 'matches', 'prices', 'listings', 'cursors', 'reviews', 'partPrices', 'confirmedPrices', 'ebayValues', 'judgements', 'ebayAnswers', 'scans',
];

const byKey = <T>(key: (r: T) => string) => (a: T, b: T): number => {
  const x = key(a);
  const y = key(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

export class FileScanStore implements ScanStore {
  private readonly maps = new Map<Kind, Map<string, unknown>>();

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const kind of KINDS) {
      const map = new Map<string, unknown>();
      const file = join(dir, `${kind}.json`);
      if (existsSync(file)) {
        try {
          const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
          if (Array.isArray(raw)) for (const pair of raw) if (Array.isArray(pair) && typeof pair[0] === 'string') map.set(pair[0], pair[1]);
        } catch {
          // An unreadable file reads as empty; the next scan fills it again.
        }
      }
      this.maps.set(kind, map);
    }
  }

  private map<K extends Kind>(kind: K): Map<string, Kinds[K]> {
    return this.maps.get(kind) as Map<string, Kinds[K]>;
  }

  private get<K extends Kind>(kind: K, key: string): Kinds[K] | undefined {
    const found = this.map(kind).get(key);
    return found === undefined ? undefined : structuredClone(found);
  }

  private put<K extends Kind>(kind: K, key: string, record: Kinds[K]): void {
    this.map(kind).set(key, structuredClone(record));
    this.flush(kind);
  }

  private list<K extends Kind>(kind: K, order: (a: Kinds[K], b: Kinds[K]) => number): Kinds[K][] {
    return [...this.map(kind).values()].map((r) => structuredClone(r)).sort(order);
  }

  private flush(kind: Kind): void {
    writeFileAtomic(join(this.dir, `${kind}.json`), JSON.stringify([...this.maps.get(kind)!.entries()]));
  }

  async getBundle(key: string) { return this.get('bundles', key); }
  async putBundle(r: BundleRecord) { this.put('bundles', r.key, r); }
  async listBundles() { return this.list('bundles', byKey((r) => r.key)); }

  async getCatalogEntry(key: string) { return this.get('catalog', key); }
  async putCatalogEntry(r: CatalogRecord) { this.put('catalog', r.key, r); }
  async listCatalog() { return this.list('catalog', byKey((r) => r.key)); }

  async getMatch(key: string) { return this.get('matches', key); }
  async putMatch(r: MatchRecord) { this.put('matches', r.key, r); }
  async listMatches() { return this.list('matches', byKey((r) => r.key)); }

  async getPrice(asin: string) { return this.get('prices', asin); }
  async putPrice(r: PriceRecord) { this.put('prices', r.asin, r); }

  async getListing(asin: string) { return this.get('listings', asin); }
  async putListing(r: ListingRecord) { this.put('listings', r.asin, r); }
  async listListings() { return this.list('listings', byKey((r) => r.asin)); }

  async getCursor(brand: string) { return this.get('cursors', brand); }
  async putCursor(c: CatalogCursor) { this.put('cursors', c.brand, c); }

  async getReview(id: string) { return this.get('reviews', id); }
  async putReview(r: ReviewItem) { this.put('reviews', r.id, r); }
  async listReview() { return this.list('reviews', byKey((r) => r.id)); }

  async getPartPrice(key: string) { return this.get('partPrices', key); }
  async putPartPrice(r: PartPriceRecord) { this.put('partPrices', r.key, r); }
  async listPartPrices() { return this.list('partPrices', byKey((r) => r.key)); }

  async getConfirmedPrice(key: string) { return this.get('confirmedPrices', key); }
  async putConfirmedPrice(r: ConfirmedPrice) { this.put('confirmedPrices', r.key, r); }
  async deleteConfirmedPrice(key: string) {
    this.map('confirmedPrices').delete(key);
    this.flush('confirmedPrices');
  }
  async listConfirmedPrices() { return this.list('confirmedPrices', byKey((r) => r.key)); }

  async getEbayValue(key: string) { return this.get('ebayValues', key); }
  async putEbayValue(r: EbayValueRecord) { this.put('ebayValues', r.key, r); }
  async listEbayValues() { return this.list('ebayValues', byKey((r) => r.key)); }

  async putEbayAnswer(r: EbayOwnerAnswer) { this.put('ebayAnswers', r.key, r); }
  async listEbayAnswers() { return this.list('ebayAnswers', byKey((r) => r.key)); }

  async getJudgement(key: string) { return this.get('judgements', key); }
  async putJudgement(r: JudgementRecord) { this.put('judgements', r.key, r); }

  async getScan(id: string) { return this.get('scans', id); }
  async putScan(job: ScanJob) {
    const scans = this.map('scans');
    scans.set(job.id, structuredClone(job));
    if (scans.size > KEEP_SCANS) {
      const old = [...scans.values()].sort((a, b) => b.startedAt - a.startedAt).slice(KEEP_SCANS);
      for (const j of old) scans.delete(j.id);
    }
    this.flush('scans');
  }
  async listScans() { return this.list('scans', (a, b) => b.startedAt - a.startedAt); }

  async clearAll() {
    for (const kind of KINDS) {
      this.maps.get(kind)!.clear();
      this.flush(kind);
    }
  }
}

/** Saved responses (SerpApi, Keepa, trends, alert baselines), one file per key. */
export class DirCache implements Cache {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    const kind = /^keepa:/.test(key) ? 'keepa' : (/engine=([a-z_]+)/.exec(key)?.[1] ?? 'other');
    return join(this.dir, kind, `${createHash('sha1').update(key).digest('hex')}.json`);
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    const file = this.path(key);
    if (!existsSync(file)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as CacheEntry & { key?: string };
      return raw.key === undefined || raw.key === key ? { at: raw.at, data: raw.data } : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    const file = this.path(key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify({ key, ...entry }));
  }
}
