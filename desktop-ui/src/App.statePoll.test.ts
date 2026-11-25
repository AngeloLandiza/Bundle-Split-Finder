// @vitest-environment jsdom
// A poll (or a state event) that brings the same state must not render the window again; one that brings a change must.
import { Profiler, act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STATE } from './api/mockData';

const h = vi.hoisted(() => {
  const never = () => new Promise<never>(() => undefined);
  const next: { make: () => unknown } = { make: () => null };
  const emit: { fn: ((e: unknown) => void) | null } = { fn: null };
  const overrides: Record<string, unknown> = {
    state: async () => next.make(),
    pairRequests: async () => [],
    subscribe: (fn: (e: unknown) => void) => {
      emit.fn = fn;
      return () => undefined;
    },
  };
  const api = new Proxy(overrides, { get: (t, k: string) => (k in t ? t[k] : never) });
  return { api, next, emit };
});

vi.mock('./api/client', () => ({ api: h.api }));

import { App } from './App';

let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  window.location.hash = '#/today';
  host = document.createElement('div');
  document.body.appendChild(host);
  h.next.make = () => structuredClone(STATE);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function mount() {
  const counter = { commits: 0 };
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Profiler, { id: 'app', onRender: () => void counter.commits++ }, createElement(App)));
    await vi.advanceTimersByTimeAsync(100);
  });
  return { counter, root };
}

describe('App keeps its state when the agent says the same thing again', () => {
  it('does not commit on a poll with identical content, nor on an identical state event', async () => {
    const { counter, root } = await mount();
    // The first poll after mount costs one commit that does not come from the state (React settles a hook the first
    // time a poll runs); what matters is that no later poll does.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    counter.commits = 0;
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
    }
    expect(counter.commits).toBe(0);
    await act(async () => {
      h.emit.fn?.({ type: 'state', state: structuredClone(STATE) });
    });
    expect(counter.commits).toBe(0);
    await act(async () => root.unmount());
  });

  it('still renders when a poll or a state event brings a change', async () => {
    const { counter, root } = await mount();
    counter.commits = 0;
    h.next.make = () => ({ ...structuredClone(STATE), firstRun: !STATE.firstRun });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(counter.commits).toBeGreaterThan(0);
    counter.commits = 0;
    await act(async () => {
      h.emit.fn?.({ type: 'state', state: { ...structuredClone(STATE), firstRun: STATE.firstRun } });
    });
    expect(counter.commits).toBeGreaterThan(0);
    await act(async () => root.unmount());
  });
});
