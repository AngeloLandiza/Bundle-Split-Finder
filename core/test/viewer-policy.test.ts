// Where a link opens (core/src/links/viewerPolicy.ts). Every address here is a real one from the stored records in
// fixtures/e2e-2026-11-23/after-scan6 or from the app's own code, plus the tricks a stored address could try.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { linkDestination, siteName, viewerPage, VIEWER_SITES } from '../src/links/viewerPolicy';

const HD_PRODUCT =
  'https://www.homedepot.com/p/DEWALT-ATOMIC-20V-MAX-Lithium-Ion-Cordless-Combo-Kit-2-Tool-and-1-4-in-Impact-Driver-with-2-2Ah-Batteries-Charger-and-Bag-DCK225D2WCF850B/326894170';
const HD_SHORT = 'https://www.homedepot.com/p/322138483';
const HD_SEARCH = 'https://www.homedepot.com/s/DEWALT%20DCB346-3';
const AMAZON_LISTING = 'https://www.amazon.com/dp/B0C3YBY7CD';
const AMAZON_SLUG =
  'https://www.amazon.com/RYOBI-Cordless-Impact-Driver-Green/dp/B0BGYFTPGK/ref=sr_1_1_mod_primary_new?keywords=RYOBI+PCL235&sr=8-1';
const AMAZON_SEARCH = 'https://www.amazon.com/s?k=RYOBI%20PCL702B';
const EBAY_LISTING = 'https://www.ebay.com/itm/398045310682';
const SELLER_CENTRAL = 'https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=B09HDZ5MPV';

describe('a source page opens in the viewer', () => {
  it.each([HD_PRODUCT, HD_SHORT, HD_SEARCH, AMAZON_LISTING, AMAZON_SLUG, AMAZON_SEARCH, EBAY_LISTING, 'https://keepa.com/#!product/1-B0C3YBY7CD'])(
    '%s',
    (url) => expect(linkDestination(url)).toBe('viewer'),
  );

  it('names the site the toolbar shows', () => {
    expect(siteName(HD_PRODUCT)).toBe('Home Depot');
    expect(siteName(AMAZON_LISTING)).toBe('Amazon');
    expect(siteName(EBAY_LISTING)).toBe('eBay');
    expect(siteName(SELLER_CENTRAL)).toBeNull();
  });

  it('keeps the address as the parser writes it', () => {
    expect(viewerPage('  https://WWW.HOMEDEPOT.COM/p/322138483 ')?.href).toBe(HD_SHORT);
  });
});

describe('everything else opens in the browser', () => {
  it.each([
    // Sign-in, payment and account pages: he is not signed in inside the app, and a password belongs in his browser.
    ['Seller Central', SELLER_CENTRAL],
    ['Seller Central, bare', 'https://sellercentral.amazon.com'],
    ['Amazon sign-in', 'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2F'],
    ['Amazon cart', 'https://www.amazon.com/gp/cart/view.html'],
    ['Amazon home', 'https://www.amazon.com/'],
    ['Home Depot account', 'https://www.homedepot.com/auth/view/signin'],
    ['Home Depot cart', 'https://www.homedepot.com/mycart/home'],
    ['SerpApi sign-up', 'https://serpapi.com/users/sign_up'],
    ['Keepa API page', 'https://keepa.com/#!api'],
    ['eBay developer account', 'https://developer.ebay.com/my/keys'],
    ['eBay search', 'https://www.ebay.com/sch/i.html?_nkw=DCB205'],
    ['Telegram', 'https://t.me/BotFather'],
    ['GitHub download', 'https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/download/v0.1.0/Split.Finder.dmg'],
    // Not a web page of the list.
    ['chrome:// page', 'chrome://extensions/'],
    ['plain http', 'http://www.homedepot.com/p/322138483'],
    ['the agent', 'http://127.0.0.1:8790/ui/'],
    ['the agent over https', 'https://127.0.0.1:8790/p/1'],
    ['localhost', 'https://localhost/p/1'],
    ['file', 'file:///etc/passwd'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<p>hi</p>'],
    ['custom scheme', 'splitfinder://open'],
    // Lookalikes and tricks a stored address could carry.
    ['lookalike host', 'https://amazon.com.evil.example/dp/B0C3YBY7CD'],
    ['lookalike Home Depot', 'https://www.homedepot.com.evil.example/p/322138483'],
    ['subdomain of the list', 'https://smile.amazon.com/dp/B0C3YBY7CD'],
    ['user name in front', 'https://www.homedepot.com@evil.example/p/322138483'],
    ['user name on the real host', 'https://user:pass@www.amazon.com/dp/B0C3YBY7CD'],
    ['a port', 'https://www.amazon.com:8443/dp/B0C3YBY7CD'],
    ['a tab inside', 'https://www.ama\tzon.com/dp/B0C3YBY7CD'],
    ['a backslash', 'https://www.amazon.com\\@evil.example/dp/B0C3YBY7CD'],
    ['empty', ''],
    ['not an address', 'B0C3YBY7CD'],
  ])('%s', (_name, url) => expect(linkDestination(url)).toBe('browser'));

  it('says browser for nothing at all', () => {
    expect(linkDestination(null)).toBe('browser');
    expect(linkDestination(undefined)).toBe('browser');
  });
});

describe('the shell holds the same list', () => {
  /** Every quoted string between the begin and end markers of a file. */
  const quoted = (text: string): string[] => {
    const block = /VIEWER_SITES begin([\s\S]*?)VIEWER_SITES end/.exec(text)?.[1] ?? '';
    return [...block.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!).sort();
  };

  it('src-tauri/src/viewer/policy.rs names the same hosts, paths and fragments', () => {
    const rust = readFileSync(resolve(import.meta.dirname, '../../src-tauri/src/viewer/policy.rs'), 'utf8');
    const ours = VIEWER_SITES.flatMap((s) => [s.name, ...s.hosts, ...s.paths, ...(s.hash ? [s.hash] : [])]).sort();
    expect(quoted(rust)).toEqual(ours);
  });
});
