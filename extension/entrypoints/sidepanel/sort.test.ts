// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSort } from './sort';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('useSort', () => {
  it('defaults to profit, remembers a choice, and ignores a stored value it does not know', () => {
    const first = renderHook(() => useSort());
    expect(first.result.current[0]).toBe('profit');
    act(() => first.result.current[1]('roi'));
    expect(localStorage.getItem('splitFinder.sort')).toBe('roi');
    expect(renderHook(() => useSort()).result.current[0]).toBe('roi');
    localStorage.setItem('splitFinder.sort', 'nonsense');
    expect(renderHook(() => useSort()).result.current[0]).toBe('profit');
  });

  it('works when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useSort());
    expect(result.current[0]).toBe('profit');
    act(() => result.current[1]('discount'));
    expect(result.current[0]).toBe('discount');
  });
});
