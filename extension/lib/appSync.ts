/** Lane D: poll the native app for settings and scan requests. */
import { DEFAULT_SETTINGS, type EbaySettings, type ExtensionSettings } from '@core/settings';

import { agentBridgeEndpoints } from './agentBridge';

const base = agentBridgeEndpoints().url.replace(/\/api\/bridge$/, '');

export type AppSettingsResponse = {
  ok: boolean;
  serpApiKeySet?: boolean;
  appPrimaryUi?: boolean;
  compactHelperPanel?: boolean;
  settings?: Partial<ExtensionSettings>;
  serpApiKey?: string;
  keepaApiKey?: string;
  ebayAppId?: string;
  ebayCertId?: string;
  anthropicKey?: string;
  ebaySettings?: EbaySettings;
  /** Step 12: worker runs Ask AI about all after each scan when true. */
  askAfterScan?: boolean;
  updatedAt?: string;
};

export async function fetchAppSettings(): Promise<AppSettingsResponse | null> {
  try {
    const res = await fetch(`${base}/api/settings`);
    if (!res.ok) return null;
    return (await res.json()) as AppSettingsResponse;
  } catch {
    return null;
  }
}

export async function ackScan(): Promise<void> {
  try {
    await fetch(`${base}/api/scan/ack`, { method: 'POST' });
  } catch {
    // ignore
  }
}

export async function fetchPendingScan(): Promise<{ id: string } | null> {
  try {
    const res = await fetch(`${base}/api/scan/pending`);
    if (!res.ok) return null;
    const body = (await res.json()) as { ok: boolean; pending: { id: string } | null };
    return body.ok && body.pending ? body.pending : null;
  } catch {
    return null;
  }
}

export function mergeAppSettings(
  current: ExtensionSettings,
  fromApp: AppSettingsResponse,
): ExtensionSettings {
  if (!fromApp.ok || !fromApp.appPrimaryUi || !fromApp.settings) return current;
  return {
    ...current,
    ...fromApp.settings,
    agentBridgeAfterScan: fromApp.settings.agentBridgeAfterScan ?? current.agentBridgeAfterScan,
    searchesPerScan: fromApp.settings.searchesPerScan ?? current.searchesPerScan,
    reserve: fromApp.settings.reserve ?? current.reserve,
    keepaTokensPerScan: fromApp.settings.keepaTokensPerScan ?? current.keepaTokensPerScan,
    keepaReserve: fromApp.settings.keepaReserve ?? current.keepaReserve,
    fees: fromApp.settings.fees ? { ...current.fees, ...fromApp.settings.fees } : current.fees,
    brands: fromApp.settings.brands?.length ? fromApp.settings.brands : current.brands,
    pagesPerBrand: fromApp.settings.pagesPerBrand ?? current.pagesPerBrand,
    schedule: fromApp.settings.schedule ?? current.schedule,
  };
}

export const APP_SYNC_ALARM = 'splitFinderAppSync';

/** Defaults when helper is thin and app owns settings. */
export function helperDefaults(): Partial<ExtensionSettings> {
  return { agentBridgeAfterScan: true };
}

export { DEFAULT_SETTINGS };