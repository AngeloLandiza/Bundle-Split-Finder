import { describe, expect, it } from 'vitest';
import { forecast } from './forecast';

describe('forecast', () => {
  it('fits every 6 hours at 1 search on the free plan', () => {
    const f = forecast({ mode: 'interval', hours: 6 }, 1, 250, 20);
    expect(f.scansPerMonth).toBe(120);
    expect(f.fits).toBe(true);
  });
  it('says what it needs and the fix when it does not fit', () => {
    const f = forecast({ mode: 'interval', hours: 6 }, 5, 250, 20);
    expect(f.fits).toBe(false);
    expect(f.sentence).toBe('This needs 600 searches a month and your plan has 230 to spend. Use 1 per scan, or scan less often.');
  });
  it('needs nothing when scans are manual', () => {
    expect(forecast({ mode: 'manual' }, 5, 250, 20).needed).toBe(0);
  });
});
