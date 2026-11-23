import { describe, expect, it } from 'vitest';

import { bridgeSummary, wrapBridgeBody } from '../../agent/bridge';

describe('agent bridge envelope', () => {
  it('wraps and summarizes audit exports', () => {
    const wrapped = wrapBridgeBody({ kind: 'split-finder-audit', version: 1, bundles: [{}, {}] }, '2026-11-22T00:00:00.000Z');
    expect(bridgeSummary(wrapped)).toEqual({
      at: '2026-11-22T00:00:00.000Z',
      bundleCount: 2,
      kind: 'split-finder-audit',
    });
  });
});