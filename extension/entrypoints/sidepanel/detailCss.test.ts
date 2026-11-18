import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'Detail.css'), 'utf8');

/** The declarations of the rule whose selector list is exactly `selectors`. */
function declarations(selectors: string): string {
  const at = css.indexOf(`${selectors} {`);
  expect(at, selectors).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf('{', at), css.indexOf('}', at));
}

describe('the Change beside an answer (Detail.dc.html line 47: a link, not an underlined control)', () => {
  const both = (s: string) => `.detail-answer .detail-text-btn${s},\n.detail-noestimate .detail-text-btn${s}`;

  it('is link-coloured, weight 500 and not underlined', () => {
    const rest = declarations(both(''));
    expect(rest).toContain('color: var(--link)');
    expect(rest).toContain('font-weight: 500');
    expect(rest).toContain('text-decoration: none');
  });

  it('keeps the disabled look', () => {
    expect(declarations(both(':disabled'))).toContain('color: var(--ink-3)');
  });
});

describe("a reference price's label", () => {
  it('is ink-2 and not underlined at rest, and a link on hover and focus', () => {
    const rest = declarations('.detail-price[data-reference] a.detail-price-label');
    expect(rest).toContain('color: var(--ink-2)');
    expect(rest).toContain('text-decoration: none');
    const hover = declarations('.detail-price[data-reference] a.detail-price-label:hover,\n.detail-price[data-reference] a.detail-price-label:focus-visible');
    expect(hover).toContain('color: var(--link)');
    expect(hover).toContain('text-decoration: underline');
  });
});

describe("a part's seen line", () => {
  it('stays on one line, in the body face', () => {
    const rule = declarations('.detail-part-seen');
    expect(rule).toContain('white-space: nowrap');
    expect(rule).toContain('font-family: var(--font-words)');
  });
});
