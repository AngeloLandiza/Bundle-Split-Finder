import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOK, parseLook } from './appearance';

describe('look', () => {
  it('reads a stored look', () => {
    expect(parseLook('{"appearance":"dark","accent":"green","density":"compact"}')).toEqual({ appearance: 'dark', accent: 'green', density: 'compact' });
  });
  it('falls back field by field on anything unknown, missing or broken', () => {
    expect(parseLook('{"appearance":"sepia","density":"compact"}')).toEqual({ ...DEFAULT_LOOK, density: 'compact' });
    expect(parseLook('not json')).toEqual(DEFAULT_LOOK);
    expect(parseLook(null)).toEqual(DEFAULT_LOOK);
  });
});
