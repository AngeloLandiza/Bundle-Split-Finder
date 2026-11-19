import type { EbayListing, EbayListingSummary } from './types';

// Field names are those of the recorded responses (fixtures/ebay/). Every field is copied by name; the
// response is never spread, so a seller, buyer or feedback field cannot come through.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

export const DESCRIPTION_MAX = 4000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML to plain text: scripts and styles dropped, tags to spaces, entities decoded, whitespace collapsed, at most 4000 characters. */
export function stripHtml(html: string): string {
  const plain = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, DESCRIPTION_MAX).trim();
}

function priceOf(o: Json): { price: number | null; currency: string } {
  const p = isObj(o.price) ? o.price : {};
  const n = typeof p.value === 'string' || typeof p.value === 'number' ? Number(p.value) : NaN;
  return { price: Number.isFinite(n) ? n : null, currency: text(p.currency) ?? '' };
}

/** "v1|237179711800|0" is item 237179711800; the page carries no eBay tracking parameters. */
function pageUrl(o: Json, itemId: string): string {
  const legacy = text(o.legacyItemId) ?? itemId.split('|')[1];
  return legacy ? `https://www.ebay.com/itm/${encodeURIComponent(legacy)}` : '';
}

function categoryIdsOf(o: Json): string[] {
  const ids: string[] = [];
  if (typeof o.categoryIdPath === 'string') ids.push(...o.categoryIdPath.split('|'));
  if (Array.isArray(o.categories)) for (const c of o.categories) if (isObj(c) && text(c.categoryId)) ids.push(text(c.categoryId)!);
  if (Array.isArray(o.leafCategoryIds)) for (const c of o.leafCategoryIds) if (text(c)) ids.push(text(c)!);
  if (text(o.categoryId)) ids.push(text(o.categoryId)!);
  return [...new Set(ids.map((s) => s.trim()).filter((s) => s !== ''))];
}

function summaryOf(o: Json): EbayListingSummary {
  const itemId = text(o.itemId);
  const title = text(o.title);
  if (!itemId || !title) throw new Error('eBay listing without itemId or title');
  const { price, currency } = priceOf(o);
  const s: EbayListingSummary = {
    itemId, title, price, currency, conditionId: text(o.conditionId) ?? null, categoryIds: categoryIdsOf(o), url: pageUrl(o, itemId),
  };
  if (text(o.epid)) s.epid = text(o.epid);
  if (text(o.brand)) s.brand = text(o.brand);
  if (text(o.mpn)) s.mpn = text(o.mpn);
  return s;
}

/** A Browse search response (the recorded file, or its `response`) to its listings, in search order. */
export function parseSearch(json: unknown): EbayListingSummary[] {
  const root = isObj(json) && isObj(json.response) ? json.response : json;
  if (!isObj(root) || !Array.isArray(root.itemSummaries)) return [];
  return root.itemSummaries.filter(isObj).map(summaryOf);
}

/** A Browse getItem response (the recorded file, or its `response`) to a listing. Throws without an itemId or title. */
export function parseItem(json: unknown): EbayListing {
  const o = isObj(json) && isObj(json.response) ? json.response : json;
  if (!isObj(o)) throw new Error('eBay item response is not an object');
  const base = summaryOf(o);
  const aspects: { name: string; value: string }[] = [];
  if (Array.isArray(o.localizedAspects)) {
    for (const a of o.localizedAspects) {
      if (isObj(a) && text(a.name) && text(a.value)) aspects.push({ name: text(a.name)!, value: text(a.value)! });
    }
  }
  const avail = Array.isArray(o.estimatedAvailabilities) && isObj(o.estimatedAvailabilities[0]) ? o.estimatedAvailabilities[0] : {};
  const sold = avail.estimatedSoldQuantity;
  const item: EbayListing = {
    ...base,
    aspects,
    descriptionText: stripHtml(text(o.description) ?? text(o.shortDescription) ?? ''),
    soldQuantity: typeof sold === 'number' && Number.isFinite(sold) && sold >= 0 ? sold : null,
  };
  if (text(o.sellerItemRevision)) item.revision = text(o.sellerItemRevision);
  return item;
}
