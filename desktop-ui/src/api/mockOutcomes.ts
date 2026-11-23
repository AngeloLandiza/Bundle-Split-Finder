// The mock agent's outcomes (`?mock=real`): the same pure logic the agent runs (core/src/outcomes), on the owner's real deals from
// mockReal.json, kept in memory. A deal that file holds no bundle for cannot be bought here (the other mock scenarios have no parts
// to follow). Nothing touches the network.

import type { OutcomeEntry, OutcomesResponse, PartOutcomeBody, Purchase, PurchasePatch, PurchaseResponse, RecordPurchaseBody } from '@core/api/contract';
import { DEFAULT_FEES } from '@core/money';
import { applyPartOutcome, newPurchase, OutcomeRefused, partSentence, patchPurchase, patchSentence, purchaseSentence, removedSentence, scorecardOf, snapshotOf, viewOf } from '@core/outcomes/outcomes';
import type { BundleRow } from '@core/scan/types';
import { ApiError } from './types';

interface Entry {
  id: string;
  at: string;
  purchaseId: string;
  sentence: string;
  undoneAt: string | null;
  before: Purchase | null;
  after: Purchase | null;
}

export interface MockOutcomes {
  outcomes(): OutcomesResponse;
  recordPurchase(body: RecordPurchaseBody): PurchaseResponse;
  editPurchase(id: string, patch: PurchasePatch): PurchaseResponse;
  recordPart(id: string, partId: string, body: PartOutcomeBody): PurchaseResponse;
  removePurchase(id: string): { entryId: string };
  undoOutcome(entryId: string): void;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function createMockOutcomes(bundleOf: (dealId: string) => { bundle: BundleRow; basis: string; buyNow: boolean } | undefined, emit: () => void): MockOutcomes {
  let purchases: Purchase[] = [];
  let entries: Entry[] = [];
  let seq = 0;
  const refuse = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof OutcomeRefused) throw new ApiError('server', e.message);
      throw e;
    }
  };
  const write = (purchaseId: string, before: Purchase | null, after: Purchase | null, sentence: string): string => {
    const id = `out-${(seq += 1)}`;
    purchases = after ? (before ? purchases.map((p) => (p.id === purchaseId ? after : p)) : [...purchases, after]) : purchases.filter((p) => p.id !== purchaseId);
    entries = [...entries, { id, at: new Date().toISOString(), purchaseId, sentence, undoneAt: null, before, after }];
    emit();
    return id;
  };
  const find = (id: string): Purchase => {
    const p = purchases.find((x) => x.id === id);
    if (!p) throw new ApiError('server', 'No such purchase.');
    return p;
  };
  const view = (id: string): PurchaseResponse['purchase'] => viewOf(find(id));
  return {
    outcomes() {
      const list: OutcomeEntry[] = [...entries].reverse().slice(0, 50).map((e) => ({
        id: e.id, at: e.at, purchaseId: e.purchaseId, sentence: e.sentence, undoneAt: e.undoneAt,
        undoable: e.undoneAt === null && same(purchases.find((p) => p.id === e.purchaseId) ?? null, e.after),
      }));
      return { purchases: [...purchases].sort((a, b) => b.boughtAt.localeCompare(a.boughtAt)).map(viewOf), scorecard: scorecardOf(purchases, Date.now()), entries: list };
    },
    recordPurchase(body) {
      const found = bundleOf(body.dealId);
      if (!found) throw new ApiError('server', 'The sample data holds no parts for this deal. Open the app with ?mock=real to try recording a purchase.');
      const snapshot = snapshotOf(found.bundle, { fees: DEFAULT_FEES, basis: found.basis, buyNow: found.buyNow, at: new Date().toISOString() });
      const purchase = refuse(() => newPurchase({ id: `pur-${(seq += 1)}`, dealId: body.dealId, snapshot, boughtAt: body.boughtAt, pricePaid: body.pricePaid, quantity: body.quantity, now: Date.now() }));
      const entryId = write(purchase.id, null, purchase, purchaseSentence(purchase));
      return { purchase: view(purchase.id), entryId };
    },
    editPurchase(id, patch) {
      const before = find(id);
      const after = refuse(() => patchPurchase(before, patch as Record<string, unknown>, Date.now()));
      const entryId = write(id, before, after, patchSentence(before, after));
      return { purchase: view(id), entryId };
    },
    recordPart(id, partId, body) {
      const before = find(id);
      const after = refuse(() => applyPartOutcome(before, partId, body, Date.now()));
      const entryId = write(id, before, after, partSentence(after, partId));
      return { purchase: view(id), entryId };
    },
    removePurchase(id) {
      const before = find(id);
      return { entryId: write(id, before, null, removedSentence(before)) };
    },
    undoOutcome(entryId) {
      const entry = entries.find((e) => e.id === entryId);
      if (!entry || entry.undoneAt) throw new ApiError('refused', 'That change was already taken back.');
      if (!same(purchases.find((p) => p.id === entry.purchaseId) ?? null, entry.after)) throw new ApiError('refused', 'That purchase has changed since. Take back the later change first.');
      purchases = entry.before ? (purchases.some((p) => p.id === entry.purchaseId) ? purchases.map((p) => (p.id === entry.purchaseId ? (entry.before as Purchase) : p)) : [...purchases, entry.before]) : purchases.filter((p) => p.id !== entry.purchaseId);
      entries = entries.map((e) => (e.id === entryId ? { ...e, undoneAt: new Date().toISOString() } : e));
      emit();
    },
  };
}
