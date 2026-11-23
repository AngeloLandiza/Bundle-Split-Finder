import { Fragment, useState } from 'react';
import { api, useAction, useApp, useResource } from '../api/hooks';
import type { DealDetail, DealPart, PriceLine } from '../api/types';
import { Button, LinkButton } from '../components/Button';
import { useMenu } from '../components/ContextMenu';
import { Money, Profit, Roi, RoiRangeLine } from '../components/Figure';
import { SourceLink } from '../components/Source';
import { LoadError, LoadingState, Notice } from '../components/States';
import { Tag } from '../components/Tag';
import { useUi } from '../components/ui';
import { amazonSearchUrl, amazonUrl, copyText, openPage } from '../lib/actions';
import { money, percentOff, plural, when } from '../lib/format';
import { isMenuKey } from '../lib/keys';
import { partMenu, type PartMenuId } from '../lib/menus';
import { BogoChoicesSection, BogoSection, FbaLine, HistorySection, SignalsSection, WatchBar } from './DealTracking';
import { GRADE_LABEL } from './reviewModel';
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
  // The free quote, asked again when the agent's state changes: what a Look up would spend now (the row's figure may be older).
  const [quote] = useResource(() => (d.lookup ? api.lookupQuote(d.id) : Promise.resolve(null)), [d.id, d.lookup !== null], ['deals']);
  const searches = quote.data ?? d.lookup?.searches ?? null;
  const scanRunning = state?.agent.status === 'scanning';
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

        {d.signals ? <SignalsSection signals={d.signals} /> : null}

        <section className="detail-box" aria-label="Estimate">
          {e ? (
            <>
              <div className="detail-headline">
                <Profit value={e.profit} size="xl" />
                <span className="detail-roi">
                  <Roi value={e.roi} label />
                </span>
              </div>
              <p className="detail-estimate">Estimated profit</p>
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
                <p className="detail-note">
                  Counts{' '}
                  {e.countedAtZero.map((m, i) => (
                    <Fragment key={m}>
                      {i === 0 ? '' : i === e.countedAtZero.length - 1 ? ' and ' : ', '}
                      <span className="code">{m}</span>
                    </Fragment>
                  ))}{' '}
                  at $0: no priced Amazon listing is chosen.
                </p>
              ) : null}
              {d.fbaEstimate ? <FbaLine fba={d.fbaEstimate} /> : null}
            </>
          ) : (
            <>
              <p className="detail-none">{d.noEstimate}</p>
              {d.lookup && searches !== null ? (
                <div className="detail-row">
                  <Button variant="primary" busy={look.busy} busyLabel="Looking up…" disabled={scanRunning} onClick={() => void look.run(d.id)} cost={plural(searches, 'search', 'searches')}>
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
              <Button size="sm" onClick={() => navigate({ screen: 'review', id: d.questionId })}>
                Answer in Review
              </Button>
            }
          >
            Its estimate waits for one question.
          </Notice>
        ) : null}

        {d.bogoGroup ? <BogoChoicesSection d={d} group={d.bogoGroup} /> : null}
        {d.bogo ? <BogoSection d={d} bogo={d.bogo} /> : null}

        <HistorySection d={d} />

        {d.ways.length > 1 ? (
          <section className="detail-section">
            <h3 className="detail-section-title">
              Ways to sell <span className="fig muted">{d.ways.length}</span>
            </h3>
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
                    ) : (
                      <span className="detail-note">No estimate yet</span>
                    )}
                  </div>
                  <p className="detail-note">
                    {w.primary ? 'Shown above. ' : ''}
                    {w.leaves.length ? `Leaves ${plural(w.leaves.length, 'part', 'parts')}: ${w.leaves.join(', ')}` : 'Leaves nothing'}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {d.parts.length ? (
          <section className="detail-section">
            <h3 className="detail-section-title">
              Parts <span className="fig muted">{d.parts.length}</span>
            </h3>
            {d.splitEvidence?.length ? (
              <div className="split-evidence">
                <h4 className="detail-subtitle">How we know what is inside</h4>
                <ul className="evidence-list">
                  {d.splitEvidence.map((e, i) => (
                    <li key={i}>
                      <span className="evidence-text">{e.text}</span> <SourceLink source={{ label: EVIDENCE_LABEL[e.kind], url: e.url ?? null }} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ul className="detail-list">
              {d.parts.map((p) => (
                <Part key={p.model} part={p} dealId={d.id} brand={d.brand} questionId={d.questionId} scanRunning={scanRunning} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <footer className="detail-foot">
        <span role="status" className="detail-note">
          {copied ?? (d.asins.length ? plural(d.asins.length, 'ASIN', 'ASINs') : 'No ASIN chosen yet')}
        </span>
        <Button variant="primary" disabled={d.asins.length === 0} onClick={() => void copy()}>
          {d.asins.length === 2 ? 'Copy both ASINs' : 'Copy ASINs'}
        </Button>
      </footer>
    </>
  );
}

/** Where each kind of evidence for the split came from, as a labelled link (every claim links its source). */
const EVIDENCE_LABEL: Record<NonNullable<DealDetail['splitEvidence']>[number]['kind'], string> = {
  hd_part_page: 'Home Depot part page',
  bogo_pair: 'Home Depot BOGO listing',
  page_quote: 'Home Depot bundle page',
};

function Part({ part, dealId, brand, questionId, scanRunning }: { part: DealPart; dealId: string; brand: string; questionId: string | null; scanRunning: boolean }) {
  const verify = useAction(api.verify);
  const removePrice = useAction(api.removePrice);
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
            <Tag tone={tone}>{GRADE_LABEL[part.grade]}</Tag>
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
          <Button size="sm" busy={verify.busy} busyLabel="Verifying…" disabled={scanRunning} onClick={() => void verify.run(dealId, part.model)} cost={plural(part.verifySearches ?? 1, 'search', 'searches')}>
            Verify
          </Button>
        ) : null}
        {canConfirm ? (
          <Button size="sm" onClick={confirm} title="Count a price you have seen, with its link">
            {part.confirm.confirmed ? 'Change price…' : 'Confirm a price…'}
          </Button>
        ) : null}
      </div>
      {verify.error ? <p role="alert">{verify.error}</p> : null}
      {removePrice.error ? <p role="alert">{removePrice.error}</p> : null}
      {said ? <p className="detail-note" role="status">{said}</p> : null}
      {part.prices.length ? (
        <ul className="prices">
          {part.prices.map((line, i) => (
            <PriceRow key={i} line={line} onRemove={line.confirmed ? remove : undefined} removeBusy={removePrice.busy} removeDisabled={scanRunning} />
          ))}
        </ul>
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
