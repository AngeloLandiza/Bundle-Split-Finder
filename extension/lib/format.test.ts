import { describe, expect, it } from 'vitest';
import { money, profit, roi, when } from './format';

describe('money', () => {
  it('two decimals and thousands separators', () => {
    expect(money(1234.5)).toBe('$1,234.50');
    expect(money(749)).toBe('$749.00');
    expect(money(0)).toBe('$0.00');
  });
  it('a negative amount uses the real minus', () => {
    expect(money(-22.7)).toBe('−$22.70');
  });
});

describe('profit', () => {
  it('leading plus on a gain, real minus on a loss', () => {
    expect(profit(337.3)).toBe('+$337.30');
    expect(profit(-22.7)).toBe('−$22.70');
    expect(profit(-22.7).charCodeAt(0)).toBe(0x2212);
  });
  it('zero has no sign', () => {
    expect(profit(0)).toBe('$0.00');
    expect(profit(-0.004)).toBe('$0.00');
  });
});

describe('roi', () => {
  it('a whole percent from a fraction', () => {
    expect(roi(0.45)).toBe('45%');
    expect(roi(0.4549)).toBe('45%');
    expect(roi(-0.06)).toBe('−6%');
    expect(roi(1.234)).toBe('123%');
  });
  it('never shows a negative zero', () => {
    expect(roi(-0.001)).toBe('0%');
  });
});

describe('when', () => {
  const now = new Date(2026, 10, 10, 14, 0, 0).getTime();
  const at = (h: number, m: number, dayOffset = 0) => new Date(2026, 10, 10 + dayOffset, h, m, 0).getTime();

  it('relative under an hour, ahead and behind', () => {
    expect(when(now + 12 * 60_000, now)).toBe('in 12 min');
    expect(when(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(when(now + 20_000, now)).toBe('now');
    expect(when(now - 20_000, now)).toBe('just now');
    expect(when(now, now)).toBe('just now');
    expect(when(now + 59 * 60_000, now)).toBe('in 59 min');
  });
  it('an hour or more today: local time only', () => {
    const text = when(at(16, 30), now);
    expect(text).toMatch(/4:30/);
    expect(text).not.toMatch(/tomorrow|Nov/);
  });
  it('tomorrow: says tomorrow with the time', () => {
    expect(when(at(7, 0, 1), now)).toMatch(/^tomorrow .*7:00/);
  });
  it('another day: the date and the time', () => {
    const text = when(at(7, 0, 3), now);
    expect(text).toMatch(/Nov/);
    expect(text).toMatch(/13/);
    expect(text).toMatch(/7:00/);
  });
  it('rounds to a full hour: clock time, never "in 60 min"', () => {
    expect(when(now + 59.6 * 60_000, now)).not.toMatch(/min/);
  });
  it('yesterday and earlier also carry the date', () => {
    expect(when(at(7, 0, -1), now)).toMatch(/Nov/);
  });
});
