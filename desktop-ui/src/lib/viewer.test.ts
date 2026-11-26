// The page viewer seen from the app (lib/viewer.ts, lib/viewerBar.ts, lib/linkPrefs.ts, components/Picture.tsx's pure
// part). Addresses and models are real ones from fixtures/e2e-2026-11-23/after-scan6.
import { describe, expect, it } from 'vitest';
import { pictureShown } from '../components/Picture';
import { DEFAULT_LINK_PREFS, parseLinkPrefs } from './linkPrefs';
import { addressParts, dealPages, linkTarget } from './viewer';
import { barKey } from './viewerBar';

const deal = (parts: { model: string; asin: string | null; unnamed?: boolean }[]) => ({
  title: 'RYOBI ONE+ 18V Cordless 6-Tool Combo Kit',
  brand: 'RYOBI',
  model: 'PCL1600K2',
  link: 'https://www.homedepot.com/p/RYOBI-ONE-18V-Cordless-6-Tool-Combo-Kit-PCL1600K2/322138483',
  parts: parts.map((p) => ({ unnamed: false, ...p })),
});

describe('a deal’s source pages', () => {
  it('lists the bundle on Home Depot, then each part’s Amazon listing, or Amazon’s search when it has none', () => {
    const c = dealPages(deal([{ model: 'PCL205B', asin: 'B0C3YBY7CD' }, { model: 'PBP003', asin: null }]));
    expect(c.title).toBe('RYOBI ONE+ 18V Cordless 6-Tool Combo Kit');
    expect(c.pages).toEqual([
      { label: 'Home Depot · PCL1600K2', url: 'https://www.homedepot.com/p/RYOBI-ONE-18V-Cordless-6-Tool-Combo-Kit-PCL1600K2/322138483' },
      { label: 'Amazon · PCL205B', url: 'https://www.amazon.com/dp/B0C3YBY7CD' },
      { label: 'Amazon search · PBP003', url: 'https://www.amazon.com/s?k=RYOBI%20PBP003' },
    ]);
  });

  it('reads the same with six parts, each once, and leaves out an item with no model number', () => {
    const six = ['PCL205B', 'PCL206B', 'PCL225B', 'PCL515B', 'PCL660B', 'PCL705B'].map((model, i) => ({ model, asin: `B0C3YBY7C${i}` }));
    const c = dealPages(deal([...six, { model: 'PCL205B', asin: 'B0C3YBY7C0' }, { model: 'Charger', asin: null, unnamed: true }]));
    expect(c.pages).toHaveLength(7);
    expect(c.pages.slice(1).every((p) => p.label.startsWith('Amazon · '))).toBe(true);
  });

  it('has no Home Depot page when the bundle’s link is missing or not a source page', () => {
    expect(dealPages({ ...deal([{ model: 'PCL205B', asin: 'B0C3YBY7CD' }]), link: null }).pages).toHaveLength(1);
    expect(dealPages({ ...deal([]), link: 'javascript:alert(1)' }).pages).toHaveLength(0);
  });
});

describe('the address field', () => {
  it('puts the real host first, and the rest after it', () => {
    expect(addressParts('https://www.amazon.com/dp/B0C3YBY7CD?th=1')).toEqual({ host: 'www.amazon.com', rest: '/dp/B0C3YBY7CD?th=1' });
    expect(addressParts('https://www.homedepot.com/')).toEqual({ host: 'www.homedepot.com', rest: '' });
    expect(addressParts(null)).toBeNull();
  });

  it('keeps a lookalike host whole, so its real domain shows', () => {
    expect(addressParts('https://www.amazon.com.evil.example/dp/B0C3YBY7CD')?.host).toBe('www.amazon.com.evil.example');
  });
});

describe('where a click goes', () => {
  const o = { prefer: 'app' as const, browserKey: false, inShell: true };
  it('opens a source page in the viewer, anything else in the browser', () => {
    expect(linkTarget('https://www.amazon.com/dp/B0C3YBY7CD', o)).toBe('viewer');
    expect(linkTarget('https://sellercentral.amazon.com/', o)).toBe('browser');
    expect(linkTarget('chrome://extensions/', o)).toBe('none');
  });
  it('opens the browser on Cmd-click, with "In my browser", and outside the app', () => {
    expect(linkTarget('https://www.amazon.com/dp/B0C3YBY7CD', { ...o, browserKey: true })).toBe('browser');
    expect(linkTarget('https://www.amazon.com/dp/B0C3YBY7CD', { ...o, prefer: 'browser' })).toBe('browser');
    expect(linkTarget('https://www.amazon.com/dp/B0C3YBY7CD', { ...o, inShell: false })).toBe('browser');
  });
});

describe('the toolbar’s keys on Windows', () => {
  const k = (key: string, mod = false, shift = false, alt = false) => barKey({ key, mod, shift, alt });
  it('close, reload, back, forward and copy', () => {
    expect(k('Escape')).toBe('close');
    expect(k('w', true)).toBe('close');
    expect(k('r', true)).toBe('reload');
    expect(k('F5')).toBe('reload');
    expect(k('[', true)).toBe('back');
    expect(k(']', true)).toBe('forward');
    expect(k('ArrowLeft', false, false, true)).toBe('back');
    expect(k('C', true, true)).toBe('copy');
  });
  it('leaves every other key alone', () => {
    expect(k('r')).toBeNull();
    expect(k('c', true)).toBeNull();
    expect(k('Escape', true)).toBeNull();
    expect(k('w', true, true)).toBeNull();
  });
});

describe('the link and picture preferences', () => {
  it('default to the viewer and pictures on, and read back what was saved', () => {
    expect(parseLinkPrefs(null)).toEqual(DEFAULT_LINK_PREFS);
    expect(parseLinkPrefs('not json')).toEqual(DEFAULT_LINK_PREFS);
    expect(parseLinkPrefs('{"openLinksIn":"browser","showPictures":false}')).toEqual({ openLinksIn: 'browser', showPictures: false });
    expect(parseLinkPrefs('{"openLinksIn":"elsewhere","showPictures":"no"}')).toEqual(DEFAULT_LINK_PREFS);
  });
});

describe('a picture slot', () => {
  const REAL = 'https://m.media-amazon.com/images/I/81XPDrUh9sL._AC_UL320_.jpg';
  it('shows a stored picture from the image host, else the neutral square', () => {
    expect(pictureShown(REAL, { show: true, failed: false })).toBe(REAL);
    expect(pictureShown(null, { show: true, failed: false })).toBeNull();
    expect(pictureShown('https://evil.example/x.jpg', { show: true, failed: false })).toBeNull();
  });
  it('shows the square when pictures are off or the picture failed to load', () => {
    expect(pictureShown(REAL, { show: false, failed: false })).toBeNull();
    expect(pictureShown(REAL, { show: true, failed: true })).toBeNull();
  });
});
