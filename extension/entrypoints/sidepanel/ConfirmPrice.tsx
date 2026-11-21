// A New price the owner has seen, with a link to the listing. It counts until an Amazon New price is chosen.
// The AI never invents a dollar amount (rule 4). A stored eBay listing is a choice he clicks; nothing applies it.
// A part still in Review has no form: the question, and Ask AI, choose the Amazon listing.

import { useId, useState, type FormEvent } from 'react';
import { parseConfirmedPrice } from '@core/scan/confirmed';
import type { PartRow, PriceOption, UnnamedItem } from '@core/scan/types';
import { money } from '../../lib/format';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';

export interface ConfirmPriceProps {
  brand: string;
  model: string;
  part: PartRow;
  api: WorkerApi;
  scanRunning: boolean;
  /** The saved price is not also in a prices list, so the form shows the figure. */
  showFigure?: boolean;
  /**
   * A list of these forms already says the scan sentence once. The buttons stay disabled; this form
   * does not repeat the sentence.
   */
  hideScanNote?: boolean;
}

export const SCAN_PRICE_LATER = 'A scan is running. Save the price when it has finished.';
const NONE_WHY = 'No priced Amazon listing is chosen, so this part counts at $0. Enter the price you saw, and a link. An eBay or Facebook link is enough.';
const UNNAMED_WHY = 'This has no model number, so it is not looked up. It counts at $0 until you enter the price you saw and a link. An eBay or Facebook link is enough.';
const COUNTS_UNTIL = 'A price you confirm counts until this listing is for sale again.';
const INACTIVE_WHY = COUNTS_UNTIL;
const CHOICE_WHY = 'Count one of these eBay prices, or enter a price and a link you have seen. A Facebook link is enough.';
const INACTIVE_CHOICE_WHY = `${COUNTS_UNTIL} ${CHOICE_WHY}`;

const webLink = (link: string): boolean => {
  try {
    const url = new URL(link);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' && url.hostname !== '';
  } catch {
    return false;
  }
};

/** One button per stored eBay listing that has a price and a web link. A range with no per-listing price offers none. */
function ebayChoices(part: PartRow): { href: string; price: number }[] {
  const ebay = part.prices.find((o) => o.kind === 'ebay_sold_new')?.ebay;
  if (!ebay?.linkPrices) return [];
  const out: { href: string; price: number }[] = [];
  ebay.links.forEach((href, i) => {
    const price = ebay.linkPrices?.[i];
    if (typeof price === 'number' && Number.isFinite(price) && price > 0 && webLink(href)) out.push({ href, price });
  });
  return out;
}

/**
 * The form is about to offer Count for this part's eBay listings. The reference line then keeps the range and
 * does not also print those prices as links: one price, one control.
 */
export function confirmShowsChoices(part: PartRow): boolean {
  if (part.status === 'waiting' || part.status === 'unmatched' || part.status === 'review') return false;
  const amazonCounts =
    part.availability === 'active' &&
    part.asin !== null &&
    part.price !== null &&
    !part.prices.some((o) => o.kind === 'confirmed' && !o.reference);
  if (amazonCounts) return false;
  return ebayChoices(part).length > 0;
}

/** A leftover the page names without a model number, as a part the confirm form can price. Never looked up. */
export function unnamedPart(item: UnnamedItem): PartRow {
  const prices: PriceOption[] = item.price !== null && item.link !== null
    ? [{ kind: 'confirmed', price: item.price, condition: 'new', seller: null, shipsFrom: null, offers: null, asin: null, link: item.link, seenAt: 0, reference: false }]
    : [];
  return {
    model: item.model, qty: item.qty, status: 'none', availability: 'missing', asin: null, grade: null,
    price: item.price, priceSeenAt: null, image: null, title: null, prices,
  };
}

