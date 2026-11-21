// ScanStore over IndexedDB. Behaves like MemoryScanStore: put replaces by key, reads
// return values the caller may change, lists are sorted by key (scans: newest first).
// IndexedDB stores structured clones, so copies come for free; put still clones first
// so a record that cannot be cloned fails here, not later.

import type { IDBPDatabase } from 'idb';
import type {
  BundleRecord, CatalogCursor, CatalogRecord, ConfirmedPrice, EbayOwnerAnswer, EbayValueRecord, JudgementRecord, ListingRecord, MatchRecord, PartPriceRecord, PriceRecord, ReviewItem, ScanJob, ScanStore,
} from '@core/scan/types';
import { KEYED_STORES, openDb, type KeyedStore } from './db';

export class IdbScanStore implements ScanStore {
  private readonly db: Promise<IDBPDatabase>;

  constructor(db?: IDBPDatabase | Promise<IDBPDatabase>) {
    this.db = Promise.resolve(db ?? openDb());
  }

  private async get<T>(store: KeyedStore, key: string): Promise<T | undefined> {
    return (await (await this.db).get(store, key)) as T | undefined;
  }

  private async put<T>(store: KeyedStore, record: T): Promise<void> {
    await (await this.db).put(store, structuredClone(record));
  }

  /** IndexedDB orders string keys by code unit, the same as the memory store's comparison. */
  private async list<T>(store: KeyedStore): Promise<T[]> {
    return (await (await this.db).getAll(store)) as T[];
  }

  getBundle(key: string) { return this.get<BundleRecord>('bundles', key); }
  putBundle(record: BundleRecord) { return this.put('bundles', record); }
  listBundles() { return this.list<BundleRecord>('bundles'); }

  getCatalogEntry(key: string) { return this.get<CatalogRecord>('catalog', key); }
  putCatalogEntry(record: CatalogRecord) { return this.put('catalog', record); }
  listCatalog() { return this.list<CatalogRecord>('catalog'); }

  getMatch(key: string) { return this.get<MatchRecord>('matches', key); }
  putMatch(record: MatchRecord) { return this.put('matches', record); }
  listMatches() { return this.list<MatchRecord>('matches'); }

  getPrice(asin: string) { return this.get<PriceRecord>('prices', asin); }
  putPrice(record: PriceRecord) { return this.put('prices', record); }

  getListing(asin: string) { return this.get<ListingRecord>('listings', asin); }
  putListing(record: ListingRecord) { return this.put('listings', record); }
  listListings() { return this.list<ListingRecord>('listings'); }

  getCursor(brand: string) { return this.get<CatalogCursor>('cursors', brand); }
  putCursor(cursor: CatalogCursor) { return this.put('cursors', cursor); }

  getReview(id: string) { return this.get<ReviewItem>('review', id); }
  putReview(item: ReviewItem) { return this.put('review', item); }
  listReview() { return this.list<ReviewItem>('review'); }

  getPartPrice(key: string) { return this.get<PartPriceRecord>('partPrices', key); }
  putPartPrice(record: PartPriceRecord) { return this.put('partPrices', record); }
  listPartPrices() { return this.list<PartPriceRecord>('partPrices'); }

  getConfirmedPrice(key: string) { return this.get<ConfirmedPrice>('confirmedPrices', key); }
  putConfirmedPrice(record: ConfirmedPrice) { return this.put('confirmedPrices', record); }
  async deleteConfirmedPrice(key: string) { await (await this.db).delete('confirmedPrices', key); }
  listConfirmedPrices() { return this.list<ConfirmedPrice>('confirmedPrices'); }

  getEbayValue(key: string) { return this.get<EbayValueRecord>('ebayValues', key); }
  putEbayValue(record: EbayValueRecord) { return this.put('ebayValues', record); }
  listEbayValues() { return this.list<EbayValueRecord>('ebayValues'); }

  putEbayAnswer(record: EbayOwnerAnswer) { return this.put('ebayAnswers', record); }
  listEbayAnswers() { return this.list<EbayOwnerAnswer>('ebayAnswers'); }

  getJudgement(key: string) { return this.get<JudgementRecord>('judgements', key); }
  putJudgement(record: JudgementRecord) { return this.put('judgements', record); }

  getScan(id: string) { return this.get<ScanJob>('scans', id); }
  putScan(job: ScanJob) { return this.put('scans', job); }
  async listScans() {
    return (await this.list<ScanJob>('scans')).sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Every scan record. The search ledger is a different store and is left as it is. */
  async clearAll() {
    const db = await this.db;
    const names = Object.keys(KEYED_STORES);
    const tx = db.transaction(names, 'readwrite');
    await Promise.all([...names.map((name) => tx.objectStore(name).clear()), tx.done]);
  }
}
