import { existsSync, unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { agentDataDir } from '../paths';
import { readHelperState, writeHelperState } from '../stateStore';

const file = `${agentDataDir()}/helper-state.json`;

afterEach(() => {
  if (existsSync(file)) unlinkSync(file);
});

describe('stateStore', () => {
  it('round-trips helper meters', () => {
    writeHelperState({
      hasKey: true,
      hasAnthropicKey: true,
      askAiAllRunning: false,
      scanRunning: false,
      searchesLeft: 120,
      searchesPerMonth: 250,
      keepaTokensLeft: 5,
      keepaRefillMin: 30,
      searchesPerScan: 5,
      rateLimitPerHour: 50,
      lastJob: null,
    });
    expect(readHelperState()?.searchesLeft).toBe(120);
  });
});