// Which shop a pasted link is from, and the item's id in it. Pure: no network. Used by "Confirm a price" so a
// pasted link can be read for its price (agent/priceFromLink.ts); a link from any other site is 'other' and the
// price stays the one he types (docs/decisions.md, "A price counts when he confirms it").

export type ListingSite = 'ebay' | 'amazon' | 'homedepot' | 'other';

export interface ListingLink {
  site: ListingSite;
  /** eBay: the legacy item id (9 to 14 digits). Amazon: the ASIN (10 characters). Home Depot: the 9-digit item id. Absent for 'other' and for a known shop's link that names no item. */
  id?: string;
}

const EBAY_ID = /^\d{9,14}$/;
const ASIN = /^[A-Z0-9]{10}$/i;
const HD_ID = /^\d{9}$/;

/** True for `host` or any subdomain of `domain` (ebay.com, www.ebay.com, m.ebay.com; not notebay.com). */
function under(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

const OTHER: ListingLink = { site: 'other' };

/**
 * eBay: /itm/<id>, /itm/<slug>/<id> and ?item=<id> (also ?iid=). Amazon: /dp/<asin>, /gp/product/<asin> and /gp/aw/d/<asin>
 * (the mobile path), with or without a title slug before /dp. Home Depot: /p/<slug>/<9 digits>. Tracking parameters and
 * fragments are ignored because only the path (and eBay's item parameter) is read. A link on a known shop's host with no
 * item in it is that shop with no id; every other host, and anything that is not an http(s) link, is 'other'.
 */
export function parseListingLink(input: string): ListingLink {
  if (typeof input !== 'string') return OTHER;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return OTHER;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') return OTHER;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter((s) => s !== '');

  if (under(host, 'ebay.com')) {
    const at = parts.indexOf('itm');
    const fromPath = at >= 0 ? [...parts.slice(at + 1)].reverse().find((s) => EBAY_ID.test(s)) : undefined;
    const fromQuery = [url.searchParams.get('item'), url.searchParams.get('iid')].find((v) => v !== null && EBAY_ID.test(v));
    const id = fromPath ?? fromQuery ?? undefined;
    return id ? { site: 'ebay', id } : { site: 'ebay' };
  }
  if (under(host, 'amazon.com')) {
    for (let i = 0; i < parts.length; i++) {
      const next = parts[i + 1];
      const dp = parts[i] === 'dp' && next !== undefined;
      const gp = parts[i] === 'product' && parts[i - 1] === 'gp' && next !== undefined;
      const mobile = parts[i] === 'd' && parts[i - 1] === 'aw' && parts[i - 2] === 'gp' && next !== undefined;
      if ((dp || gp || mobile) && ASIN.test(next!)) return { site: 'amazon', id: next!.toUpperCase() };
    }
    return { site: 'amazon' };
  }
  if (under(host, 'homedepot.com')) {
    const last = parts[parts.length - 1] ?? '';
    return parts[0] === 'p' && parts.length >= 2 && HD_ID.test(last) ? { site: 'homedepot', id: last } : { site: 'homedepot' };
  }
  return OTHER;
}
