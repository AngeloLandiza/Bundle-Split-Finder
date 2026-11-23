import { describe, expect, it } from 'vitest';
import type { AiSuggestion, DealPart, DealRow, ReviewQuestion } from '../api/types';
import { dealMenu, hasTitleMatches, partMenu, questionMenu, stepMenu } from './menus';

const row = (over: Partial<DealRow> = {}): DealRow =>
  ({ id: 'hd-1', title: 'Kit', brand: 'RYOBI', model: 'PCL1600K2', itemId: '1', link: 'https://www.homedepot.com/p/1', section: 'confirmed', price: 100, off: 10, matchState: '4 parts matched', profit: 10, roi: 0.1, roiRange: null, needsAnswer: false, updatedAt: '2026-11-22T00:00:00Z', lookup: null, ...over }) as DealRow;
const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe('a deal row\'s menu', () => {
  it('always opens, copies the model and the ASINs, and opens Home Depot when it has the page', () => {
    expect(ids(dealMenu(row(), { scanRunning: false }))).toEqual(['open', 'open-hd', 'copy-model', 'copy-asins']);
    expect(ids(dealMenu(row({ link: null }), { scanRunning: false }))).toEqual(['open', 'copy-model', 'copy-asins']);
  });
  it('offers Look up with its price, and greys it while a scan runs, saying why', () => {
    const idle = dealMenu(row({ lookup: { searches: 2 } }), { scanRunning: false }).find((i) => i.id === 'lookup')!;
    expect(idle.label).toBe('Look up · 2 searches');
    expect(idle.disabled).toBeUndefined();
    expect(dealMenu(row({ lookup: { searches: 1 } }), { scanRunning: true }).find((i) => i.id === 'lookup')).toMatchObject({ label: 'Look up · 1 search', disabled: 'A scan is running. Try again when it has finished.' });
  });
  it('offers Show in Review only when the deal needs an answer, and Verify only for title matches', () => {
    expect(ids(dealMenu(row({ needsAnswer: true }), { scanRunning: false }))).toContain('review');
    expect(ids(dealMenu(row(), { scanRunning: false }))).not.toContain('review');
    expect(hasTitleMatches(row({ matchState: '2 title matches' }))).toBe(true);
    expect(hasTitleMatches(row({ matchState: '1 title match' }))).toBe(true);
    expect(hasTitleMatches(row({ matchState: '4 parts matched' }))).toBe(false);
    expect(ids(dealMenu(row({ matchState: '1 title match' }), { scanRunning: false }))).toContain('verify');
  });
  it('puts a hairline before the copies and before the actions that spend or move', () => {
    const items = dealMenu(row({ lookup: { searches: 2 }, needsAnswer: true }), { scanRunning: false });
    expect(items.filter((i) => i.separatorBefore).map((i) => i.id)).toEqual(['copy-model', 'lookup']);
  });
});

describe('a question row\'s menu', () => {
  const q = (over: Partial<ReviewQuestion> = {}): ReviewQuestion =>
    ({ id: 'q1', kind: 'match', bundle: { id: 'hd-1', title: 'Kit', brand: 'RYOBI', model: 'K', link: 'https://www.homedepot.com/p/1' }, subject: 'PCL660B', prompt: 'p', reason: 'r', evidence: [], choices: [], allowNone: true, allowTyped: false, suggestion: null, askCostUsd: 0.02, openedAt: '', seen: null, ...over }) as ReviewQuestion;
  const verified: AiSuggestion = { status: 'verified', choiceId: null, answer: 'x', reason: null, quotes: [], costUsd: 0 };

  it('offers Ask AI with its cost when he has a model key and nothing has been asked', () => {
    const items = questionMenu(q(), { hasAi: true, asking: false });
    expect(items[0]).toMatchObject({ id: 'ask', label: 'Ask AI · about $0.02', hint: 'A' });
    expect(ids(questionMenu(q(), { hasAi: false, asking: false }))).not.toContain('ask');
    expect(ids(questionMenu(q({ askCostUsd: null }), { hasAi: true, asking: false }))).not.toContain('ask');
    expect(ids(questionMenu(q({ kind: 'ebay' }), { hasAi: true, asking: false }))).not.toContain('ask');
    expect(questionMenu(q(), { hasAi: true, asking: true })[0]!.disabled).toBeTruthy();
  });
  it('offers Approve suggestion only for a verified one, and then not Ask AI', () => {
    const items = questionMenu(q({ suggestion: verified }), { hasAi: true, asking: false });
    expect(ids(items)).toEqual(['approve', 'open-deal', 'open-hd', 'copy-question']);
    expect(ids(questionMenu(q({ suggestion: { ...verified, status: 'unverified' } }), { hasAi: true, asking: false }))).not.toContain('approve');
  });
  it('opens the deal only when the question is tied to one', () => {
    expect(ids(questionMenu(q({ bundle: { id: null, title: 'Kit', brand: 'R', model: 'K', link: null } }), { hasAi: false, asking: false }))).toEqual(['copy-question']);
  });
});

describe('a part\'s menu', () => {
  const part = (over: Partial<DealPart> = {}): DealPart =>
    ({ model: 'PCL900B', qty: 1, title: 'Hand Vacuum', grade: 'inactive', asin: 'B0B2KQ8T7P', price: null, net: null, prices: [], verifySearches: null, unnamed: false, confirm: { state: 'open', ebay: [], confirmed: null, inactive: true }, ...over }) as DealPart;

  it('opens Amazon, copies the ASIN, and offers Confirm a price', () => {
    const items = partMenu(part(), { scanRunning: false });
    expect(ids(items)).toEqual(['open-amazon', 'copy-asin', 'confirm']);
    expect(items[0]!.label).toBe('Open on Amazon');
    expect(items[2]).toMatchObject({ label: 'Confirm a price…', separatorBefore: true });
  });
  it('searches Amazon for a part with no listing, and has no Amazon items for a kit item with no model number', () => {
    expect(partMenu(part({ asin: null }), { scanRunning: false })[0]!.label).toBe('Search Amazon');
    expect(ids(partMenu(part({ asin: null, unnamed: true }), { scanRunning: false }))).toEqual(['confirm']);
  });
  it('offers Change and Remove once a price is confirmed, and greys Remove while a scan runs', () => {
    const own = part({ confirm: { state: 'open', ebay: [], confirmed: { price: 40, link: 'https://www.ebay.com/itm/1', note: null }, inactive: false } });
    const items = partMenu(own, { scanRunning: true });
    expect(items.map((i) => i.label)).toEqual(['Open on Amazon', 'Copy ASIN', 'Change the confirmed price…', 'Remove confirmed price']);
    expect(items[3]).toMatchObject({ danger: true });
    expect(items[3]!.disabled).toBeTruthy();
  });
});

describe('moving through a menu', () => {
  const items = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', disabled: 'no' }, { id: 'c', label: 'C' }];
  it('skips a greyed item and wraps', () => {
    expect(stepMenu(items, 0, 1)).toBe(2);
    expect(stepMenu(items, 2, 1)).toBe(0);
    expect(stepMenu(items, 0, -1)).toBe(2);
    expect(stepMenu(items, -1, 1)).toBe(0);
  });
  it('finds nothing when every item is greyed', () => {
    expect(stepMenu([{ id: 'a', label: 'A', disabled: 'x' }], 0, 1)).toBe(-1);
  });
});
