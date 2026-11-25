// @vitest-environment jsdom
// Benchmark for scripts/perf: how many React commits do four idle polls cause when the agent's state never changes?
// The stub returns the same content as a NEW object on every call, as fetch + JSON.parse does. It prints
// `commits=<n>` and asserts only that the app rendered.
import { Profiler, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STATE } from './api/mockData';

const h = vi.hoisted(() => {
  const never = () => new Promise<never>(() => undefined);
  const stateCalls = { n: 0 };
  const emit: { fn: ((e: unknown) => void) | null } = { fn: null };
  const overrides: Record<string, unknown> = {
    state: async () => {
      stateCalls.n++;
      return structuredClone(STATE);
    },
    pairRequests: async () => [],
    subscribe: (fn: (e: unknown) => void) => {
      emit.fn = fn;
      return () => undefined;
    },
  };
  const api = new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : never),
  });
  return { api, stateCalls, emit };
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
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('idle polling of App', () => {
  it('reports the commits four unchanged polls cause', async () => {
    let commits = 0;
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(Profiler, { id: 'app', onRender: () => void commits++ }, createElement(App)));
      await vi.advanceTimersByTimeAsync(0);
    });
    // Settle the first load, then count only what the polls do.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(host.textContent?.length).toBeGreaterThan(0);
    const calls = h.stateCalls.n;
    commits = 0;
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
    }
    expect(h.stateCalls.n - calls).toBe(4);
    console.log(`commits=${commits}`);
    await act(async () => root.unmount());
  });
});
