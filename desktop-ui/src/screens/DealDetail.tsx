import { Fragment, useState } from 'react';
import { api, useAction, useApp, useResource } from '../api/hooks';
import type { DealDetail, DealIncompleteEstimate, DealPart, PriceLine } from '../api/types';
import { Button, LinkButton } from '../components/Button';
import { useMenu } from '../components/ContextMenu';
import { Money, Profit, Roi, RoiRangeLine } from '../components/Figure';
import { SourceLink } from '../components/Source';
import { Fold } from '../components/Fold';
import { LoadError, LoadingState, Notice } from '../components/States';
import { Tag } from '../components/Tag';
import { useUi } from '../components/ui';
import { amazonSearchUrl, amazonUrl, copyText, openPage } from '../lib/actions';
import { money, percentOff, plural, profit, when } from '../lib/format';
import { isMenuKey } from '../lib/keys';
import { breakEvenWords, fromAnswer, ifAcceptedLine, kitWords, pricedCount, suggestionAction, UNPRICED_ACTION, UNPRICED_STATE } from '../lib/incomplete';
import { PART_STATE_WORDS, partsSummary } from '../lib/matchWords';
import { plainReason } from '../lib/questionWords';
import { partMenu, type PartMenuId } from '../lib/menus';
import { BogoChoicesSection, BogoSection, FbaLine, HistorySection, SignalsSection, WatchBar } from './DealTracking';
import './DealDetail.css';

/** One bundle, in the inspector beside the Deals table. */
export function DealDetailPane({ id }: { id: string }) {
  const [res, reload] = useResource(() => api.deal(id), [id], ['deals']);
  const d = res.data;
  return (
    <div className="detail">
      {res.status === 'loading' ? <LoadingState label="Loading the bundle" /> : null}
      {res.status === 'error' && !d ? <LoadError error={res.error} onRetry={reload} /> : null}
      {d ? <Detail d={d} /> : null}
    </div>
  );
}

