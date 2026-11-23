import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { readAppSettings, writeAppSettings } from '../appStore';
import { agentDataDir } from '../paths';
import { readAppSecrets } from '../secretsStore';

const settingsFile = `${agentDataDir()}/app-settings.json`;
const secretsFile = `${agentDataDir()}/app-secrets.json`;

afterEach(() => {
  if (existsSync(settingsFile)) unlinkSync(settingsFile);
  if (existsSync(secretsFile)) unlinkSync(secretsFile);
});

describe('secretsStore', () => {
  it('stores keys in app-secrets.json, not app-settings.json', () => {
    writeAppSettings({ serpApiKey: 'secret-key', appPrimaryUi: true });
    const settingsRaw = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
    expect(settingsRaw).not.toHaveProperty('serpApiKey');
    expect(readAppSecrets().serpApiKey).toBe('secret-key');
    expect(readAppSettings().serpApiKey).toBe('secret-key');
  });
});