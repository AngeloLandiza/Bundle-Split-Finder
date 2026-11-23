/**
 * Smoke imports per Keepa v2 plan phase (fixture tests live alongside).
 */

import { describe, expect, it } from 'vitest';

import { KeepaClient } from '../src/keepa/client';
import { planKeepaRun } from '../src/keepa/plan';
import { reportStructuralDiscoveryPressure } from '../src/keepa/discovery';
import { partTrendFromProduct } from '../src/keepa/trends';
import { reviewDigestMessage } from '../src/keepa/alerts';
import { relayPayload } from '../src/relay';
import { postScanWork } from '../src/scan/postScan';

describe('keepa v2 phase gates (exports)', () => {
  it('phase 0–2 core modules load', () => {
    expect(typeof KeepaClient).toBe('function');
    expect(typeof planKeepaRun).toBe('function');
    expect(typeof reportStructuralDiscoveryPressure).toBe('function');
    expect(typeof partTrendFromProduct).toBe('function');
  });

  it('phase 4 messaging helpers load', () => {
    expect(typeof reviewDigestMessage).toBe('function');
    expect(typeof relayPayload).toBe('function');
    expect(typeof postScanWork).toBe('function');
  });
});