function Detail({ d }: { d: DealDetail }) {
  const { navigate, state } = useApp();
  const e = d.estimate;
  const [copied, setCopied] = useState<string | null>(null);
  const look = useAction(api.lookUp);
  // Answer once: "Change" on what his answer settled forgets it; the bundles it settled are asked about again.
  const forget = useAction(api.forgetFact);
  // The free quote, asked again when the agent's state changes: what a Look up would spend now (the row's figure may be older).
  const [quote] = useResource(() => (d.lookup ? api.lookupQuote(d.id) : Promise.resolve(null)), [d.id, d.lookup !== null], ['deals']);
  const searches = quote.data ?? d.lookup?.searches ?? null;
  const scanRunning = state?.agent.status === 'scanning';
  // Why the question is asked, in plain words (the agent's note is in Review's Technical detail).
  const [review] = useResource(() => (d.questionId ? api.review() : Promise.resolve(null)), [d.id, d.questionId], ['review']);
  const asked = d.questionId ? review.data?.questions.find((q) => q.id === d.questionId) : undefined;
  const why = asked ? plainReason(asked.reason, { brand: d.brand, model: d.model }).text : null;
  // One primary action: the next step this bundle needs (answer a question, else look up its parts), and only when it needs
  // nothing is Copy ASINs the primary one.
  const next: 'answer' | 'lookup' | null = d.questionId ? 'answer' : d.lookup && !e ? 'lookup' : null;
  const grades = d.parts.filter((p) => !p.unnamed).map((p) => p.grade);
  const summary = partsSummary(grades);
  const allConfirmed = grades.length > 0 && grades.every((g) => g === 'verified');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(d.asins.join('\n'));
      setCopied(`Copied ${plural(d.asins.length, 'ASIN', 'ASINs')}.`);
    } catch {
      setCopied('Could not copy. Select the ASINs by hand.');
    }
  };
  return (
    <>
      <div className="detail-body">
        <header className="detail-head">
          <p className="detail-brand">{d.brand}</p>
          <h2 className="detail-title">{d.title}</h2>
          <p className="detail-meta">
            <span className="code">{d.model}</span>
            {d.price !== null ? (
              <>
                {' · '}
                <span className="fig">{money(d.price)}</span>
              </>
            ) : null}
            {percentOff(d.off) ? ` · ${percentOff(d.off)}` : ''}
          </p>
          <p className="detail-meta">
            <SourceLink source={{ label: 'Open on Home Depot', url: d.link }} />
            {d.seenAt ? <span className="muted"> · price seen {when(d.seenAt)}</span> : null}
          </p>
          <WatchBar d={d} />
        </header>

        {d.signals ? (
          <SignalsSection signals={d.signals} />
        ) : d.signalNote ? (
          // An unwatched bundle with an estimate: the same one sentence the row shortens, first in the inspector.
          <section className="detail-section" aria-labelledby="verdict-title">
            <h3 className="detail-section-title" id="verdict-title">
              Verdict
            </h3>
            <div className="detail-box signals">
              <p className="signals-sentence">{d.signalNote}</p>
            </div>
          </section>
        ) : null}

        <section className="detail-box" aria-label={!e && d.incomplete ? 'Incomplete estimate' : 'Estimate'}>
          {!e && d.incomplete ? (
            <IncompleteEstimate d={d} i={d.incomplete} look={() => void look.run(d.id)} lookBusy={look.busy} lookError={look.error} searches={searches} scanRunning={scanRunning} />
          ) : e ? (
            <>
              <div className="detail-headline">
                {d.beforeFulfillment && d.beforeFulfillment.parts > 0 ? <span className="fig figure-profit figure-xl figure-quiet">{profit(e.profit)}</span> : <Profit value={e.profit} size="xl" />}
                <span className="detail-roi">
                  <Roi value={e.roi} label />
                </span>
              </div>
              <p className="detail-estimate">{d.beforeFulfillment && d.beforeFulfillment.parts > 0 ? `Estimated profit, before fulfillment for ${d.beforeFulfillment.parts} of ${d.beforeFulfillment.of} parts` : 'Estimated profit'}</p>
              <dl className="detail-figures">
                <div>
                  <dt>Bundle costs</dt>
                  <dd>
                    <Money value={e.cost} />
                  </dd>
                </div>
                <div>
                  <dt>Parts sell for</dt>
                  <dd>
                    <Money value={e.partsSellFor} />
                  </dd>
                </div>
                <div>
                  <dt>After fees</dt>
                  <dd>
                    <Money value={e.afterFees} />
                  </dd>
                </div>
              </dl>
              <p className="detail-note">
                {e.basis} <LinkButton onClick={() => navigate({ screen: 'settings', id: 'fees' })}>Change</LinkButton>
              </p>
              <RoiRangeLine range={e.roiRange} />
              {e.countedAtZero.length ? (
                // Nov 23: only items with no model number can be here (a model part with no price leaves no estimate).
                <p className="detail-note">
                  Not counted:{' '}
                  {e.countedAtZero.map((m, i) => (
                    <Fragment key={m}>
                      {i === 0 ? '' : i === e.countedAtZero.length - 1 ? ' and ' : ', '}
                      {m}
                    </Fragment>
                  ))}
                  , with no model number. Confirm a price on the part to count it.
                </p>
              ) : null}
              {d.fbaEstimate ? <FbaLine fba={d.fbaEstimate} /> : null}
            </>
          ) : (
            <>
              <p className="detail-none">{d.noEstimate}</p>
              {d.lookup && searches !== null ? (
                <div className="detail-row">
                  <Button variant={next === 'lookup' ? 'primary' : 'secondary'} busy={look.busy} busyLabel="Looking up…" disabled={scanRunning} onClick={() => void look.run(d.id)} cost={plural(searches, 'search', 'searches')}>
                    Look up
                  </Button>
                  {scanRunning ? <span className="detail-note">A scan is running. Look up when it has finished.</span> : null}
                  {look.error ? <span role="alert">{look.error}</span> : null}
                </div>
              ) : null}
            </>
          )}
        </section>

        {d.questionId ? (
          <Notice
            tone="attention"
            title="Needs your answer."
            action={
              <Button size="sm" variant="primary" onClick={() => navigate({ screen: 'review', id: d.questionId })}>
                Answer in Review
              </Button>
            }
          >
            {why ?? 'Its estimate waits for one question.'}
          </Notice>
        ) : summary && !allConfirmed ? (
          <Notice title="Not everything is confirmed.">{summary}</Notice>
        ) : null}

        {d.parts.length ? (
          <Fold id="parts" title="Parts" aside={allConfirmed ? `${d.parts.length}, all on confirmed listings` : plural(d.parts.length, 'part', 'parts')} defaultOpen={d.parts.length <= 4}>
            {d.splitEvidence?.length ? (
              <Fold id="evidence" title="How we know what is inside" sub>
                <ul className="evidence-list">
                  {d.splitEvidence.map((e, i) => (
                    <li key={i}>
                      <span className="evidence-text">{e.text}</span>{' '}
                      {e.kind === 'owner_fact' && e.model ? (
                        <>
                          {e.url ? <SourceLink source={{ label: EVIDENCE_LABEL.hd_part_page, url: e.url }} /> : null}
                          {e.url ? ' · ' : ''}
                          <LinkButton disabled={forget.busy || scanRunning} onClick={() => void forget.run(`${d.brand}:${e.model}`, e.text.includes(' is sold ') ? 'sellAs' : 'isPart')}>
                            Change
                          </LinkButton>
                        </>
                      ) : (
                        <SourceLink source={{ label: EVIDENCE_LABEL[e.kind], url: e.url ?? null }} />
                      )}
                    </li>
                  ))}
                </ul>
                {forget.error ? <p role="alert" className="detail-note">{forget.error}</p> : null}
              </Fold>
            ) : null}
            <ul className="detail-list">
              {d.parts.map((p) => (
                <Part key={p.model} part={p} dealId={d.id} brand={d.brand} questionId={d.questionId} scanRunning={scanRunning} />
              ))}
            </ul>
          </Fold>
        ) : null}

        {d.bogo ? <BogoSection d={d} bogo={d.bogo} /> : null}
        {d.bogoGroup ? <BogoChoicesSection d={d} group={d.bogoGroup} /> : null}

        {d.ways.length > 1 ? (
          <Fold id="ways" title="Other ways to sell" aside={`${d.ways.length} in all`}>
            <ul className="detail-list">
              {d.ways.map((w) => (
                <li key={w.id} className="way">
                  <div className="way-top">
                    <span className="way-label">{w.label}</span>
                    {w.profit !== null && w.roi !== null ? (
                      <span className="way-money">
                        <Profit value={w.profit} />
                        <Roi value={w.roi} label />
                      </span>
                    ) : w.incomplete ? (
                      <span className="detail-note">{pricedCount(w.incomplete)}</span>
                    ) : (
                      <span className="detail-note">No estimate yet</span>
                    )}
                  </div>
                  <p className="detail-note">
                    {w.primary ? 'Shown above. ' : ''}
                    {w.soldAs ? `${w.soldAs}. ` : ''}
                    {w.incomplete && w.incomplete.breakEvenNet > 0 ? `Its unpriced parts need about ${money(w.incomplete.breakEvenNet)} after fees to break even. ` : ''}
                    {w.leaves.length ? `Leaves ${plural(w.leaves.length, 'part', 'parts')}: ${w.leaves.join(', ')}` : 'Leaves nothing'}
                  </p>
                </li>
              ))}
            </ul>
          </Fold>
        ) : null}

        <HistorySection d={d} />
      </div>

      <footer className="detail-foot">
        <span role="status" className="detail-note">
          {copied ?? (d.asins.length ? plural(d.asins.length, 'ASIN', 'ASINs') : 'No ASIN chosen yet')}
        </span>
        <Button variant={next === null ? 'primary' : 'secondary'} disabled={d.asins.length === 0} onClick={() => void copy()}>
          {d.asins.length === 2 ? 'Copy both ASINs' : 'Copy ASINs'}
        </Button>
      </footer>
    </>
  );
}

