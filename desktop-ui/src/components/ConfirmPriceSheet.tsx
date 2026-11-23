import { useRef, useState } from 'react';
import { confirmedSourceName } from '@core/scan/confirmed';
import { api, useAction, useApp } from '../api/hooks';
import type { DealPart } from '../api/types';
import { confirmRequest, enterAction, foundLine, foundPriceText, IDLE, initialForm, readableLink, readSourceLine, sheetLine, TYPED, type ConfirmForm, type LinkRead } from '../lib/confirmPrice';
import { Spinner } from './States';
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
  /** Suggested prices (Nov 23): "Paste a link" opens on the link field, "Type a price" on the price field. */
  focus?: 'link' | 'price';
}

/**
 * Confirm a price for one part (docs/decisions.md, "A price counts when he confirms it"). He chooses one of the part's
 * stored eBay listings, or pastes a link (eBay, Amazon and Home Depot links are read for the price, which he still confirms; any other link is not read and he types the price). The price counts in
 * the estimate until an Amazon New price does. A part still in Review has no form: its question comes first.
 */
/** What reading the pasted link said, within the sheet: a spinner while it reads, then the price found with its source, or why not. */
function ReadResult({ read }: { read: LinkRead }) {
  if (read.state === 'reading') {
    return (
      <p className="cp-read" role="status">
        <Spinner size={12} /> Reading the price…
      </p>
    );
  }
  if (read.state === 'found') {
    const f = read.found;
    return (
      <div className="cp-read" role="status">
        <p className="cp-found">{foundLine(f)}</p>
        <p className="cp-source">
          {readSourceLine(f, Date.now())} · <SourceLink source={{ label: 'Open the listing', url: f.url }} />
          {f.note ? ` · ${f.note}` : ''}
        </p>
        <p className="cp-source">Check it, change it if it is not right, then save.</p>
      </div>
    );
  }
  if (read.state === 'missed') {
    return (
      <p className="cp-read cp-missed" role="status">
        {read.reason}
      </p>
    );
  }
  return null;
}

export function ConfirmPriceSheet({ target, onClose }: { target: ConfirmTarget; onClose: () => void }) {
  const { part, dealId } = target;
  const { state, navigate } = useApp();
  const line = sheetLine(part);
  const choices = part.confirm.ebay;
  const [form, setForm] = useState<ConfirmForm>(() => {
    const start = initialForm(part);
    return (choices.length === 0 && start.choice === null) || target.focus ? { ...start, choice: TYPED } : start;
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

  // The pasted link, read for its price (POST /api/price-from-link). `readFor` is the link the latest read was made for: an
  // answer that arrives after he changed the link is dropped, and blur after a paste does not read the same link twice.
  const [read, setRead] = useState<LinkRead>(IDLE);
  const readFor = useRef<string | null>(null);
  const readLink = async (raw: string) => {
    const url = readableLink(raw);
    if (url === null || readFor.current === url) return;
    readFor.current = url;
    setProblem(null);
    setRead({ state: 'reading', url });
    let answer: LinkRead;
    try {
      const r = await api.priceFromLink(url);
      answer = r.found ? { state: 'found', url, found: r } : { state: 'missed', url, reason: r.reason };
    } catch (e) {
      answer = { state: 'missed', url, reason: e instanceof Error && e.message ? e.message : 'The price could not be read. Type the price you see.' };
    }
    if (readFor.current !== url) return;
    setRead(answer);
    if (answer.state === 'found') setForm((f) => ({ ...f, choice: TYPED, price: foundPriceText(answer.found) }));
  };
  const enter = () => {
    const what = enterAction(form, read);
    if (what === 'read') void readLink(form.link);
    else if (what === 'save') void submit();
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
            <Button variant="primary" busy={save.busy} busyLabel="Saving…" disabled={scanRunning || busy || form.choice === null || read.state === 'reading'} onClick={() => void submit()}>
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
          enter();
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
            <TextField
              label="Link to the listing"
              type="url"
              autoComplete="off"
              placeholder="Paste a link from eBay, Amazon or Home Depot"
              help="The price is read from an eBay, Amazon or Home Depot link. For any other site, such as Facebook, type the price you see."
              value={form.link}
              autoFocus={target.focus === 'link' || (choices.length === 0 && target.focus !== 'price')}
              onChange={(e) => {
                const value = e.target.value;
                if (readableLink(value) !== readFor.current) {
                  readFor.current = null;
                  setRead(IDLE);
                }
                set({ link: value });
              }}
              onPaste={(e) => void readLink(e.clipboardData.getData('text'))}
              onBlur={(e) => void readLink(e.currentTarget.value)}
            />
            <ReadResult read={read} />
            <TextField label="Price" prefix="$" inputMode="decimal" autoComplete="off" mono type="text" width="sm" autoFocus={target.focus === 'price'} value={form.price} onChange={(e) => set({ price: e.target.value })} />
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
