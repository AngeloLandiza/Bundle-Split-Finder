// Outcomes in the agent (docs/decisions.md, "Outcomes"): the owner's purchases and what became of each part, kept in the
// store's `outcomes` collection (same lock, same atomic writes, in the Reset backup, never emptied by Reset). The pure
// work (freezing the estimate, the results, the scorecard) is core/src/outcomes. This file reads the deal, applies his
// change, keeps one entry per change with what Undo needs, and says it in one sentence for Activity.

import { randomBytes } from 'node:crypto';

import type { OutcomesResponse, PartOutcomeBody, Purchase, PurchaseResponse, PurchasePatch, PurchaseView } from '../core/src/api/contract';
import {
  applyPartOutcome, newPurchase, OutcomeRefused, outcomesCsv, partSentence, patchPurchase, patchSentence, purchaseSentence, removedSentence,
  scorecardOf, snapshotOf, viewOf,
} from '../core/src/outcomes/outcomes';
import { HttpError } from './http';
import { same } from './views';
import type { Store } from './store';
import { dealDetail, entriesView } from './views';

/** The newest this many changes keep what Undo needs. */
export const KEEP_OUTCOME_ENTRIES = 100;


function refuse<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof OutcomeRefused) throw new HttpError('bad_request', e.message);
    throw e;
  }
}

export function outcomesResponse(store: Pick<Store, 'get'>, now: number): OutcomesResponse {
  const o = store.get('outcomes');
  const purchases: PurchaseView[] = [...o.purchases].sort((a, b) => b.boughtAt.localeCompare(a.boughtAt) || b.createdAt.localeCompare(a.createdAt)).map(viewOf);
  return { purchases, scorecard: scorecardOf(o.purchases, now), entries: entriesView(o) };
}

export function outcomesCsvOf(store: Pick<Store, 'get'>): string {
  return outcomesCsv(store.get('outcomes').purchases);
}

export class OutcomeBook {
  constructor(private readonly store: Store, private readonly now: () => number) {}

  private write(purchaseId: string, before: Purchase | null, after: Purchase | null, sentence: string): string {
    const id = `out-${randomBytes(6).toString('hex')}`;
    this.store.update('outcomes', (o) => ({
      purchases: after ? (before ? o.purchases.map((p) => (p.id === purchaseId ? after : p)) : [...o.purchases, after]) : o.purchases.filter((p) => p.id !== purchaseId),
      entries: [...o.entries, { id, at: new Date(this.now()).toISOString(), purchaseId, sentence, undoneAt: null, before, after }].slice(-KEEP_OUTCOME_ENTRIES),
    }));
    return id;
  }

  private find(id: string): Purchase {
    const p = this.store.get('outcomes').purchases.find((x) => x.id === id);
    if (!p) throw new HttpError('not_found', 'No such purchase.');
    return p;
  }

  private view(id: string): PurchaseView {
    return viewOf(this.find(id));
  }

  /** "I bought this": freezes the deal's estimate as it stands now and records the purchase. */
  record(body: { dealId: string; boughtAt?: unknown; pricePaid?: unknown; quantity?: unknown }): PurchaseResponse {
    const detail = dealDetail(
      { deals: this.store.get('deals'), review: this.store.get('review'), settings: this.store.get('settings'), tracking: this.store.get('tracking'), runtime: this.store.get('runtime') },
      body.dealId,
      this.now(),
    );
    if (!detail) throw new HttpError('not_found', 'No such deal.');
    const snapshot = snapshotOf(detail.bundle, {
      fees: this.store.get('settings').settings.fees,
      basis: detail.estimate?.basis ?? detail.estimateBasis,
      buyNow: detail.row.buyNow === true,
      at: new Date(this.now()).toISOString(),
    });
    const purchase = refuse(() =>
      newPurchase({ id: `pur-${randomBytes(6).toString('hex')}`, dealId: body.dealId, snapshot, boughtAt: body.boughtAt, pricePaid: body.pricePaid, quantity: body.quantity, now: this.now() }),
    );
    const entryId = this.write(purchase.id, null, purchase, purchaseSentence(purchase));
    return { purchase: this.view(purchase.id), entryId };
  }

  /** Corrects the date, price paid or quantity. The snapshot is not reachable from here. */
  patch(id: string, patch: PurchasePatch & Record<string, unknown>): PurchaseResponse {
    const before = this.find(id);
    const after = refuse(() => patchPurchase(before, patch, this.now()));
    const entryId = this.write(id, before, after, patchSentence(before, after));
    return { purchase: this.view(id), entryId };
  }

  /** Sold, still holding, or returned / not sold, for one part. Saying it again replaces what was recorded. */
  setPart(id: string, partId: string, body: PartOutcomeBody): PurchaseResponse {
    const before = this.find(id);
    const after = refuse(() => applyPartOutcome(before, partId, body, this.now()));
    const entryId = this.write(id, before, after, partSentence(after, partId));
    return { purchase: this.view(id), entryId };
  }

  /** Removes the record. Undo brings it back whole, snapshot included. */
  remove(id: string): { removed: true; entryId: string } {
    const before = this.find(id);
    const entryId = this.write(id, before, null, removedSentence(before));
    return { removed: true, entryId };
  }

  /** Takes one change back, while the purchase is still as that change left it. */
  undo(entryId: string): { undone: true; purchaseId: string } {
    const o = this.store.get('outcomes');
    const entry = o.entries.find((e) => e.id === entryId);
    if (!entry) throw new HttpError('not_found', 'No such change.');
    if (entry.undoneAt) throw new HttpError('conflict', 'That change was already taken back.');
    const current = o.purchases.find((p) => p.id === entry.purchaseId) ?? null;
    if (!same(current, entry.after)) throw new HttpError('conflict', 'That purchase has changed since. Take back the later change first.');
    const at = new Date(this.now()).toISOString();
    this.store.update('outcomes', (c) => ({
      purchases: entry.before
        ? c.purchases.some((p) => p.id === entry.purchaseId)
          ? c.purchases.map((p) => (p.id === entry.purchaseId ? (entry.before as Purchase) : p))
          : [...c.purchases, entry.before]
        : c.purchases.filter((p) => p.id !== entry.purchaseId),
      entries: c.entries.map((e) => (e.id === entryId ? { ...e, undoneAt: at } : e)),
    }));
    return { undone: true, purchaseId: entry.purchaseId };
  }
}
