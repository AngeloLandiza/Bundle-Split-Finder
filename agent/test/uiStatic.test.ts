import { describe, expect, it } from 'vitest';

import { agentUiDir } from '../paths';
import { uiIndexExists } from '../uiStatic';

describe('uiStatic', () => {
  it('reports whether the React UI is built', () => {
    expect(typeof agentUiDir()).toBe('string');
    expect(typeof uiIndexExists()).toBe('boolean');
  });
});