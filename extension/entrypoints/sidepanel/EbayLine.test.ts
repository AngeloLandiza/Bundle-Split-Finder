// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { EbayValue } from '@core/ebay/types';
import { ebayLabel } from '@core/ebay/value';
import type { BundleRow, PartRow, PriceOption, ScanJob } from '@core/scan/types';
import type { AppState, PanelReport } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { Detail } from './Detail';

// Step 10: eBay's reference line in a part's price list. The value is DEWALT DCF921B's, as the recorded search and
// item reads give it (core/test/ebay-pass.test.ts); the line is the one ebayLabel writes.

afterEach(cleanup);
const NOW = new Date(2026, 10, 19, 14, 0, 0).getTime();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const VALUE: EbayValue = {
  listings: 5, unitsSold: 345, low: 64.99, high: 137.99, medianPrice: 119.99,
  links: ['https://www.ebay.com/itm/356061995376', 'https://www.ebay.com/itm/306552991202', 'https://www.ebay.com/itm/137923389067'],
  // Each listing's own price, in step with links (validation-2026-11-19.json: 119.99, 137.99, 129.99).
  linkPrices: [119.99, 137.99, 129.99],
};

const ebayOption = (v: EbayValue = VALUE): PriceOption => ({
  kind: 'ebay_sold_new', price: v.medianPrice, condition: 'new', seller: null, shipsFrom: null, offers: v.listings, asin: null, link: v.links[0] ?? null, seenAt: NOW, reference: true, ebay: v,
});
const hdOption: PriceOption = {
  kind: 'homedepot', price: 159, condition: 'new', seller: 'Home Depot', shipsFrom: null, offers: null, asin: null, link: 'https://www.homedepot.com/p/1', seenAt: NOW, reference: true,
};
const amazon: PriceOption = { kind: 'amazon_new', price: 169, condition: 'new', seller: null, shipsFrom: null, offers: null, asin: 'B0B3JWF5ZV', link: 'https://www.amazon.com/dp/B0B3JWF5ZV', seenAt: NOW, reference: false };

const part = (prices: PriceOption[]): PartRow => ({
  model: 'DCF921B', qty: 1, status: 'matched', availability: 'active', asin: 'B0B3JWF5ZV', grade: 'exact', price: 169, priceSeenAt: NOW, image: null,
  title: 'DEWALT 20V MAX Brushless 1/2 in. Impact Wrench (Tool Only)', prices,
});

const row = (parts: PartRow[]): BundleRow => ({
  key: 'homedepot:1', itemId: '1', brand: 'DEWALT', model: 'DCK200D1P1W921B', title: 'DEWALT 20V MAX Combo Kit', link: 'https://www.homedepot.com/p/1', price: 189, regularPrice: 338,
  percentOff: 44, seenAt: NOW, status: 'complete', section: 'confirmed', parts, estimate: { cost: 189, netRevenue: 287.3, profit: 98.3, roi: 0.52 }, uncovered: [], answer: null,
  options: [], kitsNotRead: [], range: { lowest: null, amazonNew: null, highest: null },
});

const state: AppState = { hasKey: true, account: null, accountCheckedAt: 1, problem: null, settings: DEFAULT_SETTINGS, scanRunning: false, lastJob: null as unknown as ScanJob, nextRunAt: null };

