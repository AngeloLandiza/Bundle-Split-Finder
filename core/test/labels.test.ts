import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CONNECT_BUTTON_LABEL } from '../src/api/labels';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('the pairing button the app names', () => {
  it('is the words the helper shows, as the docs spell them', () => {
    expect(CONNECT_BUTTON_LABEL).toBe('Connect to the Split Finder app');
    expect(read('docs/install.md')).toContain(`**${CONNECT_BUTTON_LABEL}**`);
  });

  it('is one constant: the helper button and the app texts that name it read it, none spells it out', () => {
    for (const file of ['extension/lib/AgentConnect.tsx', 'desktop-ui/src/screens/Welcome.tsx', 'desktop-ui/src/screens/preferences/Chrome.tsx']) {
      const src = read(file);
      expect(src, file).toContain('CONNECT_BUTTON_LABEL');
      expect(src, file).not.toMatch(/press Connect to the app/);
    }
  });
});
