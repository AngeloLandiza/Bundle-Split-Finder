import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_SETTINGS } from '@core/settings';
import {
  forgetKey, getAccount, getActiveScan, getKey, getLastScheduledRunAt, getNotified, getPackaging, getSettings, getShowChip, setShowChip, savePackaging, restrictKeyAccess,
  saveSettings, setAccount, setActiveScan, setKey, setLastScheduledRunAt, setNotified,
  clearEbayToken, forgetAnthropicKey, forgetEbayKeys, getAnthropicKey, getEbayKeys, getEbaySettings, getEbayToken, saveEbaySettings, setAnthropicKey, setEbayKeys, setEbayToken,
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

describe('packaging', () => {
  it('is empty until saved, round-trips, and drops entries that are not a known answer', async () => {
    expect(await getPackaging()).toEqual({});
    await savePackaging({ A1: 'loose', B2: 'retail_boxed' });
    expect(await getPackaging()).toEqual({ A1: 'loose', B2: 'retail_boxed' });
    await fakeBrowser.storage.local.set({ packaging: { A1: 'loose', B2: 'sealed', C3: null } });
    expect(await getPackaging()).toEqual({ A1: 'loose' });
    await fakeBrowser.storage.local.set({ packaging: ['loose'] });
    expect(await getPackaging()).toEqual({});
    await fakeBrowser.storage.local.set({ packaging: 'junk' });
    expect(await getPackaging()).toEqual({});
  });
});

describe('showChip', () => {
  it('is on until the owner turns it off, and only an explicit false turns it off', async () => {
    expect(await getShowChip()).toBe(true);
    await setShowChip(false);
    expect(await getShowChip()).toBe(false);
    await setShowChip(true);
    expect(await getShowChip()).toBe(true);
    await fakeBrowser.storage.local.set({ showChip: 'junk' });
    expect(await getShowChip()).toBe(true);
  });

  it('is kept in storage.local with the other prefs, and nowhere a page could read', async () => {
    await setKey('secret-value');
    await setShowChip(false);
    expect(Object.keys(await fakeBrowser.storage.local.get(null)).sort()).toEqual(['apiKey', 'showChip']);
    expect(await fakeBrowser.storage.sync.get(null)).toEqual({});
  });

  it('does not change the settings or the key', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, searchesPerScan: 9 });
    await setShowChip(false);
    expect((await getSettings()).searchesPerScan).toBe(9);
    expect(await getKey()).toBeNull();
  });
});

describe('eBay and the model (step 10)', () => {
  it('the eBay keys and the Anthropic key are in storage.local, apart from the SerpApi key and from each other', async () => {
    expect(await getEbayKeys()).toBeNull();
    expect(await getAnthropicKey()).toBeNull();
    await setKey('serp');
    await setEbayKeys({ appId: 'app', certId: 'cert' });
    await setAnthropicKey('sk-ant-x');
    expect(await getEbayKeys()).toEqual({ appId: 'app', certId: 'cert' });
    expect(await getAnthropicKey()).toBe('sk-ant-x');
    const stored = await fakeBrowser.storage.local.get(null);
    expect(Object.keys(stored).sort()).toEqual(['anthropicKey', 'apiKey', 'ebayKeys']);
    expect(Object.keys(await fakeBrowser.storage.session.get(null))).toEqual([]);
    await forgetEbayKeys();
    expect(await getEbayKeys()).toBeNull();
    expect(await getAnthropicKey()).toBe('sk-ant-x');
    expect(await getKey()).toBe('serp');
    await forgetAnthropicKey();
    expect(await getAnthropicKey()).toBeNull();
  });

  it('half a pair of eBay keys, or keys that are not text, read as none', async () => {
    await fakeBrowser.storage.local.set({ ebayKeys: { appId: 'app' }, anthropicKey: 5 });
    expect(await getEbayKeys()).toBeNull();
    expect(await getAnthropicKey()).toBeNull();
    await fakeBrowser.storage.local.set({ ebayKeys: { appId: 'app', certId: '' } });
    expect(await getEbayKeys()).toBeNull();
  });

  it('the judge settings default to Haiku and 60, round-trip, and a wrong field takes its default', async () => {
    expect(await getEbaySettings()).toEqual({ judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 60 });
    await saveEbaySettings({ judgeModel: 'claude-opus-5-5', listingsJudgedPerScan: 12 });
    expect(await getEbaySettings()).toEqual({ judgeModel: 'claude-opus-5-5', listingsJudgedPerScan: 12 });
    await fakeBrowser.storage.local.set({ ebaySettings: { judgeModel: 'gpt-4', listingsJudgedPerScan: 12.5 } });
    expect(await getEbaySettings()).toEqual({ judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 60 });
  });

  it('eBay\'s token lives in storage.session only, and is dropped by clearEbayToken', async () => {
    expect(await getEbayToken()).toBeNull();
    await setEbayToken({ appId: 'app', token: 't', expiresAt: 5 });
    expect(await getEbayToken()).toEqual({ appId: 'app', token: 't', expiresAt: 5 });
    expect(Object.keys(await fakeBrowser.storage.local.get(null))).toEqual([]);
    await clearEbayToken();
    expect(await getEbayToken()).toBeNull();
    await fakeBrowser.storage.session.set({ ebayToken: { appId: 'app', token: '', expiresAt: 5 } });
    expect(await getEbayToken()).toBeNull();
  });
});