export function ConfirmSellPrice({ brand, model, part, api, scanRunning, showFigure = false, hideScanNote = false }: ConfirmPriceProps) {
  const uid = useId();
  const priceId = `${uid}-price`;
  const linkId = `${uid}-link`;
  const [editing, setEditing] = useState(false);
  const [gone, setGone] = useState(false);
  const [held, setHeld] = useState<{ price: number; link: string } | null>(null);
  const [priceText, setPriceText] = useState('');
  const [linkText, setLinkText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Review is the match question, not a blank price. A leftover's model starts with '~' and still gets the form.
  if (part.status === 'waiting' || part.status === 'unmatched' || part.status === 'review') return null;

  const stored = part.prices.find((o) => o.kind === 'confirmed') ?? null;
  const fromStore = stored && !gone ? { price: stored.price, link: stored.link ?? '' } : null;
  const shown = held ?? fromStore;
  const amazonCounts =
    part.availability === 'active' &&
    part.asin !== null &&
    part.price !== null &&
    !part.prices.some((o) => o.kind === 'confirmed' && !o.reference);
  if (!shown && amazonCounts && !editing) return null;

  const listed = stored !== null && !gone && held === null;
  const persist = (price: number, link: string) => {
    setProblem(null);
    const parsed = parseConfirmedPrice({ brand, model, price, link }, 0);
    if (typeof parsed === 'string') {
      setProblem(parsed);
      return;
    }
    setSaving(true);
    api
      .send({ type: 'setConfirmedPrice', brand, model, price: parsed.price, link: parsed.link })
      .then((reply) => {
        if (reply.ok) {
          setHeld({ price: parsed.price, link: parsed.link });
          setGone(false);
          setEditing(false);
        } else setProblem(reply.error);
      })
      .catch(() => setProblem(UNREACHABLE))
      .finally(() => setSaving(false));
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseConfirmedPrice({ brand, model, price: priceText, link: linkText }, 0);
    if (typeof parsed === 'string') {
      setProblem(parsed);
      return;
    }
    persist(parsed.price, parsed.link);
  };

  const remove = () => {
    setProblem(null);
    setSaving(true);
    api
      .send({ type: 'clearConfirmedPrice', brand, model })
      .then((reply) => {
        if (reply.ok) {
          setGone(true);
          setHeld(null);
          setEditing(false);
          setPriceText('');
          setLinkText('');
        } else setProblem(reply.error);
      })
      .catch(() => setProblem(UNREACHABLE))
      .finally(() => setSaving(false));
  };

  if (shown && !editing) {
    return (
      <div className="detail-confirm">
        {listed && !showFigure ? null : (
          <>
            <div className="detail-part-price">{money(shown.price)}</div>
            {webLink(shown.link) ? (
              <a href={shown.link} target="_blank" rel="noopener noreferrer">
                Listing
              </a>
            ) : null}
          </>
        )}
        <div className="detail-confirm-actions">
          <button
            type="button"
            className="detail-text-btn"
            onClick={() => {
              setPriceText(String(shown.price));
              setLinkText(shown.link);
              setProblem(null);
              setEditing(true);
            }}
          >
            Change price
          </button>
          <button type="button" className="detail-text-btn" disabled={scanRunning || saving} onClick={remove}>
            Remove price
          </button>
        </div>
        {scanRunning && !hideScanNote ? <p className="detail-confirm-why">{SCAN_PRICE_LATER}</p> : null}
        {problem ? (
          <p className="detail-refusal" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    );
  }

  const blank = priceText.trim() === '' || linkText.trim() === '';
  const choices = ebayChoices(part);
  const unnamed = part.model.startsWith('~');
  const why = shown
    ? unnamed
      ? 'Replace the price and the link.'
      : 'Replace the New price and the link. It counts until an Amazon New price is chosen.'
    : choices.length > 0
      ? part.availability === 'inactive' ? INACTIVE_CHOICE_WHY : CHOICE_WHY
      : part.availability === 'inactive'
        ? INACTIVE_WHY
        : unnamed
          ? UNNAMED_WHY
          : NONE_WHY;
  const manual = (
    <>
      <label htmlFor={priceId}>Price</label>
      <input id={priceId} className="figure" inputMode="decimal" autoComplete="off" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
      <label htmlFor={linkId}>Listing link</label>
      <input id={linkId} type="url" autoComplete="off" value={linkText} onChange={(e) => setLinkText(e.target.value)} />
      <div className="detail-confirm-actions">
        <button type="submit" className="detail-btn" disabled={scanRunning || saving || blank}>
          Save price
        </button>
        {editing ? (
          <button type="button" className="detail-text-btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
        ) : null}
      </div>
    </>
  );
  return (
    <form className="detail-confirm" onSubmit={save}>
      <div className="detail-confirm-q" id={`${uid}-q`}>
        Confirm sell price
      </div>
      <p className="detail-confirm-why" id={`${uid}-why`}>
        {why}
      </p>
      {choices.length > 0 ? (
        <div className="detail-confirm-choices">
          {choices.map((c) => (
            <div key={c.href} className="detail-confirm-choice">
              <button type="button" className="detail-btn" disabled={scanRunning || saving} aria-describedby={`${uid}-why`} onClick={() => persist(c.price, c.href)}>
                Count {money(c.price)}
              </button>
              <a href={c.href} target="_blank" rel="noopener noreferrer">
                Open listing
              </a>
            </div>
          ))}
        </div>
      ) : null}
      {choices.length > 0 ? (
        <fieldset className="detail-confirm-manual">
          <legend>Or enter a price and a link</legend>
          {manual}
        </fieldset>
      ) : (
        <div className="detail-confirm-manual">{manual}</div>
      )}
      {scanRunning && !hideScanNote ? <p className="detail-confirm-why">{SCAN_PRICE_LATER}</p> : null}
      {problem ? (
        <p className="detail-refusal" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}
