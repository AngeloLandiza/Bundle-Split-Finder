// Buy now is a state; the announcement is an event (Nov 25). The owner's store from before it has no record of what was
// announced: opened once, each deal whose buy was sent counts as announced at that day's estimate (BUY_STATE_MIGRATION), so
// the start's re-judge (core/test/buy-state.test.ts) returns PSK1212SB-PCL633B and -PCL031B to Buy now without sending them.

import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BUY_STATE_MIGRATION, Store } from '../store';

const OWNER = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-keepcurrent', 'store', 'tracking.json');

describe('the buy-state migration on the owner\'s store (after-keepcurrent)', () => {
  it('seeds what was announced on Nov 23 once, logged, and keeps it on the next start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-buystate-'));
    const first = Store.open(dir);
    first.update('runtime', (r) => ({ ...r, migrations: (r.migrations ?? []).filter((m) => m !== BUY_STATE_MIGRATION), migrationLog: [] }));
    first.close();
    copyFileSync(OWNER, join(dir, 'store', 'tracking.json'));

    const second = Store.open(dir);
    expect(second.get('tracking').announced).toEqual({
      'homedepot:341966856': expect.objectContaining({ optionId: 'split:PSK1212SB', profit: 43.19 }),
      'homedepot:344305163': expect.objectContaining({ optionId: 'split:PSK1212SB', profit: 38.79 }),
      'homedepot:341965772': expect.objectContaining({ optionId: 'split:PSK1212SB', profit: 26.47 }),
    });
    expect(second.get('runtime').migrationLog).toEqual([expect.objectContaining({ name: BUY_STATE_MIGRATION, sentence: expect.stringMatching(/^Worth buying now is a state now/) })]);
    second.close();

    const third = Store.open(dir);
    expect(third.get('runtime').migrationLog).toHaveLength(1);
    expect(Object.keys(third.get('tracking').announced!)).toHaveLength(3);
    third.close();
  });
});
