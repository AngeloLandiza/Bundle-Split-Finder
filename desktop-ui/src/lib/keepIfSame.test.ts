// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useKeptState } from './keepIfSame';

describe('useKeptState', () => {
  it('renders for the first value and for a change, not for the same content again', async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let renders = 0;
    let set!: (n: { a: number[] }) => void;
    let seen: { a: number[] } | null = null;
    function Probe() {
      const [v, s] = useKeptState<{ a: number[] }>();
      renders++;
      set = s;
      seen = v;
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Probe)));
    expect(renders).toBe(1);
    await act(async () => set({ a: [1, 2] }));
    expect(renders).toBe(2);
    const held = seen;
    await act(async () => set({ a: [1, 2] }));
    await act(async () => set({ a: [1, 2] }));
    expect(renders).toBe(2);
    expect(seen).toBe(held);
    await act(async () => set({ a: [1, 3] }));
    expect(renders).toBe(3);
    expect(seen).toEqual({ a: [1, 3] });
    await act(async () => root.unmount());
  });
});
