// The scan's records in the agent (step 13, W4): core's ScanStore over JSON files, one per record kind, under
// <dataDir>/scan/. Each kind is held in memory and written whole (temp file, then rename) on every put, so a crash
// leaves the old or the new file, and a scan that was "running" is continued by the next run (runner.ts startJob).
// A put that would write the very bytes already on disk is not written again (see `unchanged`).
// The agent process is the only writer (the store lock in store.ts). Also the agent's response cache, one file per
// key under <dataDir>/cache/, the same layout as scripts/node-store.ts FileCache but in the app's data folder.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Cache, CacheEntry } from '../core/src/serpapi/client';
import type {
  BundleRecord, CatalogCursor, CatalogRecord, ConfirmedPrice, EbayOwnerAnswer, EbayValueRecord, JudgementRecord, ListingRecord, MatchRecord,
  PartPriceRecord, PriceRecord, RecheckRecord, ReviewItem, ScanJob, ScanStore,
} from '../core/src/scan/types';
import type { PartFact } from '../core/src/facts/fact';
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
  partFacts: PartFact;
  rechecks: RecheckRecord;
}
type Kind = keyof Kinds;
const KINDS: readonly Kind[] = [
  'bundles', 'catalog', 'matches', 'prices', 'listings', 'cursors', 'reviews', 'partPrices', 'confirmedPrices', 'ebayValues', 'judgements', 'ebayAnswers', 'scans',
  'partFacts', 'rechecks',
];

const byKey = <T>(key: (r: T) => string) => (a: T, b: T): number => {
  const x = key(a);
  const y = key(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

export class FileScanStore implements ScanStore {
  private readonly maps = new Map<Kind, Map<string, unknown>>();
  /**
   * Per kind, the file as this store last wrote it (inode, size, change times), set only after the write returned, so
   * the file then held exactly the kind's map, flushed to disk. Absent when it may not: before this store's first write
   * of the kind, and from the start of a write until it returns.
   */
  private readonly written = new Map<Kind, string>();

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
    const map = this.map(kind);
    const had = map.has(key);
    const prev = map.get(key);
    const next = structuredClone(record);
    map.set(key, next);
    if (had && this.unchanged(kind, prev, next)) return;
    this.flush(kind);
  }

  /**
   * True when writing the kind now would write the bytes its file already holds: the file is still the one this store
   * last wrote (the map's text then), and the one record that changed since serializes as it did. Setting a key that
   * exists keeps its place in the map, so the whole file's text is the same. The map still takes the new copy, so reads
   * are exactly what was put (a field set to undefined, which JSON leaves out, included). A file deleted, replaced or
   * changed behind the store fails the check, and so does a record JSON cannot write (the write then fails as it did).
   */
  private unchanged(kind: Kind, prev: unknown, next: unknown): boolean {
    if (!this.onDisk(kind)) return false;
    try {
      return JSON.stringify(prev) === JSON.stringify(next);
    } catch {
      return false;
    }
  }

  private file(kind: Kind): string {
    return join(this.dir, `${kind}.json`);
  }

  private stamp(kind: Kind): string | undefined {
    try {
      const s = statSync(this.file(kind), { bigint: true });
      return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    } catch {
      return undefined;
    }
  }

  /** The kind's file is the one this store last wrote, so it holds the map's text (as of that write). */
  private onDisk(kind: Kind): boolean {
    const was = this.written.get(kind);
    return was !== undefined && was === this.stamp(kind);
  }

  private list<K extends Kind>(kind: K, order: (a: Kinds[K], b: Kinds[K]) => number): Kinds[K][] {
    return [...this.map(kind).values()].map((r) => structuredClone(r)).sort(order);
  }

  private flush(kind: Kind): void {
    this.written.delete(kind);
    writeFileAtomic(this.file(kind), JSON.stringify([...this.maps.get(kind)!.entries()]));
    const stamp = this.stamp(kind);
    if (stamp !== undefined) this.written.set(kind, stamp);
  }

  private delete(kind: Kind, key: string): void {
    const map = this.map(kind);
    // Nothing to take out of a file that holds the map: the same bytes again.
    if (!map.has(key) && this.onDisk(kind)) return;
    map.delete(key);
    this.flush(kind);
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
  async deleteConfirmedPrice(key: string) { this.delete('confirmedPrices', key); }
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
    const had = scans.has(job.id);
    const prev = scans.get(job.id);
    const next = structuredClone(job);
    scans.set(job.id, next);
    let dropped = false;
    if (scans.size > KEEP_SCANS) {
      const old = [...scans.values()].sort((a, b) => b.startedAt - a.startedAt).slice(KEEP_SCANS);
      for (const j of old) scans.delete(j.id);
      dropped = old.length > 0;
    }
    if (had && !dropped && this.unchanged('scans', prev, next)) return;
    this.flush('scans');
  }
  async listScans() { return this.list('scans', (a, b) => b.startedAt - a.startedAt); }

  // Answer once (Nov 23): what the owner settled about a model, by partKey (core/src/facts/fact.ts).
  async getPartFact(key: string) { return this.get('partFacts', key); }
  async putPartFact(r: PartFact) { this.put('partFacts', r.key, r); }
  async deletePartFact(key: string) { this.delete('partFacts', key); }
  async listPartFacts() { return this.list('partFacts', byKey((r) => r.key)); }

  // The re-check of a part whose listing was withdrawn (core/src/scan/recheck.ts), by partKey.
  async getRecheck(key: string) { return this.get('rechecks', key); }
  async putRecheck(r: RecheckRecord) { this.put('rechecks', r.key, r); }
  async listRechecks() { return this.list('rechecks', byKey((r) => r.key)); }

  async clearAll() {
    for (const kind of KINDS) {
      const map = this.maps.get(kind)!;
      // Already empty on disk ("[]"): the same bytes again.
      if (map.size === 0 && this.onDisk(kind)) continue;
      map.clear();
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
