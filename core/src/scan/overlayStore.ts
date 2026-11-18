// A copy-on-write layer over a ScanStore: reads fall through to the store underneath, writes stay
// in this layer's memory and are dropped with it. The store underneath is never written. A product
// page's view is computed over one while a scan or a panel action runs (pageView.ts, write: false).

import type { BundleRecord, CatalogCursor, CatalogRecord, ListingRecord, MatchRecord, PriceRecord, ReviewItem, ScanJob, ScanStore } from './types';

const byKey = <T>(key: (r: T) => string) => (a: T, b: T): number => {
  const x = key(a);
  const y = key(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** One collection: the records written here, by key, over the base's. */
class Layer<T> {
  private readonly written = new Map<string, T>();

  constructor(
    private readonly keyOf: (r: T) => string,
    private readonly order: (a: T, b: T) => number,
  ) {}

  async get(key: string, base: (key: string) => Promise<T | undefined>): Promise<T | undefined> {
    const own = this.written.get(key);
    return own !== undefined ? structuredClone(own) : base(key);
  }

  put(record: T): void {
    this.written.set(this.keyOf(record), structuredClone(record));
  }

  /** The base's list with this layer's records in place of the base's of the same key, in the store's order. */
  async list(base: () => Promise<T[]>): Promise<T[]> {
    const under = (await base()).filter((r) => !this.written.has(this.keyOf(r)));
    return [...under, ...[...this.written.values()].map((r) => structuredClone(r))].sort(this.order);
  }
}

export class OverlayStore implements ScanStore {
  private readonly bundles = new Layer<BundleRecord>((r) => r.key, byKey((r) => r.key));
  private readonly catalog = new Layer<CatalogRecord>((r) => r.key, byKey((r) => r.key));
  private readonly matches = new Layer<MatchRecord>((r) => r.key, byKey((r) => r.key));
  private readonly prices = new Layer<PriceRecord>((r) => r.asin, byKey((r) => r.asin));
  private readonly listings = new Layer<ListingRecord>((r) => r.asin, byKey((r) => r.asin));
  private readonly cursors = new Layer<CatalogCursor>((r) => r.brand, byKey((r) => r.brand));
  private readonly reviews = new Layer<ReviewItem>((r) => r.id, byKey((r) => r.id));
  private readonly scans = new Layer<ScanJob>((r) => r.id, (a, b) => b.startedAt - a.startedAt);

  constructor(private readonly base: ScanStore) {}

  getBundle(key: string) {
    return this.bundles.get(key, (k) => this.base.getBundle(k));
  }
  async putBundle(record: BundleRecord) {
    this.bundles.put(record);
  }
  listBundles() {
    return this.bundles.list(() => this.base.listBundles());
  }

  getCatalogEntry(key: string) {
    return this.catalog.get(key, (k) => this.base.getCatalogEntry(k));
  }
  async putCatalogEntry(record: CatalogRecord) {
    this.catalog.put(record);
  }
  listCatalog() {
    return this.catalog.list(() => this.base.listCatalog());
  }

  getMatch(key: string) {
    return this.matches.get(key, (k) => this.base.getMatch(k));
  }
  async putMatch(record: MatchRecord) {
    this.matches.put(record);
  }
  listMatches() {
    return this.matches.list(() => this.base.listMatches());
  }

  getPrice(asin: string) {
    return this.prices.get(asin, (k) => this.base.getPrice(k));
  }
  async putPrice(record: PriceRecord) {
    this.prices.put(record);
  }

  getListing(asin: string) {
    return this.listings.get(asin, (k) => this.base.getListing(k));
  }
  async putListing(record: ListingRecord) {
    this.listings.put(record);
  }
  listListings() {
    return this.listings.list(() => this.base.listListings());
  }

  getCursor(brand: string) {
    return this.cursors.get(brand, (k) => this.base.getCursor(k));
  }
  async putCursor(cursor: CatalogCursor) {
    this.cursors.put(cursor);
  }

  getReview(id: string) {
    return this.reviews.get(id, (k) => this.base.getReview(k));
  }
  async putReview(item: ReviewItem) {
    this.reviews.put(item);
  }
  listReview() {
    return this.reviews.list(() => this.base.listReview());
  }

  getScan(id: string) {
    return this.scans.get(id, (k) => this.base.getScan(k));
  }
  async putScan(job: ScanJob) {
    this.scans.put(job);
  }
  listScans() {
    return this.scans.list(() => this.base.listScans());
  }
}
