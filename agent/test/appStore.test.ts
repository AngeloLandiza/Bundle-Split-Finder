import { existsSync, unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { publicAppSettings, readAppSettings, writeAppSettings } from '../appStore';
import { agentDataDir } from '../paths';

const settingsFile = `${agentDataDir()}/app-settings.json`;

afterEach(() => {
  if (existsSync(settingsFile)) unlinkSync(settingsFile);
});

describe('appStore', () => {
  it('defaults appPrimaryUi and hides key in public view', () => {
    writeAppSettings({
      serpApiKey: 'secret-key',
      keepaApiKey: 'keepa',
      ebayAppId: 'app',
      ebayCertId: 'cert',
      anthropicKey: 'anthropic',
    });
    const pub = publicAppSettings();
    expect(pub.serpApiKeySet).toBe(true);
    expect(pub.keepaKeySet).toBe(true);
    expect(pub.ebayKeysSet).toBe(true);
    expect(pub.anthropicKeySet).toBe(true);
    expect(pub).not.toHaveProperty('serpApiKey');
    expect(pub).not.toHaveProperty('keepaApiKey');
    expect(pub).not.toHaveProperty('anthropicKey');
    expect(readAppSettings().serpApiKey).toBe('secret-key');
    expect(readAppSettings().appPrimaryUi).toBe(true);
    expect(readAppSettings().settings.fees.inboundCost).toBe(0);
    expect(readAppSettings().askAfterScan).toBe(false);
    writeAppSettings({ askAfterScan: true });
    expect(readAppSettings().askAfterScan).toBe(true);
  });
});