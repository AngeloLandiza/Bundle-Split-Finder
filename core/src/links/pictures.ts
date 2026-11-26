// Product pictures (docs/design.md, Desktop app > Product pictures). A stored picture address is untrusted data: it is
// shown only when it is https on one of the image hosts the stored records actually hold, which the app's content
// security policy names one by one (src-tauri/tauri.conf.json and agent/uiStatic.ts UI_CSP). Nothing here fetches or
// guesses a picture; a part with none has none.
//
// Two sources, each with its own host (Nov 25, docs/decisions.md "Pictures from what the app already reads"):
// - Amazon's listing photo, `m.media-amazon.com`: a SerpApi search row's `thumbnail`, or a Keepa product's `images`
//   (keepa/parse.ts keepaPicture).
// - Home Depot's product photo, `images.thdstatic.com`: a Home Depot list entry's or product page's `media.images`
//   (hdPage.ts hdPicture), or a SerpApi Home Depot row's `thumbnails`.

export const AMAZON_PICTURE_HOST = 'm.media-amazon.com';
export const HOME_DEPOT_PICTURE_HOST = 'images.thdstatic.com';

// PICTURE_HOSTS begin (the CSP's img-src names exactly these; agent/test/pictureCsp.test.ts checks both)
export const PICTURE_HOSTS: readonly string[] = [AMAZON_PICTURE_HOST, HOME_DEPOT_PICTURE_HOST];
// PICTURE_HOSTS end

/** The longest address kept or shown. The recorded ones are 60 (Amazon) to 140 (Home Depot) characters. */
export const PICTURE_URL_MAX = 300;

/** The address on one of `hosts`, normalised, or null: https only, no user, password or port, no space or control character. */
function onHosts(url: unknown, hosts: readonly string[]): string | null {
  if (typeof url !== 'string' || url === '' || url.length > PICTURE_URL_MAX) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\<>"']/.test(url)) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return null;
    if (!hosts.includes(u.hostname.toLowerCase())) return null;
    return u.href.length <= PICTURE_URL_MAX ? u.href : null;
  } catch {
    return null;
  }
}

/** The address to load, or null when there is no picture to show. */
export function pictureUrl(url: string | null | undefined): string | null {
  return onHosts(url, PICTURE_HOSTS);
}

/** An Amazon listing picture as a record may keep it (Amazon's image host only), or null. */
export const amazonPicture = (url: unknown): string | null => onHosts(url, [AMAZON_PICTURE_HOST]);

/** A Home Depot product picture as a record may keep it (Home Depot's image host only), or null. */
export const homeDepotPicture = (url: unknown): string | null => onHosts(url, [HOME_DEPOT_PICTURE_HOST]);

/** What a part shows: its Amazon listing's stored picture, else its own Home Depot page's (`hdImage`). */
export interface PicturedPart {
  image: string | null;
  hdImage?: string | null;
}

/** A part's picture: the Amazon listing's, else the part's own Home Depot page's; null when it has neither. */
export function partPicture(part: PicturedPart | undefined): string | null {
  if (!part) return null;
  return pictureUrl(part.image) ?? pictureUrl(part.hdImage ?? null);
}

/**
 * The picture a deal row shows: the bundle's own Home Depot picture first; without one, its first part's (partPicture).
 * Never a later part's: a later part's photo would misdescribe a kit.
 */
export function rowPicture(bundleImage: string | null | undefined, parts: readonly PicturedPart[]): string | null {
  return pictureUrl(bundleImage ?? null) ?? partPicture(parts[0]);
}

/** How far pictures reach on the stored deals (Settings > General: "Pictures for 212 of 258 deals"). */
export interface PictureCoverage {
  /** Deals whose row shows a picture (rowPicture), of all deals. */
  deals: number;
  dealsOf: number;
  /** Distinct parts (by model) with a picture (partPicture), of all distinct parts. */
  parts: number;
  partsOf: number;
}

/** The coverage of `bundles` (a stored report's rows): what the rows and the parts lists would show. */
export function pictureCoverage(bundles: readonly { brand: string; image?: string | null; parts: readonly (PicturedPart & { model: string })[] }[]): PictureCoverage {
  const parts = new Map<string, boolean>();
  let deals = 0;
  for (const b of bundles) {
    if (rowPicture(b.image, b.parts) !== null) deals += 1;
    for (const p of b.parts) {
      const key = `${b.brand.trim().toUpperCase()}:${p.model.trim().toUpperCase()}`;
      parts.set(key, parts.get(key) === true || partPicture(p) !== null);
    }
  }
  return { deals, dealsOf: bundles.length, parts: [...parts.values()].filter(Boolean).length, partsOf: parts.size };
}

/** "Pictures for 212 of 258 deals and 140 of 153 parts.", or null before any deal is stored. */
export function coverageSentence(c: PictureCoverage): string | null {
  if (c.dealsOf === 0) return null;
  const parts = c.partsOf > 0 ? ` and ${c.parts} of ${c.partsOf} ${c.partsOf === 1 ? 'part' : 'parts'}` : '';
  return `Pictures for ${c.deals} of ${c.dealsOf} ${c.dealsOf === 1 ? 'deal' : 'deals'}${parts}.`;
}
