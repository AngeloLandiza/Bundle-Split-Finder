import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { DEFAULT_FEES, type FeeSettings } from '../core/src/money';
import { DEFAULT_EBAY_SETTINGS, DEFAULT_SETTINGS, type EbaySettings, type ExtensionSettings } from '../core/src/settings';
import { agentDataDir } from './paths';
import {
  migrateKeysOutOfSettings,
  readAppSecrets,
  stripKeysFromSettingsObject,
  writeAppSecrets,
  type AppSecrets,
} from './secretsStore';

export const APP_SETTINGS_VERSION = 1 as const;

export type AppSettingsFile = {
  version: typeof APP_SETTINGS_VERSION;
  updatedAt: string;
  /** When true, extension polls app for settings and scan requests (Lane D). */
  appPrimaryUi: boolean;
  /** When app is primary, keep the helper side panel available from the toolbar (P5 power users). */
  compactHelperPanel: boolean;
  /** Step 12: after each scan, helper queues Ask AI about all open review questions. */
  askAfterScan: boolean;
  ebaySettings?: EbaySettings;
  settings: Pick<
    ExtensionSettings,
    | 'schedule'
    | 'searchesPerScan'
    | 'reserve'
    | 'agentBridgeAfterScan'
    | 'keepaTokensPerScan'
    | 'keepaReserve'
    | 'fees'
    | 'brands'
    | 'pagesPerBrand'
  >;
};

const defaults: AppSettingsFile = {
  version: APP_SETTINGS_VERSION,
  updatedAt: new Date(0).toISOString(),
  appPrimaryUi: true,
  compactHelperPanel: false,
  askAfterScan: false,
  ebaySettings: DEFAULT_EBAY_SETTINGS,
  settings: {
    schedule: DEFAULT_SETTINGS.schedule,
    searchesPerScan: DEFAULT_SETTINGS.searchesPerScan,
    reserve: DEFAULT_SETTINGS.reserve,
    agentBridgeAfterScan: true,
    keepaTokensPerScan: DEFAULT_SETTINGS.keepaTokensPerScan,
    keepaReserve: DEFAULT_SETTINGS.keepaReserve,
    fees: DEFAULT_FEES,
    brands: DEFAULT_SETTINGS.brands,
    pagesPerBrand: DEFAULT_SETTINGS.pagesPerBrand,
  },
};

function settingsPath(): string {
  return `${agentDataDir()}/app-settings.json`;
}

export type AppSettingsWithSecrets = AppSettingsFile & AppSecrets;

function mergeSecrets(settings: AppSettingsFile, secrets: AppSecrets): AppSettingsWithSecrets {
  return { ...settings, ...secrets };
}

export function readAppSettings(): AppSettingsWithSecrets {
  const path = settingsPath();
  if (!existsSync(path)) return { ...defaults, updatedAt: new Date().toISOString(), ...readAppSecrets() };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as AppSettingsFile & AppSecrets;
    if (raw.version !== APP_SETTINGS_VERSION) return { ...defaults, updatedAt: new Date().toISOString(), ...readAppSecrets() };
    const hadLegacyKeys =
      raw.serpApiKey || raw.keepaApiKey || raw.ebayAppId || raw.ebayCertId || raw.anthropicKey;
    if (hadLegacyKeys) {
      migrateKeysOutOfSettings(raw);
      const stripped = stripKeysFromSettingsObject(raw);
      writeFileSync(settingsPath(), JSON.stringify({ ...stripped, version: APP_SETTINGS_VERSION }, null, 2));
    }
    const base: AppSettingsFile = {
      ...defaults,
      ...stripKeysFromSettingsObject(raw),
      ebaySettings: raw.ebaySettings
        ? { ...DEFAULT_EBAY_SETTINGS, ...defaults.ebaySettings, ...raw.ebaySettings }
        : defaults.ebaySettings,
      settings: { ...defaults.settings, ...raw.settings },
    };
    return mergeSecrets(base, readAppSecrets());
  } catch {
    return { ...defaults, updatedAt: new Date().toISOString(), ...readAppSecrets() };
  }
}

type KeyPatch = {
  serpApiKey?: string | null;
  keepaApiKey?: string | null;
  ebayAppId?: string | null;
  ebayCertId?: string | null;
  anthropicKey?: string | null;
};

function applySecretPatch(patch: KeyPatch): void {
  const fields: (keyof KeyPatch)[] = ['serpApiKey', 'keepaApiKey', 'ebayAppId', 'ebayCertId', 'anthropicKey'];
  if (!fields.some((f) => f in patch)) return;
  const next = { ...readAppSecrets() };
  for (const f of fields) {
    if (!(f in patch)) continue;
    const v = patch[f];
    if (v === null || v === '') delete next[f];
    else if (typeof v === 'string' && v.length > 0) next[f] = v;
  }
  writeAppSecrets(next);
}

export function writeAppSettings(
  patch: Partial<Omit<AppSettingsFile, keyof KeyPatch>> & KeyPatch,
): AppSettingsWithSecrets {
  const cur = readAppSettings();
  const { serpApiKey: _s, keepaApiKey: _k, ebayAppId: _a, ebayCertId: _c, anthropicKey: _h, ...rest } = patch;
  const base: AppSettingsFile = {
    ...stripKeysFromSettingsObject(cur),
    ...rest,
    settings: { ...cur.settings, ...(patch.settings ?? {}) },
    ebaySettings: patch.ebaySettings
      ? { ...DEFAULT_EBAY_SETTINGS, ...cur.ebaySettings, ...patch.ebaySettings }
      : cur.ebaySettings,
    updatedAt: new Date().toISOString(),
  };
  applySecretPatch(patch);
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(base, null, 2));
  return mergeSecrets(base, readAppSecrets());
}

/** For GET /api/settings — never expose full key fields to public consumers. */
export function publicAppSettings(): AppSettingsFile & {
  serpApiKeySet: boolean;
  keepaKeySet: boolean;
  ebayKeysSet: boolean;
  anthropicKeySet: boolean;
} {
  const s = readAppSettings();
  return {
    ...stripKeysFromSettingsObject(s),
    serpApiKeySet: Boolean(s.serpApiKey?.trim()),
    keepaKeySet: Boolean(s.keepaApiKey?.trim()),
    ebayKeysSet: Boolean(s.ebayAppId?.trim() && s.ebayCertId?.trim()),
    anthropicKeySet: Boolean(s.anthropicKey?.trim()),
  };
}