import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const chip = readFileSync(join(__dirname, 'chip.css'), 'utf8');
const tokens = readFileSync(join(__dirname, '../../styles/tokens.css'), 'utf8');

const declared = (css: string): Map<string, string> =>
  new Map([...css.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));

describe('chip.css', () => {
  it('uses the design tokens: every custom property it defines equals tokens.css', () => {
    const own = declared(chip);
    const design = declared(tokens);
    expect(own.size).toBeGreaterThan(0);
    for (const [name, value] of own) {
      // The font stacks lead with the extension's own family names (fonts.ts) and end with the token's stack.
      if (name.startsWith('--font-')) expect(value.endsWith(design.get(name)!), name).toBe(true);
      else expect(design.get(name), name).toBe(value);
    }
  });

  it('writes no colour of its own: hex values are only the token block, and the one shadow is the design\'s', () => {
    const outsideTokens = chip.slice(chip.indexOf('}', chip.indexOf(':root')) + 1);
    expect(outsideTokens.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(chip.match(/rgba?\([^)]*\)/g)).toEqual(['rgba(26, 28, 30, 0.12)']);
  });

  it('has no gradient and does not load fonts or images', () => {
    // fonts.ts puts the font files in the page's document; this stylesheet declares none.
    expect(chip.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/gradient|url\(|@font-face|@import/);
  });

  it('is the 40px control the design asks for: white, 1px ink border, 6px radius, light shadow', () => {
    const rule = chip.slice(chip.indexOf('.chip {'), chip.indexOf('}', chip.indexOf('.chip {')));
    expect(rule).toContain('height: 40px');
    expect(rule).toContain('background: var(--surface)');
    expect(rule).toContain('border: 1px solid var(--ink)');
    expect(rule).toContain('border-radius: var(--radius-notice)');
    expect(rule).toContain('box-shadow: 0 1px 2px rgba(26, 28, 30, 0.12)');
  });

  it('puts the chip in flow under the price with no margin, so the layout moves by its own height', () => {
    const host = chip.slice(chip.indexOf(':host {'), chip.indexOf('}', chip.indexOf(':host {')));
    expect(host).toContain('display: block !important');
    expect(host).not.toMatch(/margin|position/);
  });

  it('keeps the visible focus ring', () => {
    expect(chip).toContain('.chip:focus-visible');
    expect(chip).toContain('outline: 2px solid var(--ink)');
  });
});
