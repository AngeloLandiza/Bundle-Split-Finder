import type { AppSettingsResponse } from './appSync';
import * as prefs from './prefs';
import type { Worker } from './worker';

export function appKeyFingerprint(fromApp: AppSettingsResponse): string {
  return JSON.stringify({
    serpApiKey: fromApp.serpApiKey ?? '',
    keepaApiKey: fromApp.keepaApiKey ?? '',
    ebayAppId: fromApp.ebayAppId ?? '',
    ebayCertId: fromApp.ebayCertId ?? '',
    anthropicKey: fromApp.anthropicKey ?? '',
    ebaySettings: fromApp.ebaySettings ?? null,
  });
}

/** Pushes keys from the app into the helper only when the app key bundle changed (avoids re-checking eBay every poll). */
export async function syncKeysFromApp(worker: Worker, fromApp: AppSettingsResponse): Promise<void> {
  const fingerprint = appKeyFingerprint(fromApp);
  const prev = await prefs.getAppKeySyncFingerprint();
  if (fingerprint === prev) return;

  if (fromApp.serpApiKey?.trim()) {
    await worker.onMessage({ type: 'checkKey', apiKey: fromApp.serpApiKey.trim() }, {});
  }
  if (fromApp.keepaApiKey?.trim()) {
    await worker.onMessage({ type: 'saveKeepaKey', apiKey: fromApp.keepaApiKey.trim() }, {});
  }
  if (fromApp.anthropicKey?.trim()) {
    await worker.onMessage({ type: 'saveAnthropicKey', apiKey: fromApp.anthropicKey.trim() }, {});
  }
  if (fromApp.ebayAppId?.trim() && fromApp.ebayCertId?.trim()) {
    await worker.onMessage(
      { type: 'saveEbayKeys', appId: fromApp.ebayAppId.trim(), certId: fromApp.ebayCertId.trim() },
      {},
    );
  }
  if (fromApp.ebaySettings) {
    await worker.onMessage(
      {
        type: 'saveEbaySettings',
        judgeModel: fromApp.ebaySettings.judgeModel,
        listingsJudgedPerScan: fromApp.ebaySettings.listingsJudgedPerScan,
      },
      {},
    );
  }

  await prefs.setAppKeySyncFingerprint(fingerprint);
}