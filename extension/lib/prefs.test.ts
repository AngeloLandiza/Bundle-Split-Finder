import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_SETTINGS } from '@core/settings';
import {
  forgetKey, getAccount, getActiveScan, getKey, getLastScheduledRunAt, getNotified, getSettings, restrictKeyAccess,
  saveSettings, setAccount, setActiveScan, setKey, setLastScheduledRunAt, setNotified,
} from './prefs';

beforeEach(() => fakeBrowser.reset());

describe('key', () => {
  it('is null until set, round-trips, and forgetKey removes only the key', async () => {
    expect(await getKey()).toBeNull();
    await setKey('secret-value');
    await saveSettings({ ...DEFAULT_SETTINGS, searchesPerScan: 9 });
    expect(await getKey()).toBe('secret-value');
    await forgetKey();
    expect(await getKey()).toBeNull();
    expect((await getSettings()).searchesPerScan).toBe(9);
  });

  it('restrictKeyAccess sets trusted contexts when the browser supports it', async () => {
    const local = fakeBrowser.storage.local as unknown as { setAccessLevel?: unknown };
    const spy = vi.fn(async () => {});
    local.setAccessLevel = spy;
    await restrictKeyAccess();
    expect(spy).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('restrictKeyAccess does nothing when setAccessLevel is missing', async () => {
    const local = fakeBrowser.storage.local as unknown as { setAccessLevel?: unknown };
    local.setAccessLevel = undefined;
    await expect(restrictKeyAccess()).resolves.toBeUndefined();
  });
});

describe('settings', () => {
  it('equal the defaults when nothing is stored', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trip', async () => {
    const s = { ...DEFAULT_SETTINGS, searchesPerScan: 20, reserve: 0, pagesPerBrand: 3, brands: ['RYOBI'] };
    await saveSettings(s);
    expect(await getSettings()).toEqual(s);
  });

  it('replace wrong or out-of-range fields with defaults, field by field', async () => {
    await fakeBrowser.storage.local.set({
      settings: { searchesPerScan: -3, reserve: 12, pagesPerBrand: 2.5, brands: [] },
    });
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, reserve: 12 });
    await fakeBrowser.storage.local.set({
      settings: { searchesPerScan: 251, reserve: '5', pagesPerBrand: 6, brands: ['DEWALT', 'BOSCH'] },
    });
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    await fakeBrowser.storage.local.set({ settings: 'junk' });
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    await fakeBrowser.storage.local.set({ settings: { searchesPerScan: 250, reserve: 0, pagesPerBrand: 5, brands: ['DEWALT'] } });
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, searchesPerScan: 250, reserve: 0, pagesPerBrand: 5, brands: ['DEWALT'] });
  });

  it('returns a copy of the defaults', async () => {
    (await getSettings()).brands.push('X');
    expect(DEFAULT_SETTINGS.brands).toEqual(['DEWALT', 'RYOBI']);
  });
});

describe('other keys', () => {
  it('activeScan', async () => {
    expect(await getActiveScan()).toBeNull();
    await setActiveScan({ jobId: '1', trigger: 'manual' });
    expect(await getActiveScan()).toEqual({ jobId: '1', trigger: 'manual' });
    await setActiveScan(null);
    expect(await getActiveScan()).toBeNull();
  });
  it('lastScheduledRunAt', async () => {
    expect(await getLastScheduledRunAt()).toBeNull();
    await setLastScheduledRunAt(42);
    expect(await getLastScheduledRunAt()).toBe(42);
  });
  it('notified', async () => {
    expect(await getNotified()).toEqual([]);
    await setNotified(['a', 'b']);
    expect(await getNotified()).toEqual(['a', 'b']);
  });
  it('account', async () => {
    expect(await getAccount()).toBeNull();
    const info = { plan: 'Free' } as never;
    await setAccount({ info, at: 7 });
    expect(await getAccount()).toEqual({ info, at: 7 });
  });
});
