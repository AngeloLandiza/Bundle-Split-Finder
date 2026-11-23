import { describe, expect, it, vi } from 'vitest';

import type { AppSettingsResponse } from './appSync';
import { appKeyFingerprint, syncKeysFromApp } from './appSyncKeys';
import * as prefs from './prefs';
import type { Worker } from './worker';

describe('appSyncKeys', () => {
  it('fingerprints the whole key bundle', () => {
    const a: AppSettingsResponse = { ok: true, serpApiKey: 'a', ebayAppId: '1', ebayCertId: '2' };
    const b: AppSettingsResponse = { ok: true, serpApiKey: 'b', ebayAppId: '1', ebayCertId: '2' };
    expect(appKeyFingerprint(a)).not.toBe(appKeyFingerprint(b));
  });

  it('skips worker calls when fingerprint unchanged', async () => {
    const fromApp: AppSettingsResponse = { ok: true, serpApiKey: 'secret' };
    const fp = appKeyFingerprint(fromApp);
    vi.spyOn(prefs, 'getAppKeySyncFingerprint').mockResolvedValue(fp);
    const set = vi.spyOn(prefs, 'setAppKeySyncFingerprint').mockResolvedValue();
    const onMessage = vi.fn();
    const worker = { onMessage } as unknown as Worker;
    await syncKeysFromApp(worker, fromApp);
    expect(onMessage).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});