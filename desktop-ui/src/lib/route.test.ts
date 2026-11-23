import { describe, expect, it } from 'vitest';
import { hashOf, parseRoute } from './route';

describe('routes', () => {
  it('reads the shell hashes', () => {
    expect(parseRoute('#/review')).toEqual({ screen: 'review', id: null });
    expect(parseRoute('#/deals/hd-317987591')).toEqual({ screen: 'deals', id: 'hd-317987591' });
    expect(parseRoute('/activity')).toEqual({ screen: 'activity', id: null });
  });
  it('lands on Today for anything else', () => {
    expect(parseRoute('')).toEqual({ screen: 'today', id: null });
    expect(parseRoute('#/nowhere')).toEqual({ screen: 'today', id: null });
  });
  it('carries a sidebar Deals view, with or without an open deal', () => {
    expect(parseRoute('#/deals?view=losing')).toEqual({ screen: 'deals', id: null, view: 'losing' });
    expect(parseRoute('#/deals/hd-317987591?view=confirmed')).toEqual({ screen: 'deals', id: 'hd-317987591', view: 'confirmed' });
    expect(hashOf({ screen: 'deals', id: 'hd-1', view: 'waiting' })).toBe('#/deals/hd-1?view=waiting');
    expect(hashOf({ screen: 'deals', id: null, view: 'all' })).toBe('#/deals');
    expect(parseRoute('#/deals?view=nonsense')).toEqual({ screen: 'deals', id: null });
  });
  it('round-trips an id with odd characters', () => {
    const r = { screen: 'deals' as const, id: 'a/b c' };
    expect(parseRoute(hashOf(r))).toEqual(r);
  });
});
