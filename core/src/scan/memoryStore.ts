// A ScanStore that lives in memory. Records are copied on the way in and on the way
// out, so neither the caller's object nor a returned one aliases what is stored.

import type {
  BundleRecord, CatalogCursor, CatalogRecord, ConfirmedPrice, EbayOwnerAnswer, EbayValueRecord, JudgementRecord, ListingRecord, MatchRecord, PartPriceRecord, PriceRecord, ReviewItem, ScanJob, ScanStore,
} from './types';
import type { PartFact } from '../facts/fact';

const byKey = <T>(key: (r: T) => string) => (a: T, b: T): number => {
  const x = key(a);
  const y = key(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

export class MemoryScanStore implements ScanStore {
  private readonly bundles = new Map<string, BundleRecord>();
  private readonly catalog = new Map<string, CatalogRecord>();
  private readonly matches = new Map<string, MatchRecord>();
  private readonly prices = new Map<string, PriceRecord>();
  private readonly listings = new Map<string, ListingRecord>();
  private readonly cursors = new Map<string, CatalogCursor>();
  private readonly reviews = new Map<string, ReviewItem>();
  private readonly partPrices = new Map<string, PartPriceRecord>();
  private readonly confirmedPrices = new Map<string, ConfirmedPrice>();
  private readonly ebayValues = new Map<string, EbayValueRecord>();
  private readonly judgements = new Map<string, JudgementRecord>();
  private readonly ebayAnswers = new Map<string, EbayOwnerAnswer>();
  private readonly scans = new Map<string, ScanJob>();
  private readonly partFacts = new Map<string, PartFact>();

  private get<T>(map: Map<string, T>, key: string): T | undefined {
    const found = map.get(key);
    return found === undefined ? undefined : structuredClone(found);
  }

  private list<T>(map: Map<string, T>, order: (a: T, b: T) => number): T[] {
    return [...map.values()].map((r) => structuredClone(r)).sort(order);
  }

  async getBundle(key: string) {
    return this.get(this.bundles, key);
  }
  async putBundle(record: BundleRecord) {
    this.bundles.set(record.key, structuredClone(record));
  }
  async listBundles() {
    return this.list(this.bundles, byKey((r) => r.key));
  }

  async getCatalogEntry(key: string) {
    return this.get(this.catalog, key);
  }
  async putCatalogEntry(record: CatalogRecord) {
    this.catalog.set(record.key, structuredClone(record));
  }
  async listCatalog() {
    return this.list(this.catalog, byKey((r) => r.key));
  }

  async getMatch(key: string) {
    return this.get(this.matches, key);
  }
  async putMatch(record: MatchRecord) {
    this.matches.set(record.key, structuredClone(record));
  }
  async listMatches() {
    return this.list(this.matches, byKey((r) => r.key));
  }

  async getPrice(asin: string) {
    return this.get(this.prices, asin);
  }
  async putPrice(record: PriceRecord) {
    this.prices.set(record.asin, structuredClone(record));
  }

  async getListing(asin: string) {
    return this.get(this.listings, asin);
  }
  async putListing(record: ListingRecord) {
    this.listings.set(record.asin, structuredClone(record));
  }
  async listListings() {
    return this.list(this.listings, byKey((r) => r.asin));
  }

  async getCursor(brand: string) {
    return this.get(this.cursors, brand);
  }
  async putCursor(cursor: CatalogCursor) {
    this.cursors.set(cursor.brand, structuredClone(cursor));
  }

  async getReview(id: string) {
    return this.get(this.reviews, id);
  }
  async putReview(item: ReviewItem) {
    this.reviews.set(item.id, structuredClone(item));
  }
  async listReview() {
    return this.list(this.reviews, byKey((r) => r.id));
  }

  async getPartPrice(key: string) {
    return this.get(this.partPrices, key);
  }
  async putPartPrice(record: PartPriceRecord) {
    this.partPrices.set(record.key, structuredClone(record));
  }
  async listPartPrices() {
    return this.list(this.partPrices, byKey((r) => r.key));
  }

  async getConfirmedPrice(key: string) {
    return this.get(this.confirmedPrices, key);
  }
  async putConfirmedPrice(record: ConfirmedPrice) {
    this.confirmedPrices.set(record.key, structuredClone(record));
  }
  async deleteConfirmedPrice(key: string) {
    this.confirmedPrices.delete(key);
  }
  async listConfirmedPrices() {
    return this.list(this.confirmedPrices, byKey((r) => r.key));
  }

  async getEbayValue(key: string) {
    return this.get(this.ebayValues, key);
  }
  async putEbayValue(record: EbayValueRecord) {
    this.ebayValues.set(record.key, structuredClone(record));
  }
  async listEbayValues() {
    return this.list(this.ebayValues, byKey((r) => r.key));
  }

  async putEbayAnswer(record: EbayOwnerAnswer) {
    this.ebayAnswers.set(record.key, structuredClone(record));
  }
  async listEbayAnswers() {
    return this.list(this.ebayAnswers, byKey((r) => r.key));
  }

  async getJudgement(key: string) {
    return this.get(this.judgements, key);
  }
  async putJudgement(record: JudgementRecord) {
    this.judgements.set(record.key, structuredClone(record));
  }

  async getScan(id: string) {
    return this.get(this.scans, id);
  }
  async putScan(job: ScanJob) {
    this.scans.set(job.id, structuredClone(job));
  }
  async listScans() {
    return this.list(this.scans, (a, b) => b.startedAt - a.startedAt);
  }

  async getPartFact(key: string) {
    return this.get(this.partFacts, key);
  }
  async putPartFact(record: PartFact) {
    this.partFacts.set(record.key, structuredClone(record));
  }
  async deletePartFact(key: string) {
    this.partFacts.delete(key);
  }
  async listPartFacts() {
    return this.list(this.partFacts, byKey((r) => r.key));
  }

  async clearAll() {
    this.partFacts.clear();
    this.bundles.clear();
    this.catalog.clear();
    this.matches.clear();
    this.prices.clear();
    this.listings.clear();
    this.cursors.clear();
    this.reviews.clear();
    this.partPrices.clear();
    this.confirmedPrices.clear();
    this.ebayValues.clear();
    this.judgements.clear();
    this.ebayAnswers.clear();
    this.scans.clear();
  }
}
