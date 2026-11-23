// The tracking parts of the deal inspector (docs/design.md, Desktop app > Deal inspector): the watch button, the signals of
// the last scan, Amazon's FBA fee estimate beside the main one, the BOGO promotion, and the history chart. Each part says
// where its figures came from; every profit and ROI here is an estimate, and says so.

import { Fragment } from 'react';
import { api, useAction, useApp } from '../api/hooks';
import type { BogoGroup, BogoView, DealDetail, DealSignals, FbaEstimate } from '../api/types';
import { Button, LinkButton } from '../components/Button';
import { Profit, Roi } from '../components/Figure';
import { HistoryChart } from '../components/HistoryChart';
import { SourceLink } from '../components/Source';
import { Tag } from '../components/Tag';
import { useUi } from '../components/ui';
import { amazonUrl } from '../lib/actions';
import { money, plural, when } from '../lib/format';
import { verdictOf } from '../lib/signals';
import './DealTracking.css';

/** Watch or Unwatch, and Mark as BOGO while the deal is not one; under the title, where he reads what the bundle is. */
export function WatchBar({ d }: { d: DealDetail }) {
  const ui = useUi();
  const watched = d.watch?.watched === true;
  const toggle = useAction(api.watch);
  return (
    <div className="track-bar">
      <div className="track-buttons">
        <Button size="sm" glyph={watched ? 'star-fill' : 'star'} aria-pressed={watched} busy={toggle.busy} busyLabel={watched ? 'Stopping…' : 'Watching…'} onClick={() => void toggle.run(d.id, !watched)} title={watched ? 'Stop watching: scans stop judging this bundle' : 'Watch this bundle: every scan judges whether it is worth buying'}>
          {watched ? 'Unwatch' : 'Watch'}
        </Button>
        {d.bogo === null && d.bogoGroup === null ? (
          <Button size="sm" variant="quiet" onClick={() => ui.openBogo({ dealId: d.id, model: d.model, bogo: null })} title="Only for a promotion Home Depot lists no starter + free tool pairs for: you enter the free tool">
            Mark as BOGO…
          </Button>
        ) : null}
      </div>
      {watched ? (
        <p className="detail-note">
          {d.watch!.by === 'auto' ? 'Watched by itself: confirmed and discounted' : 'Watched by you'} since {when(d.watch!.since)}.
          {d.signals === null ? ' The next scan judges it.' : ''}
        </p>
      ) : d.watch ? (
        <p className="detail-note">Not watched. You stopped watching it {when(d.watch.since)}; scans leave it alone.</p>
      ) : null}
      {toggle.error ? <p role="alert">{toggle.error}</p> : null}
    </div>
  );
}

