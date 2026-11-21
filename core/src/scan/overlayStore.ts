// A copy-on-write layer over a ScanStore: reads fall through to the store underneath, writes stay
// in this layer's memory and are dropped with it. The store underneath is never written. A product
// page's view is computed over one while a scan or a panel action runs (pageView.ts, write: false).

import type {
  BundleRecord, CatalogCursor, CatalogRecord, ConfirmedPrice, EbayOwnerAnswer, EbayValueRecord, JudgementRecord, ListingRecord, MatchRecord, PartPriceRecord, PriceRecord, ReviewItem, ScanJob, ScanStore,
} from './types';

const byKey = <T>(key: (r: T) => string) => (a: T, b: T): number => {
  const x = key(a);
  const y = key(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** One collection: the records written here, by key, over the base's. */
class Layer<T> {
  private readonly written = new Map<string, T>();
  /** Keys removed here, so a later read does not fall through to the store underneath. */
  private readonly removed = new Set<string>();

  constructor(
    private readonly keyOf: (r: T) => string,
    private readonly order: (a: T, b: T) => number,
  ) {}

  // Every record returned is a copy, the store's too, as MemoryScanStore returns them: a caller that
  // changes one changes nothing stored, whatever the store underneath does.
  async get(key: string, base: (key: string) => Promise<T | undefined>): Promise<T | undefined> {
    if (this.removed.has(key)) return undefined;
    const found = this.written.get(key) ?? (await base(key));
    return found === undefined ? undefined : structuredClone(found);
  }

  put(record: T): void {
    const key = this.keyOf(record);
    this.removed.delete(key);
    this.written.set(key, structuredClone(record));
  }

  remove(key: string): void {
    this.written.delete(key);
    this.removed.add(key);
  }

  clear(): void {
    this.written.clear();
    this.removed.clear();
  }

  /** The base's list with this layer's records in place of the base's of the same key, in the store's order. */
  async list(base: () => Promise<T[]>): Promise<T[]> {
    const under = (await base()).filter((r) => !this.written.has(this.keyOf(r)) && !this.removed.has(this.keyOf(r)));
    return [...under, ...this.written.values()].map((r) => structuredClone(r)).sort(this.order);
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
  private readonly partPrices = new Layer<PartPriceRecord>((r) => r.key, byKey((r) => r.key));
  private readonly confirmedPrices = new Layer<ConfirmedPrice>((r) => r.key, byKey((r) => r.key));
  private readonly ebayValues = new Layer<EbayValueRecord>((r) => r.key, byKey((r) => r.key));
  private readonly judgements = new Layer<JudgementRecord>((r) => r.key, byKey((r) => r.key));
  private readonly ebayAnswers = new Layer<EbayOwnerAnswer>((r) => r.key, byKey((r) => r.key));
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

  getPartPrice(key: string) {
    return this.partPrices.get(key, (k) => this.base.getPartPrice(k));
  }
  async putPartPrice(record: PartPriceRecord) {
    this.partPrices.put(record);
  }
  listPartPrices() {
    return this.partPrices.list(() => this.base.listPartPrices());
  }

  getConfirmedPrice(key: string) {
    return this.confirmedPrices.get(key, (k) => this.base.getConfirmedPrice(k));
  }
  async putConfirmedPrice(record: ConfirmedPrice) {
    this.confirmedPrices.put(record);
  }
  async deleteConfirmedPrice(key: string) {
    this.confirmedPrices.remove(key);
  }
  listConfirmedPrices() {
    return this.confirmedPrices.list(() => this.base.listConfirmedPrices());
  }

  getEbayValue(key: string) {
    return this.ebayValues.get(key, (k) => this.base.getEbayValue(k));
  }
  async putEbayValue(record: EbayValueRecord) {
    this.ebayValues.put(record);
  }
  listEbayValues() {
    return this.ebayValues.list(() => this.base.listEbayValues());
  }

  async putEbayAnswer(record: EbayOwnerAnswer) {
    this.ebayAnswers.put(record);
  }
  listEbayAnswers() {
    return this.ebayAnswers.list(() => this.base.listEbayAnswers());
  }

  getJudgement(key: string) {
    return this.judgements.get(key, (k) => this.base.getJudgement(k));
  }
  async putJudgement(record: JudgementRecord) {
    this.judgements.put(record);
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

  async clearAll() {
    await this.base.clearAll();
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
