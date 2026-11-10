import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { partKey } from '@core/scan/types';

describe('extension tooling', () => {
  it('imports core through the @core alias', () => {
    expect(partKey('ryobi', 'pblrc25b')).toBe('RYOBI:PBLRC25B');
  });

  it('has a fake browser storage', async () => {
    await fakeBrowser.storage.local.set({ a: 1 });
    expect(await fakeBrowser.storage.local.get('a')).toEqual({ a: 1 });
  });
});
