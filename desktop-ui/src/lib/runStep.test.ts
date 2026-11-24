import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_STEP_KEY, askMainForRunStep, isRunStepRequest, onRunStepRequest } from './runStep';

describe('the Preferences window asks the main window for the schedule step', () => {
  it('writes the request, and a storage that throws is not an error', () => {
    const seen: string[] = [];
    expect(askMainForRunStep({ setItem: (k) => void seen.push(k) })).toBe(true);
    expect(seen).toEqual([RUN_STEP_KEY]);
    expect(askMainForRunStep({ setItem: () => { throw new Error('blocked'); } })).toBe(false);
    expect(askMainForRunStep(null)).toBe(false);
  });

  it('the main window opens the sheet on that request and on nothing else', () => {
    expect(isRunStepRequest({ key: RUN_STEP_KEY, newValue: '1' })).toBe(true);
    expect(isRunStepRequest({ key: RUN_STEP_KEY, newValue: null })).toBe(false);
    expect(isRunStepRequest({ key: 'splitFinder.look', newValue: '1' })).toBe(false);
    let handler: ((e: unknown) => void) | null = null;
    let opened = 0;
    const off = onRunStepRequest(() => void opened++, {
      addEventListener: (_: string, h: unknown) => void (handler = h as (e: unknown) => void),
      removeEventListener: () => void (handler = null),
    } as never);
    handler!({ key: RUN_STEP_KEY, newValue: '2' });
    handler!({ key: 'other', newValue: '2' });
    expect(opened).toBe(1);
    off();
    expect(handler).toBeNull();
  });
});

// The Preferences window renders outside the main window's UiContext (main.tsx). A pane, or a component a pane uses,
// that calls useUi() throws there and leaves the whole window blank: that shipped once (Settings, Scanning, Nov 23).
describe('nothing in the Preferences window needs the main window\'s UiContext', () => {
  const src = join(import.meta.dirname, '..');
  const read = (f: string) => readFileSync(f, 'utf8');
  const local = (from: string, text: string) =>
    [...text.matchAll(/from '(\.{1,2}\/[^']+)'/g)].map((m) => join(from, '..', m[1]!)).flatMap((b) => [`${b}.tsx`, `${b}.ts`]);

  it('no pane, and no component a pane imports, calls useUi()', () => {
    const dir = join(src, 'screens', 'preferences');
    const panes = readdirSync(dir).filter((f) => f.endsWith('.tsx')).map((f) => join(dir, f));
    const seen = new Set<string>();
    const queue = [...panes];
    const offenders: string[] = [];
    while (queue.length) {
      const f = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      let text: string;
      try {
        text = read(f);
      } catch {
        continue;
      }
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (!f.endsWith('/components/ui.ts') && /\buseUi\(\)/.test(code)) offenders.push(f.slice(src.length + 1));
      // Follow components only: screens of the main window are not rendered by a pane.
      for (const next of local(f, text)) if (next.includes('/components/') || next.includes('/screens/preferences/')) queue.push(next);
    }
    expect(offenders).toEqual([]);
    expect(panes.length).toBeGreaterThan(3);
  });
});
