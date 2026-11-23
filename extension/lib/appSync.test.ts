import { DEFAULT_SETTINGS } from '@core/settings';
import { describe, expect, it } from 'vitest';

import { mergeAppSettings } from './appSync';

describe('appSync', () => {
  it('merges scan caps from the app when primary UI is on', () => {
    const merged = mergeAppSettings(DEFAULT_SETTINGS, {
      ok: true,
      appPrimaryUi: true,
      settings: { searchesPerScan: 8, reserve: 120, agentBridgeAfterScan: true },
    });
    expect(merged.searchesPerScan).toBe(8);
    expect(merged.reserve).toBe(120);
    expect(merged.agentBridgeAfterScan).toBe(true);
  });

  it('merges schedule from the app', () => {
    const merged = mergeAppSettings(DEFAULT_SETTINGS, {
      ok: true,
      appPrimaryUi: true,
      settings: { schedule: { mode: 'daily', at: '07:00' } },
    });
    expect(merged.schedule).toEqual({ mode: 'daily', at: '07:00' });
  });

  it('merges brands from the app', () => {
    const merged = mergeAppSettings(DEFAULT_SETTINGS, {
      ok: true,
      appPrimaryUi: true,
      settings: { brands: ['DEWALT'] },
    });
    expect(merged.brands).toEqual(['DEWALT']);
  });

  it('merges fee settings from the app', () => {
    const merged = mergeAppSettings(DEFAULT_SETTINGS, {
      ok: true,
      appPrimaryUi: true,
      settings: { fees: { ...DEFAULT_SETTINGS.fees, inboundCost: 12 } },
    });
    expect(merged.fees.inboundCost).toBe(12);
  });

  it('ignores app settings when primary UI is off', () => {
    const merged = mergeAppSettings(DEFAULT_SETTINGS, {
      ok: true,
      appPrimaryUi: false,
      settings: { searchesPerScan: 99 },
    });
    expect(merged.searchesPerScan).toBe(DEFAULT_SETTINGS.searchesPerScan);
  });
});