import { Fragment, useState } from 'react';
import { api, useAction, useApp, useResource } from '../api/hooks';
import type { DealDetail, DealPart, PriceLine } from '../api/types';
import { Button } from '../components/Button';
import { Money, Profit, Roi, RoiRangeLine } from '../components/Figure';
import { PaneClose } from '../components/Layout';
import { SourceLink, webUrl } from '../components/Source';
import { LoadError, Notice, SkeletonRows } from '../components/States';
import { Tag } from '../components/Tag';
import { money, percentOff, plural, when } from '../lib/format';
import { GRADE_LABEL } from './reviewModel';
import './DealDetail.css';

/** One bundle, in the pane beside the Deals table. */
export function DealDetailPane({ id, onClose }: { id: string; onClose: () => void }) {
  const [res, reload] = useResource(() => api.deal(id), [id], ['deals']);
  const d = res.data;
  return (
    <div className="detail">
      <div className="detail-top">
        <PaneClose onClose={onClose} />
        {d?.link ? (
          <a className="detail-hd" href={webUrl(d.link) ?? undefined} target="_blank" rel="noopener noreferrer">
            Open on Home Depot
          </a>
        ) : null}
      </div>
      {res.status === 'loading' ? <SkeletonRows rows={6} columns={2} label="Loading the bundle" /> : null}
      {res.status === 'error' && !d ? (
        <div className="detail-pad">
          <LoadError error={res.error} onRetry={reload} />
        </div>
      ) : null}
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
          <p className="caps">{d.brand}</p>
          <h2 className="detail-title">{d.title}</h2>
          <p className="detail-meta">
            <span className="fig">{d.model}</span>
            {d.price !== null ? (
              <>
                {' · '}
                <span className="fig">{money(d.price)}</span>
              </>
            ) : null}
            {percentOff(d.off) ? ` · ${percentOff(d.off)}` : ''}
            {' · '}
            <SourceLink source={{ label: 'Home Depot', url: d.link }} />
            {d.seenAt ? `, price seen ${when(d.seenAt)}` : ''}
          </p>
        </header>

        <section className="detail-band" aria-label="Estimate">
          {e ? (
            <>
              <div className="detail-headline">
                <Profit value={e.profit} size="xl" />
                <span className="detail-roi">
                  <Roi value={e.roi} label />
                </span>
              </div>
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
                {e.basis}{' '}
                <a
                  href="#/settings/fees"
                  onClick={(ev) => {
                    ev.preventDefault();
                    navigate({ screen: 'settings', id: 'fees' });
                  }}
                >
                  Change
                </a>
              </p>
              <RoiRangeLine range={e.roiRange} />
              {e.countedAtZero.length ? (
                <p className="detail-note">
                  Counts{' '}
                  {e.countedAtZero.map((m, i) => (
                    <Fragment key={m}>
                      {i === 0 ? '' : i === e.countedAtZero.length - 1 ? ' and ' : ', '}
                      <span className="fig">{m}</span>
                    </Fragment>
                  ))}{' '}
                  at $0: no priced Amazon listing is chosen.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p className="detail-none">{d.noEstimate}</p>
              {d.lookup && searches !== null ? (
                <div className="detail-row">
                  <Button
                    variant="primary"
                    busy={look.busy}
                    busyLabel="Looking up…"
                    disabled={scanRunning}
                    onClick={() => void look.run(d.id)}
                    cost={plural(searches, 'search', 'searches')}
                  >
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

        {d.ways.length > 1 ? (
          <section className="detail-section">
            <h3 className="caps">
              Ways to sell · <span className="fig">{d.ways.length}</span>
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
            <h3 className="caps">
              Parts · <span className="fig">{d.parts.length}</span>
            </h3>
            <ul className="detail-list">
              {d.parts.map((p) => (
                <Part key={p.model} part={p} dealId={d.id} brand={d.brand} scanRunning={scanRunning} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <footer className="detail-foot">
        <Button variant="primary" disabled={d.asins.length === 0} onClick={() => void copy()}>
          {d.asins.length === 2 ? 'Copy both ASINs' : 'Copy ASINs'}
        </Button>
        <span role="status" className="detail-note">
          {copied ?? ''}
        </span>
      </footer>
    </>
  );
}

function Part({ part, dealId, brand, scanRunning }: { part: DealPart; dealId: string; brand: string; scanRunning: boolean }) {
  const verify = useAction(api.verify);
  const search = `https://www.amazon.com/s?k=${encodeURIComponent(`${brand} ${part.model}`)}`;
  const tone = part.grade === 'verified' ? 'verified' : part.grade === 'title_match' || part.grade === 'needs_answer' ? 'attention' : 'neutral';
  return (
    <li className="part">
      <div className="part-top">
        <div className="part-name">
          <span className="part-model fig">
            {part.model}
            {part.qty > 1 ? ` ×${part.qty}` : ''}
          </span>
          {part.title ? (
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
        {part.asin ? (
          <a href={`https://www.amazon.com/dp/${part.asin}`} target="_blank" rel="noopener noreferrer">
            <span className="fig">{part.asin}</span> on Amazon
          </a>
        ) : (
          <a href={search} target="_blank" rel="noopener noreferrer">
            Search Amazon for <span className="fig">{part.model}</span>
          </a>
        )}
        <Tag tone={tone}>{GRADE_LABEL[part.grade]}</Tag>
        {part.grade === 'title_match' && part.asin ? (
          <Button
            size="sm"
            busy={verify.busy}
            busyLabel="Verifying…"
            disabled={scanRunning}
            onClick={() => void verify.run(dealId, part.model)}
            cost={plural(part.verifySearches ?? 1, 'search', 'searches')}
          >
            Verify
          </Button>
        ) : null}
      </div>
      {verify.error ? <p role="alert">{verify.error}</p> : null}
      {part.prices.length ? (
        <ul className="prices">
          {part.prices.map((line, i) => (
            <PriceRow key={i} line={line} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function PriceRow({ line }: { line: PriceLine }) {
  return (
    <li className={`price${line.counted ? ' price-counted' : ''}`}>
      <span className="price-label">{line.label}</span>
      <span className="price-amount fig">
        {line.amount !== null ? money(line.amount) : line.range ? `${money(line.range.low)}–${money(line.range.high)}` : '—'}
      </span>
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
      </span>
    </li>
  );
}
