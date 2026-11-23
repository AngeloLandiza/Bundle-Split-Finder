import { describe, expect, it } from 'vitest';
import { eta, money, profit, roi, roiRange, roiSigned, usdSpend, when } from './format';

const M = '−';

describe('money and profit', () => {
  it('writes a loss with the real minus sign, never a hyphen', () => {
    expect(profit(-12.5)).toBe(`${M}$12.50`);
    expect(profit(-12.5)).not.toContain('-');
    expect(money(-22.7)).toBe(`${M}$22.70`);
  });
  it('puts a plus on a gain and nothing on zero', () => {
    expect(profit(118.4)).toBe('+$118.40');
    expect(profit(0)).toBe('$0.00');
    expect(profit(-0.001)).toBe('$0.00');
  });
  it('groups thousands', () => {
    expect(money(1234.5)).toBe('$1,234.50');
  });
});

describe('ROI', () => {
  it('is a whole percent with a real minus', () => {
    expect(roi(0.356)).toBe('36%');
    expect(roi(-0.06)).toBe(`${M}6%`);
    expect(roi(-0.004)).toBe('0%');
  });
  it('signs both ends of a range', () => {
    expect(roiSigned(0.12)).toBe('+12%');
    expect(roiSigned(-0.06)).toBe(`${M}6%`);
    expect(roiSigned(0)).toBe('0%');
  });
  it('shows a range only when its ends read differently', () => {
    expect(roiRange({ low: -0.06, high: 0.12 })).toBe(`ROI ${M}6% to +12%`);
    expect(roiRange({ low: 0.201, high: 0.204 })).toBeNull();
    expect(roiRange(null)).toBeNull();
  });
});

describe('spend and time', () => {
  it('says under a cent instead of $0.00', () => {
    expect(usdSpend(0.002)).toBe('under $0.01');
    expect(usdSpend(0.52)).toBe('$0.52');
  });
  it('is relative only under an hour', () => {
    const now = Date.parse('2026-11-22T15:00:00');
    expect(when(now - 20_000, now)).toBe('just now');
    expect(when(now - 12 * 60_000, now)).toBe('12 min ago');
    expect(when(now + 30 * 60_000, now)).toBe('in 30 min');
    expect(when(Date.parse('2026-11-22T09:14:00'), now)).toBe('9:14 AM');
    expect(when(Date.parse('2026-11-23T06:00:00'), now)).toBe('tomorrow 6:00 AM');
  });
  it('labels the estimate and never counts seconds', () => {
    expect(eta(null)).toBe('estimating');
    expect(eta(40)).toBe('under a minute');
    expect(eta(250)).toBe('about 4 min');
  });
});
