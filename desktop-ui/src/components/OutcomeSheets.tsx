import { useState, type FormEvent } from 'react';
import type { PartResult, PurchaseView } from '@core/api/contract';
import { api, useAction } from '../api/hooks';
import { money, profit } from '../lib/format';
import { formOfPurchase, initialPurchaseForm, initialReturnForm, initialSaleForm, patchRequest, purchaseRequest, returnRequest, saleRequest, type PurchaseForm, type ReturnForm, type SaleForm } from '../lib/outcomes';
import { Button } from './Button';
import { TextField } from './Fields';
import { Sheet, SheetActions } from './Sheet';
import './OutcomeSheets.css';

/** "I bought this" on a deal, or a correction of a recorded purchase. A sheet over the window, so App holds it (ui.openPurchase). */
export type PurchaseTarget =
  | { mode: 'new'; dealId: string; title: string; model: string; price: number | null; estimate: number | null }
  | { mode: 'edit'; purchase: PurchaseView };

export function PurchaseSheet({ target, onClose }: { target: PurchaseTarget; onClose: () => void }) {
  const edit = target.mode === 'edit' ? target.purchase : null;
  const [form, setForm] = useState<PurchaseForm>(() => (edit ? formOfPurchase(edit) : initialPurchaseForm(target.mode === 'new' ? target.price : null)));
  const [problem, setProblem] = useState<string | null>(null);
  const record = useAction(api.recordPurchase);
  const change = useAction(api.editPurchase);
  const remove = useAction(api.removePurchase);
  const set = (patch: Partial<PurchaseForm>) => {
    setProblem(null);
    setForm((f) => ({ ...f, ...patch }));
  };
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (edit) {
      const r = patchRequest(form, edit);
      if (!r.ok) return setProblem(r.problem);
      if (r.patch === null) return onClose();
      if (await change.run(edit.id, r.patch)) onClose();
      return;
    }
    if (target.mode !== 'new') return;
    const r = purchaseRequest(form, target.dealId);
    if (!r.ok) return setProblem(r.problem);
    if (await record.run(r.body)) onClose();
  };
  const busy = record.busy || change.busy || remove.busy;
  const error = problem ?? record.error ?? change.error ?? remove.error;
  const title = edit ? edit.snapshot.bundle.title : target.mode === 'new' ? target.title : '';
  const model = edit ? edit.snapshot.bundle.model : target.mode === 'new' ? target.model : '';
  const estimate = edit ? edit.snapshot.estimate?.profit ?? null : target.mode === 'new' ? target.estimate : null;
  return (
    <Sheet
      label={edit ? 'Change the purchase' : 'I bought this'}
      width={480}
      onCancel={onClose}
      footer={
        <SheetActions
          lead={
            edit ? (
              <Button variant="danger" busy={remove.busy} busyLabel="Removing…" disabled={busy} onClick={() => void remove.run(edit.id).then((ok) => ok && onClose())}>
                Remove record
              </Button>
            ) : null
          }
          secondary={<Button onClick={onClose}>Cancel</Button>}
          primary={
            <Button variant="primary" busy={record.busy || change.busy} busyLabel="Saving…" disabled={busy} onClick={() => void submit()}>
              {edit ? 'Save changes' : 'Record purchase'}
            </Button>
          }
        />
      }
    >
      <h2 className="os-title">{edit ? 'Change the purchase' : 'I bought this'}</h2>
      <p className="os-part">
        <span className="code">{model}</span> · {title}
      </p>
      <form className="os-form" onSubmit={(e) => void submit(e)}>
        <TextField label="Date bought" type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} width="sm" data-autofocus="" />
        <TextField label="Price paid for one bundle" mono type="number" step="0.01" min="0" inputMode="decimal" prefix="$" value={form.price} onChange={(e) => set({ price: e.target.value })} width="sm" help={target.mode === 'new' && target.price !== null ? `Home Depot’s price on the deal is ${money(target.price)}. Change it if you paid something else.` : undefined} />
        <TextField label="Bundles bought" mono type="number" step="1" min="1" inputMode="numeric" value={form.quantity} onChange={(e) => set({ quantity: e.target.value })} width="xs" />
        {/* The estimate is frozen now and never rewritten; it is what the scorecard compares with what he makes. */}
        {edit ? (
          <p className="os-note">
            The estimate saved when you bought it stays as it was{estimate === null ? ' (the deal had none)' : `: ${profit(estimate)} profit, an estimate from your fee settings`}.
          </p>
        ) : (
          <p className="os-note">
            {estimate === null
              ? 'This deal has no complete estimate yet. The purchase is recorded with its parts and prices as they stand now.'
              : `The estimate as it stands now (${profit(estimate)} profit, an estimate from your fee settings) is saved with the purchase. Later scans never change it.`}
          </p>
        )}
        <button type="submit" hidden />
      </form>
      {error ? (
        <p className="os-error" role="alert">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}

/** What became of one part: sold for a price (and, if he knows it, the net payout), or returned or not sold. */
export interface PartTarget {
  purchase: PurchaseView;
  part: PartResult;
  kind: 'sold' | 'returned';
}

export function PartSheet({ target, onClose }: { target: PartTarget; onClose: () => void }) {
  const { purchase, part, kind } = target;
  const previous = purchase.parts.find((p) => p.partId === part.partId);
  const [sale, setSale] = useState<SaleForm>(() => (kind === 'sold' && previous?.status === 'sold' ? { date: previous.date ?? initialSaleForm().date, price: String(previous.salePrice ?? ''), payout: previous.netPayout === null ? '' : String(previous.netPayout) } : initialSaleForm()));
  const [back, setBack] = useState<ReturnForm>(() => (kind === 'returned' && previous?.status === 'returned' ? { date: previous.date ?? initialReturnForm().date, back: previous.recovered === null ? '' : String(previous.recovered) } : initialReturnForm()));
  const [problem, setProblem] = useState<string | null>(null);
  const save = useAction(api.recordPart);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const r = kind === 'sold' ? saleRequest(sale) : returnRequest(back);
    if (!r.ok) return setProblem(r.problem);
    if (await save.run(purchase.id, part.partId, r.body)) onClose();
  };
  const units = part.units;
  return (
    <Sheet
      label={kind === 'sold' ? 'Sold for' : 'Returned or not sold'}
      width={480}
      onCancel={onClose}
      footer={
        <SheetActions
          secondary={<Button onClick={onClose}>Cancel</Button>}
          primary={
            <Button variant="primary" busy={save.busy} busyLabel="Saving…" onClick={() => void submit()}>
              Save
            </Button>
          }
        />
      }
    >
      <h2 className="os-title">{kind === 'sold' ? 'Sold for' : 'Returned or not sold'}</h2>
      <p className="os-part">
        <span className="code">{part.model}</span> from {purchase.snapshot.bundle.model}
        {units > 1 ? ` · ${units} units` : ''}
      </p>
      <form className="os-form" onSubmit={(e) => void submit(e)}>
        {kind === 'sold' ? (
          <>
            <TextField label="Date sold" type="date" value={sale.date} onChange={(e) => (setProblem(null), setSale({ ...sale, date: e.target.value }))} width="sm" />
            <TextField label={units > 1 ? 'Sold for, each' : 'Sold for'} mono type="number" step="0.01" min="0" inputMode="decimal" prefix="$" value={sale.price} onChange={(e) => (setProblem(null), setSale({ ...sale, price: e.target.value }))} width="sm" data-autofocus="" />
            <TextField
              label="Net payout, if you know it"
              mono
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              prefix="$"
              value={sale.payout}
              onChange={(e) => (setProblem(null), setSale({ ...sale, payout: e.target.value }))}
              width="sm"
              help={`What reached you after Amazon’s fees${units > 1 ? ', for all the units together' : ''}. Leave it empty and the app takes the sale price less the fees in the estimate saved when you bought it, and says “fees estimated”.`}
            />
          </>
        ) : (
          <>
            <TextField label="Date" type="date" value={back.date} onChange={(e) => (setProblem(null), setBack({ ...back, date: e.target.value }))} width="sm" data-autofocus="" />
            <TextField label="Money you got back, if any" mono type="number" step="0.01" min="0" inputMode="decimal" prefix="$" value={back.back} onChange={(e) => (setProblem(null), setBack({ ...back, back: e.target.value }))} width="sm" help="A refund from Home Depot, for all the units together. Leave it empty if nothing came back." />
          </>
        )}
        <button type="submit" hidden />
      </form>
      {problem || save.error ? (
        <p className="os-error" role="alert">
          {problem ?? save.error}
        </p>
      ) : null}
    </Sheet>
  );
}
