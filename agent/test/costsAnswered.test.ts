// The sales tax and inbound cost the owner has or has not answered: an old store migrates (a stored value is an answer, a
// stored 0 is not), the state names what the estimates leave out, and the one question is asked until it is closed or settled.
// No network.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { COST_ANSWERED_MIGRATION, Store } from '../store';
import { agentState } from '../views';

/** A store as it was before the marks: the given fees, no marks, the migration not yet run. */
const reopen = (fees: Record<string, number>): Store => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-costs-'));
  const first = Store.open(dir);
  first.update('settings', (s) => {
    const { salesTaxAnswered: _a, inboundAnswered: _b, ...old } = s.settings.fees;
    return { ...s, settings: { ...s.settings, fees: { ...old, ...fees } } };
  });
  first.update('runtime', (r) => ({ ...r, migrations: (r.migrations ?? []).filter((m) => m !== COST_ANSWERED_MIGRATION) }));
  first.close();
  return Store.open(dir);
};

const stateOf = (store: Store) =>
  agentState(
    Object.fromEntries(['agent', 'settings', 'keys', 'deals', 'review', 'suggestions', 'activity', 'autopilot', 'answers', 'jobs', 'pairing', 'outbox', 'runtime', 'tracking'].map((n) => [n, store.get(n as never)])) as never,
    { connected: true, lastSeenAt: null, jobsWaiting: 0, now: 0, busy: null, stopping: false, pipeline: null, nextScanAt: null },
  );

describe('sales tax and inbound shipping answered or not', () => {
  it('an old store: a stored 0 is not an answer, a stored value is', () => {
    const store = reopen({ salesTaxRate: 0, inboundCost: 0 });
    expect(store.get('settings').settings.fees).toMatchObject({ salesTaxAnswered: false, inboundAnswered: false });
    expect(stateOf(store).profitNote).toBe('before sales tax and inbound shipping');
    store.close();
    const some = reopen({ salesTaxRate: 0.0825, inboundCost: 0 });
    expect(some.get('settings').settings.fees).toMatchObject({ salesTaxRate: 0.0825, salesTaxAnswered: true, inboundAnswered: false });
    const s = stateOf(some);
    expect(s.profitNote).toBe('before inbound shipping');
    expect(s.costsPrompt?.sentence).toBe('Your inbound shipping is not set, so profit estimates leave it out. Enter it in Settings, or confirm that it is 0.');
    some.close();
  });

  it('a 0 the owner confirms settles it: no qualifier and no question; the migration is not run again', () => {
    const store = reopen({ salesTaxRate: 0, inboundCost: 0 });
    expect(store.get('runtime').migrations).toContain(COST_ANSWERED_MIGRATION);
    store.update('settings', (s) => ({ ...s, settings: { ...s.settings, fees: { ...s.settings.fees, salesTaxAnswered: true, inboundAnswered: true } } }));
    const st = stateOf(store);
    expect(st.profitNote).toBeUndefined();
    expect(st.costsPrompt).toBeUndefined();
    store.close();
  });

  it('the question is asked until it is closed, and closing it keeps the estimate labelled', () => {
    const store = reopen({ salesTaxRate: 0, inboundCost: 0 });
    expect(stateOf(store).costsPrompt?.sentence).toMatch(/^Your sales tax and inbound shipping are not set/);
    store.update('runtime', (r) => ({ ...r, costsPromptDismissed: true }));
    const s = stateOf(store);
    expect(s.costsPrompt).toBeUndefined();
    expect(s.profitNote).toBe('before sales tax and inbound shipping');
    store.close();
  });
});
