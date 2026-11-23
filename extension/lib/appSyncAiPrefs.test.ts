import { describe, expect, it, vi } from 'vitest';

import { syncAiPrefsFromApp } from './appSyncAiPrefs';
import * as prefs from './prefs';
import type { Worker } from './worker';

describe('appSyncAiPrefs', () => {
  it('pushes askAfterScan when the app value differs', async () => {
    vi.spyOn(prefs, 'getAskAfterScan').mockResolvedValue(false);
    const onMessage = vi.fn().mockResolvedValue({ ok: true });
    const worker = { onMessage } as unknown as Worker;
    await syncAiPrefsFromApp(worker, { ok: true, appPrimaryUi: true, askAfterScan: true });
    expect(onMessage).toHaveBeenCalledWith({ type: 'saveAskAfterScan', on: true }, {});
  });

  it('skips when already matches', async () => {
    vi.spyOn(prefs, 'getAskAfterScan').mockResolvedValue(true);
    const onMessage = vi.fn();
    const worker = { onMessage } as unknown as Worker;
    await syncAiPrefsFromApp(worker, { ok: true, appPrimaryUi: true, askAfterScan: true });
    expect(onMessage).not.toHaveBeenCalled();
  });
});