import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { auditLines, lookFor } from '../../scripts/audit-estimates';
import { loadScanFolder } from '../../scripts/data-folder';
import { buildReport } from '../src/scan/report';
import { DEFAULT_SCAN_SETTINGS } from '../src/scan/types';

// scripts/audit-estimates.ts on the owner's third real scan (fixtures/e2e-2026-11-23/after-scan3). Free; no network.

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan3');

describe('the estimate audit', () => {
  it('prints the counts, every complete estimate with its parts, then the incomplete ones', async () => {
    const lines = auditLines((await buildReport(await loadScanFolder(DIR), DEFAULT_SCAN_SETTINGS)).bundles);
    expect(lines[0]).toBe('59 bundles; 52 with a price and a split; 13 complete estimates; 39 incomplete.');
    expect(lines).toContain('    PCL424B  B0BNFBL5PR  probable  $63.95  "ONE+ 18V Cordless Compact Fixed Base Router Tool Only (Battery Not Included) - PCL424B"');
    expect(lines.some((l) => l.includes('DCK200D1P1W921B') && l.includes('DCK200D1P1 at about $186.76 on Amazon'))).toBe(true);
  });

  it('marks what a look by eye should check, and never decides', () => {
    expect(lookFor({ model: 'PCL424B', title: 'ONE+ 18V Cordless Compact Fixed Base Router Tool Only (Battery Not Included) - PCL424B' })).toEqual([]);
    expect(lookFor({ model: 'PCL1201K2', title: 'ONE+ 18V Cordless 2-Tool Combo Kit with Drill/Driver, Circular Saw, (2) 1.5 Ah Batteries, and Charger' })).toEqual(['title does not name the model']);
    expect(lookFor({ model: 'DCK240C2', title: '20V MAX Drill (Tool Only) (DCK240C2)' })).toEqual(['a kit matched to a bare tool?']);
    expect(lookFor({ model: 'PBP003', title: 'RYOBI PBP003 2-Pack' })).toEqual(['a multi-pack?']);
    expect(lookFor({ model: 'X', title: null })).toEqual(['no saved title']);
  });
});
