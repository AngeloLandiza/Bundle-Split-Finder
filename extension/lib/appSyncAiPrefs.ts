import type { AppSettingsResponse } from './appSync';
import * as prefs from './prefs';
import type { Worker } from './worker';

/** Syncs AI automation prefs owned by the app (Lane D P4). */
export async function syncAiPrefsFromApp(worker: Worker, fromApp: AppSettingsResponse): Promise<void> {
  if (!fromApp.ok || fromApp.appPrimaryUi === false) return;
  if (typeof fromApp.askAfterScan !== 'boolean') return;
  const cur = await prefs.getAskAfterScan();
  if (cur === fromApp.askAfterScan) return;
  await worker.onMessage({ type: 'saveAskAfterScan', on: fromApp.askAfterScan }, {});
}