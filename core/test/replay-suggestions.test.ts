import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { replay } from '../../scripts/replay-suggestions';

// The replay of suggested prices and "answer once" on the owner's scan-3 store (scripts/replay-suggestions.ts). No network.

describe('replay on after-scan3', () => {
  it('counts what is stored, what the drip would pull, the eBay what-if, and the questions one answer per part settles', async () => {
    const lines = await replay(join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan3'));
    expect(lines).toContain('From what is stored: 39 missing a price: 0 with a Keepa-average suggestion, 0 with an eBay-middle suggestion (0 with any); 0 where every unpriced part has one (the "if accepted" line).');
    expect(lines.some((l) => l.startsWith('Inactive listings with no stored Keepa average: 5 (P321, DCK225D2, PCL1600K2, PCL206, A10FB1G)'))).toBe(true);
    expect(lines).toContain('With them as the stored eBay listings: 39 missing a price: 0 with a Keepa-average suggestion, 13 with an eBay-middle suggestion (13 with any); 9 where every unpriced part has one (the "if accepted" line).');
    expect(lines).toContain('One answer per distinct part: 2 answers for 2 questions; 0 would be settled without asking (0 questions share every part they ask about with another).');
  });
});
