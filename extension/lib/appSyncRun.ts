import type { ReadPages } from '@core/scan/types';

import { applyToolbarPanelBehavior } from './appPrimaryUi';
import type { AppState } from './messages';
import * as prefs from './prefs';
import type { Worker } from './worker';
import { ackScan, fetchAppSettings, fetchPendingScan, mergeAppSettings } from './appSync';
import { syncAiPrefsFromApp } from './appSyncAiPrefs';
import { syncKeysFromApp } from './appSyncKeys';
import { runHdReadSync } from './appSyncHdRead';
import { postHelperState } from './appSyncState';
import { pushAuditToApp, runAskSync } from './appSyncAsk';
import { runPaidSync } from './appSyncPaid';
import { runReviewSync } from './appSyncReview';

export type AppSyncDeps = { readPages?: ReadPages; onPrimaryUi?: (primary: boolean, compactPanel: boolean) => void };

/** Polls the native app: settings in, scan requests out. Errors are ignored (helper keeps working). */
export async function runAppSync(worker: Worker, deps: AppSyncDeps = {}): Promise<void> {
  const fromApp = await fetchAppSettings();
  if (!fromApp?.ok) return;

  const primary = fromApp.appPrimaryUi !== false;
  const compactPanel = fromApp.compactHelperPanel === true;
  await prefs.setAppPrimaryUi(primary);
  await prefs.setCompactHelperPanel(compactPanel);
  await applyToolbarPanelBehavior(primary, compactPanel);
  deps.onPrimaryUi?.(primary, compactPanel);

  const state = await worker.onMessage({ type: 'getState' }, {});
  if (!state.ok || !state.data) return;
  const appState = state.data as AppState;
  await postHelperState(appState);

  if (!primary) return;

  const merged = mergeAppSettings(appState.settings, fromApp);
  if (JSON.stringify(merged) !== JSON.stringify(appState.settings)) {
    await worker.onMessage({ type: 'saveSettings', settings: merged }, {});
  }

  await syncKeysFromApp(worker, fromApp);
  await syncAiPrefsFromApp(worker, fromApp);

  const pending = await fetchPendingScan();
  if (pending) {
    await worker.onMessage({ type: 'scanNow' }, {});
    await ackScan();
  }

  if (deps.readPages) await runHdReadSync(deps.readPages);
  await runPaidSync(worker);
  await runAskSync(worker);

  const stateAfterAsk = await worker.onMessage({ type: 'getState' }, {});
  if (stateAfterAsk.ok && stateAfterAsk.data) {
    const after = stateAfterAsk.data as AppState;
    if (appState.askAll || after.askAll || after.askAllResult) await pushAuditToApp(worker);
    await postHelperState(after);
  }

  await runReviewSync(worker);
}