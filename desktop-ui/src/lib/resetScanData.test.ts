import { describe, expect, it } from 'vitest';
import { RESET_BUTTON, RESET_DELETES, RESET_KEEPS, backupLine } from './resetScanData';

describe('the Reset scan data sheet', () => {
  it('names what is deleted and what is kept, and keys stay', () => {
    expect(RESET_DELETES.length).toBeGreaterThan(0);
    expect(RESET_KEEPS).toEqual(expect.arrayContaining(['Your keys', 'Your settings']));
    expect(RESET_DELETES.join(' ')).not.toMatch(/keys|settings/i);
  });
  it('says where the backup goes', () => {
    expect(backupLine('/Users/a/Library/Application Support/Split Finder')).toContain('/Users/a/Library/Application Support/Split Finder');
    expect(backupLine(null)).toContain('data folder');
    expect(RESET_BUTTON).toBe('Reset scan data');
  });
});
