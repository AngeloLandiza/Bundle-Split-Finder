import { useState } from 'react';
import { confirmedSourceName } from '@core/scan/confirmed';
import { api, useAction, useApp } from '../api/hooks';
import type { DealPart } from '../api/types';
import { confirmRequest, initialForm, sheetLine, TYPED, type ConfirmForm } from '../lib/confirmPrice';
import { money } from '../lib/format';
import { Button, LinkButton } from './Button';
import { TextField } from './Fields';
import { Money } from './Figure';
import { Sheet, SheetActions } from './Sheet';
import { SourceLink } from './Source';
import { webUrl } from '../lib/webUrl';
import './ConfirmPriceSheet.css';

export interface ConfirmTarget {
  dealId: string;
  part: DealPart;
  /** The open Review question on the deal, so "Open Review" lands on it. */
  questionId: string | null;
}

/**
 * Confirm a price for one part (docs/decisions.md, "A price counts when he confirms it"). He chooses one of the part's
 * stored eBay listings, or types a price and a link (a Facebook link is enough; it is not read). The price counts in
 * the estimate until an Amazon New price does. A part still in Review has no form: its question comes first.
 */
export function ConfirmPriceSheet({ target, onClose }: { target: ConfirmTarget; onClose: () => void }) {
  const { part, dealId } = target;
  const { state, navigate } = useApp();
  const line = sheetLine(part);
  const choices = part.confirm.ebay;
  const [form, setForm] = useState<ConfirmForm>(() => {
    const start = initialForm(part);
    return choices.length === 0 && start.choice === null ? { ...start, choice: TYPED } : start;
  });
  const [problem, setProblem] = useState<string | null>(null);
  const save = useAction(api.confirmPrice);
  const remove = useAction(api.removePrice);
  const scanRunning = state?.agent.status === 'scanning';
  const own = part.confirm.confirmed;
  const set = (patch: Partial<ConfirmForm>) => {
    setProblem(null);
    setForm((f) => ({ ...f, ...patch }));
  };

  const submit = async () => {
    const r = confirmRequest(form, part);
    if (!r.ok) {
      setProblem(r.problem);
      return;
    }
    if (await save.run(dealId, part.model, r.body)) onClose();
  };
  const clear = async () => {
    if (await remove.run(dealId, part.model)) onClose();
  };
  const error = problem ?? save.error ?? remove.error;
  const busy = save.busy || remove.busy;

  const head = (
    <>
      <h2 className="cp-title">Confirm a price</h2>
      <p className="cp-part">
        <span className="code">{part.model.replace(/^~/, '')}</span>
        {part.title && part.title !== part.model.replace(/^~/, '') ? <span className="cp-part-title"> · {part.title}</span> : null}
      </p>
    </>
  );

  if (line.kind === 'blocked') {
    return (
      <Sheet
        label="Confirm a price"
        width={480}
        onCancel={onClose}
        footer={
          <SheetActions
            primary={
              <Button variant="primary" onClick={onClose} data-autofocus="">
                Close
              </Button>
            }
          />
        }
      >
        {head}
        <p className="cp-line">{line.text}</p>
        {line.toReview ? (
          <p className="cp-line">
            <LinkButton
              onClick={() => {
                onClose();
                navigate({ screen: 'review', id: target.questionId });
              }}
            >
              Open Review
            </LinkButton>
          </p>
        ) : null}
      </Sheet>
    );
  }

  const typed = form.choice === TYPED;
  return (
    <Sheet
      label="Confirm a price"
      width={520}
      onCancel={onClose}
      footer={
        <SheetActions
          lead={
            own ? (
              <Button variant="danger" busy={remove.busy} busyLabel="Removing…" disabled={scanRunning || save.busy} onClick={() => void clear()}>
                Remove price
              </Button>
            ) : null
          }
          secondary={<Button onClick={onClose}>Cancel</Button>}
          primary={
            <Button variant="primary" busy={save.busy} busyLabel="Saving…" disabled={scanRunning || busy || form.choice === null} onClick={() => void submit()}>
              Save price
            </Button>
          }
        />
      }
    >
      {head}
      <p className="cp-line">{line.text}</p>

      {own ? (
        <p className="cp-now">
          Counted now: <Money value={own.price} /> · Confirmed by you · {confirmedSourceName(own.link)} · <SourceLink source={{ label: 'Open the listing', url: own.link }} />
          {own.note ? <span className="cp-note"> · {own.note}</span> : null}
        </p>
      ) : null}

      <form
        className="cp-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {choices.length > 0 ? (
          <fieldset className="cp-choices">
            <legend className="cp-legend">Your price</legend>
            <div className="cp-box">
              {choices.map((c, i) => (
                <label key={c.url} className={`cp-choice${form.choice === c.url ? ' cp-choice-on' : ''}`}>
                  <input type="radio" name="cp-choice" checked={form.choice === c.url} onChange={() => set({ choice: c.url })} />
                  <span className="cp-choice-text">
                    <span className="cp-choice-price fig">{money(c.price)}</span>
                    <span className="cp-choice-sub">eBay listing {i + 1}, sold New</span>
                  </span>
                  {webUrl(c.url) ? (
                    <a href={webUrl(c.url)!} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                      Open the listing
                    </a>
                  ) : null}
                </label>
              ))}
              <label className={`cp-choice${typed ? ' cp-choice-on' : ''}`}>
                <input type="radio" name="cp-choice" checked={typed} onChange={() => set({ choice: TYPED })} />
                <span className="cp-choice-text">
                  <span className="cp-choice-price">A price I have seen</span>
                  <span className="cp-choice-sub">Enter the price and a link</span>
                </span>
              </label>
            </div>
          </fieldset>
        ) : null}

        {typed ? (
          <div className="cp-fields">
            <TextField label="Price" prefix="$" inputMode="decimal" autoComplete="off" mono type="text" width="sm" value={form.price} onChange={(e) => set({ price: e.target.value })} autoFocus={choices.length === 0} />
            <TextField
              label="Link to the listing"
              type="url"
              autoComplete="off"
              placeholder="eBay, Facebook or another page"
              help="A Facebook link is enough. The link is not read; the price is the one you type."
              value={form.link}
              onChange={(e) => set({ link: e.target.value })}
            />
          </div>
        ) : null}

        <TextField label="Note (optional)" autoComplete="off" placeholder="Where you saw it, what condition" maxLength={200} value={form.note} onChange={(e) => set({ note: e.target.value })} />
        <button type="submit" hidden />
      </form>

      <p className="cp-fine">It counts in the estimate until an Amazon New price does. Profit stays an estimate from your fee settings.</p>
      {scanRunning ? <p className="cp-line">A scan is running. Save the price when it has finished.</p> : null}
      {error ? (
        <p className="cp-error" role="alert">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}
