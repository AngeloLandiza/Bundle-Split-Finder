// Step 11: the progress row's look, from docs/design.md "Scan progress". jsdom does not lay out, so the rules are read
// from the stylesheet; the e2e spec (e2e/progress.spec.ts) checks the row in Chromium at 360 and 480px.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'sidepanel.css'), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selectors`, from `from` on. */
function declarations(selectors: string, from = 0): string {
  const at = css.indexOf(`${selectors} {`, from);
  expect(at, selectors).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf('{', at), css.indexOf('}', at));
}

describe('the progress bar', () => {
  it('is 2px, ink on the line colour, with square ends and no stripes', () => {
    const track = declarations('.progress-bar');
    expect(track).toContain('height: 2px');
    expect(track).toContain('background: var(--line)');
    const fill = declarations('.progress-fill');
    expect(fill).toContain('background: var(--ink)');
    for (const rule of [track, fill]) {
      expect(rule).not.toMatch(/radius|gradient|animation|shadow/);
    }
  });

  it('eases its width, and not at all under prefers-reduced-motion', () => {
    expect(declarations('.progress-fill')).toContain('transition: width');
    const reduced = css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.progress-fill'));
    expect(reduced).toBeGreaterThan(0);
    expect(declarations('.progress-fill', reduced)).toContain('transition: none');
  });
});

describe('the collapsed line', () => {
  it('a long label gives way with an ellipsis; the count never does (QA, 360px)', () => {
    expect(declarations('.progress-label')).toContain('text-overflow: ellipsis');
    expect(declarations('.progress-count')).toContain('flex: none');
  });
});

describe('the step list', () => {
  it('stays hidden while Details is closed, although it is a grid', () => {
    expect(declarations('.progress-steps[hidden]')).toContain('display: none');
  });

  it('"now" is ink and the rest inherit ink-2; figures and state words never wrap', () => {
    expect(declarations('.progress')).toContain('color: var(--ink-2)');
    expect(declarations(".progress-step[data-state='now']")).toContain('color: var(--ink)');
    expect(declarations('.progress-step-state,\n.progress-step-figure')).toContain('white-space: nowrap');
  });

  it('has no card: no fill of its own, no radius, no shadow', () => {
    for (const s of ['.progress-steps', '.progress-step']) expect(declarations(s)).not.toMatch(/background|radius|shadow|border:/);
  });
});
