import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { agentDataDir } from './paths';

/** Lane D P2: keys live outside `app-settings.json` with owner-only permissions (keychain deferred). */
export type AppSecrets = {
  serpApiKey?: string;
  keepaApiKey?: string;
  ebayAppId?: string;
  ebayCertId?: string;
  anthropicKey?: string;
};

function secretsPath(): string {
  return `${agentDataDir()}/app-secrets.json`;
}

export function readAppSecrets(): AppSecrets {
  const path = secretsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AppSecrets;
  } catch {
    return {};
  }
}

export function writeAppSecrets(patch: Partial<AppSecrets>): AppSecrets {
  const cur = readAppSecrets();
  const next: AppSecrets = { ...cur, ...patch };
  for (const f of ['serpApiKey', 'keepaApiKey', 'ebayAppId', 'ebayCertId', 'anthropicKey'] as const) {
    if (f in patch && (patch[f] === '' || patch[f] === undefined)) delete next[f];
  }
  mkdirSync(dirname(secretsPath()), { recursive: true });
  writeFileSync(secretsPath(), JSON.stringify(next, null, 2));
  try {
    chmodSync(secretsPath(), 0o600);
  } catch {
    // Windows or constrained FS: file still exists; macOS app data is user-only.
  }
  return next;
}

export type LegacySettingsWithKeys = AppSecrets & Record<string, unknown>;

/** Moves keys from a legacy `app-settings.json` into `app-secrets.json`. */
export function migrateKeysOutOfSettings(raw: LegacySettingsWithKeys): AppSecrets {
  const patch: AppSecrets = {};
  if (typeof raw.serpApiKey === 'string' && raw.serpApiKey.trim()) patch.serpApiKey = raw.serpApiKey.trim();
  if (typeof raw.keepaApiKey === 'string' && raw.keepaApiKey.trim()) patch.keepaApiKey = raw.keepaApiKey.trim();
  if (typeof raw.ebayAppId === 'string' && raw.ebayAppId.trim()) patch.ebayAppId = raw.ebayAppId.trim();
  if (typeof raw.ebayCertId === 'string' && raw.ebayCertId.trim()) patch.ebayCertId = raw.ebayCertId.trim();
  if (typeof raw.anthropicKey === 'string' && raw.anthropicKey.trim()) patch.anthropicKey = raw.anthropicKey.trim();
  if (Object.keys(patch).length === 0) return readAppSecrets();
  return writeAppSecrets(patch);
}

export function stripKeysFromSettingsObject<T extends LegacySettingsWithKeys>(raw: T): Omit<T, keyof AppSecrets> {
  const { serpApiKey: _s, keepaApiKey: _k, ebayAppId: _a, ebayCertId: _c, anthropicKey: _h, ...rest } = raw;
  return rest as Omit<T, keyof AppSecrets>;
}