/** The last scan's verdict on a watched bundle: one sentence, then the figures it rests on. Estimates, labelled. */
export function SignalsSection({ signals }: { signals: DealSignals }) {
  const v = verdictOf(signals);
  return (
    <section className="detail-section" aria-labelledby="signals-title">
      <h3 className="detail-section-title" id="signals-title">
        Signals <span className="muted">· judged {when(signals.at)}</span>
      </h3>
      <div className="detail-box signals">
        <p className="signals-verdict">
          {v.buyNow ? <Tag tone="buy">Buy now</Tag> : null}
          <strong>{v.headline}</strong>
        </p>
        <p className="signals-sentence">{v.sentence}</p>
        {v.reasons.length > 0 ? (
          <dl className="signals-reasons">
            {v.reasons.map((r) => (
              <div key={r.label} className={r.tone === 'attention' ? 'signals-attention' : undefined}>
                <dt>{r.label}</dt>
                <dd>
                  {r.text}
                  {r.sub ? <span className="signals-sub"> {r.sub}</span> : null}
                  {r.asin ? (
                    <>
                      {' '}
                      <SourceLink source={{ label: `${r.asin.model} on Amazon`, url: amazonUrl(r.asin.asin) }} />
                    </>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <p className="detail-note">Estimates from your fee settings and Keepa’s monthly sales, as of the last scan. They change with the next one.</p>
      </div>
    </section>
  );
}

/** The FBA line in the estimate box: beside the main figure, labelled as Amazon's fee estimate from Keepa, never replacing it. */
export function FbaLine({ fba }: { fba: FbaEstimate }) {
  const keepa = fba.parts.filter((p) => p.source === 'keepa').length;
  return (
    <div className="fba" aria-label="FBA estimate">
      <div className="fba-row">
        <span className="fba-label">FBA estimate (Keepa)</span>
        <span className="fba-figures">
          <Profit value={fba.estimate.profit} />
          <Roi value={fba.estimate.roi} label />
        </span>
      </div>
      <p className="detail-note">
        {fba.label}, for {keepa} of {plural(fba.parts.length, 'part', 'parts')}: pick and pack only, in place of your flat fulfillment fee. It sits beside the estimate above and does not replace it. Still an estimate.
      </p>
    </div>
  );
}

/** The BOGO promotion he entered, the free tool he chose, and the estimate with its parts once they are priced. */
export function BogoSection({ d, bogo }: { d: DealDetail; bogo: BogoView }) {
  const ui = useUi();
  const remove = useAction(api.removeBogo);
  const choose = bogo.status === 'choose';
  const est = bogo.estimate;
  return (
    <section className="detail-section" aria-labelledby="bogo-title">
      <h3 className="detail-section-title" id="bogo-title">
        BOGO
        {bogo.eligible ? <span className="fig muted">{bogo.eligible.length} eligible</span> : null}
      </h3>
      <div className="detail-box bogo">
        <div className="bogo-top">
          <p className="bogo-label">{bogo.label}</p>
          <Button size="sm" variant={choose ? 'primary' : 'secondary'} onClick={() => ui.openBogo({ dealId: d.id, model: d.model, bogo })}>
            {choose ? 'Choose…' : 'Change…'}
          </Button>
        </div>
        {!choose && est ? (
          <>
            <div className="bogo-headline">
              <Profit value={est.profit} size="lg" />
              <Roi value={est.roi} label />
            </div>
            <p className="detail-note">Estimated profit with the free tool, at the same cost.</p>
          </>
        ) : null}
        {bogo.counted.length > 0 ? (
          <ul className="bogo-counted">
            {bogo.counted.map((c) => (
              <li key={c.model}>
                <span className="code">{c.model}</span>
                {c.qty > 1 ? ` ×${c.qty}` : ''}
                <span className="bogo-counted-money fig">
                  sells for {money(c.price)}, nets {money(c.net)}
                </span>
                {c.asin ? (
                  <>
                    {' '}
                    <SourceLink source={{ label: 'Amazon listing', url: amazonUrl(c.asin) }} />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {bogo.note ? <p className="bogo-note">{bogo.note}</p> : null}
        {bogo.chosen.length > 0 ? (
          <p className="detail-note">
            {bogo.chosen.map((c, i) => (
              <Fragment key={c.model}>
                {i > 0 ? ' · ' : ''}
                {c.link ? <SourceLink source={{ label: `${c.model} on Home Depot`, url: c.link }} /> : <span className="code">{c.model}</span>}
              </Fragment>
            ))}
            {bogo.link ? (
              <>
                {' · '}
                <SourceLink source={{ label: 'The promotion', url: bogo.link }} />
              </>
            ) : null}
          </p>
        ) : bogo.link ? (
          <p className="detail-note">
            <SourceLink source={{ label: 'The promotion on Home Depot', url: bogo.link }} />
          </p>
        ) : null}
        <p className="detail-note">You entered this promotion, the fallback for one Home Depot lists no starter + free tool pairs for. Profit and ROI are estimates from your fee settings.</p>
        <div className="bogo-foot">
          <Button size="sm" variant="danger" busy={remove.busy} busyLabel="Removing…" onClick={() => void remove.run(d.id)} title="This deal stops being a BOGO and the free tool is forgotten">
            Remove
          </Button>
          {remove.error ? <span role="alert">{remove.error}</span> : null}
        </div>
      </div>
    </section>
  );
}

/**
 * BOGO found by the agent: the starter's pairs from Home Depot's Featured BOGO listing, each the starter kit with one
 * free item at the kit's price, ranked by the pair's own estimate. Each links to its Home Depot page and opens its deal,
 * where its parts are. Estimates, labelled.
 */
export function BogoChoicesSection({ d, group }: { d: DealDetail; group: BogoGroup }) {
  const { navigate } = useApp();
  return (
    <section className="detail-section" aria-labelledby="bogo-choices-title">
      <h3 className="detail-section-title" id="bogo-choices-title">
        BOGO choices <span className="fig muted">{group.choices.length}</span>
      </h3>
      <div className="detail-box bogo">
        <p className="bogo-label">{group.label}</p>
        <p className="detail-note">
          Buy <SourceLink source={{ label: group.starterModel, url: group.starterLink }} /> and choose one free item
          {group.endsAt ? `; it ends ${new Date(`${group.endsAt}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}.{group.description ? ` Home Depot: “${group.description}”.` : ''}
        </p>
        <ol className="bogo-choices">
          {group.choices.map((c) => (
            <li key={c.key} className={c.key === d.id ? 'bogo-choice bogo-choice-this' : 'bogo-choice'}>
              <span className="bogo-choice-name">
                <span className="code">{c.freeModel}</span>
                {c.key === group.best?.key ? <Tag title="The best estimate of these choices">Best</Tag> : null}
              </span>
              <span className="bogo-choice-figures">
                {c.profit !== null ? (
                  <>
                    <Profit value={c.profit} />
                    {c.roi !== null ? <Roi value={c.roi} /> : null}
                  </>
                ) : (
                  <span className="muted">no estimate yet</span>
                )}
              </span>
              <span className="bogo-choice-links">
                <SourceLink source={{ label: c.model, url: c.link }} />
                {c.key === d.id ? <span className="muted">this deal</span> : <LinkButton onClick={() => navigate({ screen: 'deals', id: c.key })}>Parts</LinkButton>}
              </span>
            </li>
          ))}
        </ol>
        {group.waitingLookup > 0 ? (
          <p className="detail-note">
            {plural(group.waitingLookup, 'more choice', 'more choices')} waiting for a lookup. Each scan looks up a few, after your other bundles.
          </p>
        ) : null}
        <p className="detail-note">
          Found by the agent in Home Depot’s Featured BOGO listing: each choice is listed at the starter’s price ({money(group.choices[0]?.price ?? 0)}), so the free item is in its estimate. A free item may be a battery. Profit and ROI are estimates from your fee settings.
        </p>
      </div>
    </section>
  );
}

/** The stored scans, charted. Shown for a watched bundle and for any that has stored scans. */
export function HistorySection({ d }: { d: DealDetail }) {
  if (d.history.length === 0 && d.watch?.watched !== true) return null;
  return (
    <section className="detail-section" aria-labelledby="history-title">
      <h3 className="detail-section-title" id="history-title">
        History <span className="fig muted">{plural(d.history.length, 'scan', 'scans')}</span>
      </h3>
      <div className="detail-box">
        <HistoryChart history={d.history} />
      </div>
    </section>
  );
}
