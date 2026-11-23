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
  it('round-trips an id with odd characters', () => {
    const r = { screen: 'deals' as const, id: 'a/b c' };
    expect(parseRoute(hashOf(r))).toEqual(r);
  });
});