/**
 * Nov 23: the estimate box of a bundle missing a price. No headline profit (a part with no price is never $0): how many
 * parts are priced, what they bring, the break-even, and each unpriced part with its state and the one action that moves
 * it forward. Every figure is the agent's, an estimate from the fee settings.
 */
function IncompleteEstimate({ d, i, look, lookBusy, lookError, searches, scanRunning }: {
  d: DealDetail; i: DealIncompleteEstimate; look: () => void; lookBusy: boolean; lookError: string | null; searches: number | null; scanRunning: boolean;
}) {
  const { navigate } = useApp();
  const ui = useUi();
  const lead = breakEvenWords(i);
  // Suggested prices (Nov 23): one click confirms the agent's suggestion; it counts only then (the PO's rule).
  const accept = useAction(api.confirmPrice);
  const notSold = useAction(api.markNotSold);
  const accepted = ifAcceptedLine(i);
  return (
    <>
      <p className="detail-incomplete-title">Incomplete estimate</p>
      <p className="detail-incomplete-lead">
        {pricedCount(i)}. {lead.charAt(0).toUpperCase() + lead.slice(1)}.
      </p>
      <dl className="detail-figures">
        <div>
          <dt>Bundle costs</dt>
          <dd>
            <Money value={i.cost} />
          </dd>
        </div>
        <div>
          <dt>Priced parts bring</dt>
          <dd>
            <Money value={i.pricedNet} />
          </dd>
        </div>
        <div>
          <dt>Still needed</dt>
          <dd>
            <Money value={i.breakEvenNet} />
          </dd>
        </div>
      </dl>
      <p className="detail-note">Both after fees. The rest has no price yet, so there is no estimated profit.</p>
      {accepted ? <p className="detail-note detail-if-accepted">{accepted}</p> : null}
      {i.soldAs ? <p className="detail-note">{i.soldAs}.</p> : null}
      <ul className="unpriced" aria-label="Parts with no price">
        {i.parts.map((p) => {
          const part = d.parts.find((x) => x.model === p.model) ?? null;
          const kit = kitWords(p);
          const s = p.priceSuggestion;
          const proof = s?.evidence.find((x) => x.url && !x.text.startsWith('Context:'))?.url ?? null;
          return (
            <li key={p.model} className="unpriced-part">
              <div className="unpriced-text">
                <span className="code">{p.model}</span>
                {p.qty > 1 ? <span className="fig muted"> ×{p.qty}</span> : null}
                <span className="unpriced-state">{UNPRICED_STATE[p.state]}</span>
                {kit ? <span className="detail-note">{kit}</span> : null}
                {s ? (
                  <span className="detail-note">
                    Suggested: {s.label}. {proof ? <SourceLink source={{ label: s.kind === 'ebay_median' ? 'eBay listing' : 'Amazon listing', url: proof }} /> : null}
                  </span>
                ) : null}
              </div>
              {p.action === 'confirm_price' && part && s ? (
                <div className="unpriced-actions">
                  <Button
                    size="sm" variant="primary" busy={accept.busy} busyLabel="Confirming…" disabled={scanRunning}
                    onClick={() => void accept.run(d.id, p.model, { kind: 'suggested', suggestion: { kind: s.kind, price: s.price } })}
                  >
                    {suggestionAction(s)}
                  </Button>
                  <LinkButton onClick={() => ui.openConfirmPrice({ dealId: d.id, part, questionId: d.questionId, focus: 'link' })}>Paste a link</LinkButton>
                  <LinkButton onClick={() => ui.openConfirmPrice({ dealId: d.id, part, questionId: d.questionId, focus: 'price' })}>Type a price</LinkButton>
                </div>
              ) : p.action === 'answer' && p.questionId ? (
                <Button size="sm" onClick={() => navigate({ screen: 'review', id: p.questionId })}>
                  {UNPRICED_ACTION.answer}
                </Button>
              ) : p.action === 'confirm_price' && part ? (
                <div className="unpriced-actions">
                  <Button size="sm" onClick={() => ui.openConfirmPrice({ dealId: d.id, part, questionId: d.questionId })}>
                    {UNPRICED_ACTION.confirm_price}
                  </Button>
                  {p.state === 'no_listing' ? (
                    // Answer once: "in the box, not sold separately" takes it out of the count in every bundle that holds it.
                    <LinkButton disabled={notSold.busy || scanRunning} onClick={() => void notSold.run(d.brand, p.model)}>Not sold separately</LinkButton>
                  ) : null}
                </div>
              ) : p.action === 'look_up' && d.lookup && searches !== null ? (
                <Button size="sm" busy={lookBusy} busyLabel="Looking up…" disabled={scanRunning} onClick={look} cost={plural(searches, 'search', 'searches')}>
                  {UNPRICED_ACTION.look_up}
                </Button>
              ) : p.action === 'look_up' ? (
                <span className="detail-note">Keepa looks it up as its tokens refill.</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {lookError ? <p role="alert" className="detail-note">{lookError}</p> : null}
      {accept.error ? <p role="alert" className="detail-note">{accept.error}</p> : null}
      {notSold.error ? <p role="alert" className="detail-note">{notSold.error}</p> : null}
      {i.notCounted.length ? (
        <p className="detail-note">Not counted: {i.notCounted.join(', ')}, with no model number. Confirm a price on the part to count it.</p>
      ) : null}
      <p className="detail-note">
        {i.basis} <LinkButton onClick={() => navigate({ screen: 'settings', id: 'fees' })}>Change</LinkButton>
      </p>
    </>
  );
}

/** Where each kind of evidence for the split came from, as a labelled link (every claim links its source). */
const EVIDENCE_LABEL: Record<NonNullable<DealDetail['splitEvidence']>[number]['kind'], string> = {
  hd_part_page: 'Home Depot part page',
  bogo_pair: 'Home Depot BOGO listing',
  page_quote: 'Home Depot bundle page',
  owner_fact: 'Your answer',
};

function Part({ part, dealId, brand, questionId, scanRunning }: { part: DealPart; dealId: string; brand: string; questionId: string | null; scanRunning: boolean }) {
  const verify = useAction(api.verify);
  const removePrice = useAction(api.removePrice);
  const forget = useAction(api.forgetFact);
  const keep = useAction(api.markNotSold);
  const ui = useUi();
  const menu = useMenu();
  const [said, setSaid] = useState<string | null>(null);
  const tone = part.grade === 'verified' ? 'verified' : part.grade === 'title_match' || part.grade === 'needs_answer' ? 'attention' : 'neutral';
  const label = part.unnamed ? (part.title ?? part.model) : part.model;
  const confirm = () => ui.openConfirmPrice({ dealId, part, questionId });
  // A form for the price opens unless an Amazon price already counts and he has none of his own to change.
  const canConfirm = part.confirm.state !== 'amazon-counts' || part.confirm.confirmed !== null;
  const remove = () => void removePrice.run(dealId, part.model);

  const openMenu = (e: React.MouseEvent | React.KeyboardEvent) =>
    menu.openFrom(e, {
      label,
      items: partMenu(part, { scanRunning }),
      onPick: (id) => {
        switch (id as PartMenuId) {
          case 'open-amazon':
            openPage(part.asin ? amazonUrl(part.asin) : amazonSearchUrl(brand, part.model));
            return;
          case 'copy-asin':
            if (part.asin) void copyText(part.asin).then((ok) => setSaid(ok ? `Copied ${part.asin}.` : 'Could not copy. Select the ASIN by hand.'));
            return;
          case 'confirm':
            confirm();
            return;
          case 'remove':
            remove();
            return;
        }
      },
    });

  return (
    <li
      className="part"
      data-menu-row=""
      onContextMenu={openMenu}
      onKeyDown={(e) => {
        if (isMenuKey({ key: e.key, shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey })) openMenu(e);
      }}
    >
      <div className="part-top">
        <div className="part-name">
          <span className={`part-model${part.unnamed ? '' : ' code'}`}>
            {part.unnamed ? part.title ?? part.model : part.model}
            {part.qty > 1 ? ` ×${part.qty}` : ''}
          </span>
          {!part.unnamed && part.title ? (
            <span className="part-title" title={part.title}>
              {part.title}
            </span>
          ) : null}
        </div>
        {part.price !== null ? (
          <div className="part-money">
            <Money value={part.price} className="part-price" />
            {part.net !== null ? <span className="part-net fig">nets {money(part.net)}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="part-tags">
        {part.unnamed ? (
          <>
            <Tag tone="neutral">No model number</Tag>
            <span className="muted">Not looked up on Amazon</span>
          </>
        ) : (
          <>
            <Tag tone={tone}>{PART_STATE_WORDS[part.grade]}</Tag>
            {part.asin ? (
              <a href={amazonUrl(part.asin)} target="_blank" rel="noopener noreferrer">
                <span className="code">{part.asin}</span> on Amazon
              </a>
            ) : (
              <a href={amazonSearchUrl(brand, part.model)} target="_blank" rel="noopener noreferrer">
                Search Amazon for <span className="code">{part.model}</span>
              </a>
            )}
          </>
        )}
        {part.grade === 'title_match' && part.asin ? (
          <Button size="sm" busy={verify.busy} busyLabel="Confirming…" disabled={scanRunning} onClick={() => void verify.run(dealId, part.model)} cost={plural(part.verifySearches ?? 1, 'search', 'searches')}>
            Confirm listing
          </Button>
        ) : null}
        {canConfirm ? (
          <Button size="sm" onClick={confirm} title="Count a price you have seen, with its link">
            {part.confirm.confirmed ? 'Change price…' : 'Confirm a price…'}
          </Button>
        ) : null}
      </div>
      {part.fact ? (
        // Answer once (Nov 23): what he settled about this model, applied in every bundle that holds it.
        <p className="detail-note part-fact">
          {part.fact.text} · {fromAnswer(part.fact.at)} ·{' '}
          <LinkButton disabled={forget.busy || scanRunning} onClick={() => void forget.run(`${brand}:${part.model}`, part.fact!.field)}>
            Change
          </LinkButton>
          {part.fact.stale ? (
            <>
              <br />
              <span role="status">{part.fact.stale} Your answer is not applied until you keep or change it.</span>{' '}
              <LinkButton disabled={keep.busy || scanRunning} onClick={() => void keep.run(brand, part.model)}>
                Keep my answer
              </LinkButton>
            </>
          ) : null}
        </p>
      ) : null}
      {forget.error ? <p role="alert">{forget.error}</p> : null}
      {keep.error ? <p role="alert">{keep.error}</p> : null}
      {verify.error ? <p role="alert">{verify.error}</p> : null}
      {removePrice.error ? <p role="alert">{removePrice.error}</p> : null}
      {said ? <p className="detail-note" role="status">{said}</p> : null}
      {part.prices.length ? (
        <>
          {/* What counts in the estimate is the line he reads; the reference prices (list price, Home Depot's own) fold under it. */}
          <ul className="prices">
            {part.prices.filter((l) => l.counted).map((line, i) => (
              <PriceRow key={i} line={line} onRemove={line.confirmed ? remove : undefined} removeBusy={removePrice.busy} removeDisabled={scanRunning} />
            ))}
          </ul>
          {part.prices.some((l) => !l.counted) ? (
            <Fold id={`other-prices-${dealId}-${part.model}`} title={part.prices.some((l) => l.counted) ? 'Other prices' : 'Prices'} aside="not counted" sub>
              <ul className="prices">
                {part.prices.filter((l) => !l.counted).map((line, i) => (
                  <PriceRow key={i} line={line} onRemove={line.confirmed ? remove : undefined} removeBusy={removePrice.busy} removeDisabled={scanRunning} />
                ))}
              </ul>
            </Fold>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

function PriceRow({ line, onRemove, removeBusy, removeDisabled }: { line: PriceLine; onRemove?: () => void; removeBusy?: boolean; removeDisabled?: boolean }) {
  return (
    <li className={`price${line.counted ? ' price-counted' : ''}`}>
      <span className="price-label">{line.label}</span>
      <span className="price-amount fig">{line.amount !== null ? money(line.amount) : line.range ? `${money(line.range.low)}–${money(line.range.high)}` : '—'}</span>
      <span className="price-note">
        {line.note ? line.note : null}
        {line.seenAt ? `${line.note ? ' · ' : ''}seen ${when(line.seenAt)}` : null}
        {line.sources.length ? (
          <>
            {line.note || line.seenAt ? ' · ' : ''}
            {line.sources.map((s, i) => (
              <Fragment key={i}>
                {i > 0 ? ' ' : ''}
                <SourceLink source={s}>{/^\d+$/.test(s.label) ? `Listing ${s.label}` : s.label}</SourceLink>
              </Fragment>
            ))}
          </>
        ) : null}
        {onRemove ? (
          <>
            {' · '}
            <button type="button" className="link-btn" disabled={removeBusy || removeDisabled} title={removeDisabled ? 'A scan is running. Remove the price when it has finished.' : undefined} onClick={onRemove}>
              Remove
            </button>
          </>
        ) : null}
      </span>
    </li>
  );
}
