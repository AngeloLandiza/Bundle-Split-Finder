import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { clearHdReadPending, peekHdReadPending, readHdReadResult, requestHdRead, storeHdReadResult } from '../hdReadQueue';
import { agentDataDir } from '../paths';

const dataDir = agentDataDir();

afterEach(() => {
  clearHdReadPending();
  const results = `${dataDir}/hd-read-results`;
  if (existsSync(results)) rmSync(results, { recursive: true, force: true });
});

describe('hdReadQueue', () => {
  it('queues item ids and stores results', () => {
    const pending = requestHdRead([341645081, 341645081, 0]);
    expect(pending?.itemIds).toEqual([341645081]);
    expect(peekHdReadPending()?.id).toBe(pending?.id);
    storeHdReadResult(pending!.id, [{ itemId: '341645081', status: 200 }]);
    expect(readHdReadResult(pending!.id)).toMatchObject({ id: pending!.id });
    clearHdReadPending();
    expect(peekHdReadPending()).toBeNull();
  });
});