function show(prices: PriceOption[]) {
  const r = row([part(prices)]);
  const report: PanelReport = { bundles: [r], review: [], packaging: {} };
  const api: WorkerApi = { send: vi.fn() as unknown as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
  render(createElement(Detail, { api, report, state, bundleKey: r.key, onBack: vi.fn() }));
}

/** The eBay row's words as a person reads them, whatever the markup in between. */
const ebayText = () => document.querySelector('.detail-ebay dt')?.textContent ?? '';

const reference = () => within(screen.getByRole('group', { name: 'Prices for DCF921B' })).getByRole('group', { name: 'Reference · not counted' });

describe("Detail: a part's eBay reference line", () => {
  it('is in the reference group, after the single prices, as ebayLabel writes it', () => {
    show([amazon, ebayOption(), hdOption]);
    const group = reference();
    expect(within(group).getByText('Home Depot · sold alone')).toBeInTheDocument();
    const text = group.textContent ?? '';
    expect(text.indexOf('Home Depot · sold alone')).toBeLessThan(text.indexOf('eBay · New'));
    expect(ebayText()).toBe('eBay · New · $64.99–$137.99 · 5 listings, 345 sold');
    expect(ebayText()).toBe(ebayLabel(VALUE));
    // Not among the counted prices, and not a link itself.
    const counted = screen.getByRole('group', { name: 'Prices for DCF921B' }).querySelector('.detail-prices-counted')!;
    expect(counted.textContent).not.toContain('eBay');
  });

  it('sets the range and the counts in the figure face, each in one piece so no figure breaks across lines', () => {
    show([ebayOption()]);
    const figures = [...document.querySelectorAll('.detail-ebay dt .figure')];
    expect(figures.map((f) => f.textContent)).toEqual(['$64.99–$137.99', '5', '345']);
    expect(document.querySelector('.detail-ebay dt')!.textContent).toContain('listings, ');
  });

  it('offers up to three of its listings, in a new tab, safely, as links on a line of their own', () => {
    show([ebayOption()]);
    const links = within(reference()).getAllByRole('link');
    // Each link reads its listing's price, in the figure face.
    expect(links.map((a) => a.textContent)).toEqual(['$119.99', '$137.99', '$129.99']);
    for (const a of links) expect(a).toHaveClass('figure');
    // Not inside the line's own label: the links are the next element of the row, so they can sit below it.
    expect(links[0]!.closest('dd')!.classList.contains('detail-ebay-links')).toBe(true);
    expect(links[0]!.closest('dt')).toBeNull();
    expect(links.map((a) => a.getAttribute('href'))).toEqual(VALUE.links);
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(['eBay listing 1, $119.99', 'eBay listing 2, $137.99', 'eBay listing 3, $129.99']);
    expect(links[0]).toHaveAccessibleName('eBay listing 1, $119.99');
    expect(links[1]).toHaveAccessibleName('eBay listing 2, $137.99');
  });

  it('shows only http and https links, and no more than three, each still with its own price', () => {
    show([ebayOption({
      ...VALUE,
      links: ['javascript:alert(1)', 'https://www.ebay.com/itm/1', 'data:text/html,x', 'http://www.ebay.com/itm/2', 'https://www.ebay.com/itm/3', 'https://www.ebay.com/itm/4'],
      linkPrices: [1, 11, 2, 22, 33, 44],
    })]);
    const links = within(reference()).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://www.ebay.com/itm/1', 'http://www.ebay.com/itm/2', 'https://www.ebay.com/itm/3']);
    expect(links.map((a) => a.textContent)).toEqual(['$11.00', '$22.00', '$33.00']);
  });

  it('a value stored before linkPrices existed: its links read "Listing N", with the same addresses', () => {
    show([ebayOption({ ...VALUE, linkPrices: undefined })]);
    const links = within(reference()).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Listing 1', 'Listing 2', 'Listing 3']);
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(['eBay listing 1', 'eBay listing 2', 'eBay listing 3']);
  });

  it('a single listing reads "1 listing", with one link', () => {
    show([ebayOption({ listings: 1, unitsSold: 13, low: 38.5, high: 38.5, medianPrice: 38.5, links: ['https://www.ebay.com/itm/237179711800'], linkPrices: [38.5] })]);
    expect(ebayText()).toBe('eBay · New · $38.50 · 1 listing, 13 sold');
    const links = within(reference()).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent('$38.50');
    expect(links[0]).toHaveAccessibleName('eBay listing 1, $38.50');
  });

  it('has no eBay line, and no $0, when the part has no eBay value', () => {
    show([amazon, hdOption]);
    expect(screen.queryByText(/eBay/)).toBeNull();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('opens the reference group for an eBay line alone, and nothing is counted for it', () => {
    show([ebayOption()]);
    expect(reference()).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Prices for DCF921B' }).querySelector('.detail-prices-counted')).toBeNull();
  });

  it('a link with no address is not drawn', () => {
    show([ebayOption({ ...VALUE, links: [] })]);
    expect(within(reference()).queryByRole('link')).toBeNull();
    expect(document.querySelector('.detail-ebay-links')).toBeNull();
  });
});
