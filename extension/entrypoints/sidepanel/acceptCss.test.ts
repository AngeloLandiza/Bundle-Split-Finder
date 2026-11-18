import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'AcceptSuggested.css'), 'utf8');
const base = readFileSync(join(__dirname, 'sidepanel.css'), 'utf8');

describe("Accept all's row link", () => {
  it('is link-coloured (design.md: blue is only for links), under a selector that outranks .fig-sm, which sets ink', () => {
    expect(base).toMatch(/\.fig-sm \{[^}]*color: var\(--ink\)/);
    const at = css.indexOf('.accept-row .accept-link {');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(css.slice(at, css.indexOf('}', at))).toContain('color: var(--link)');
  });
});
