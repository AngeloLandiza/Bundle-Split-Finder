import type { OptionMarket, PartMarket } from '../api/types';
import { Profit } from '../components/Figure';
import { Fold } from '../components/Fold';
import { SourceLink } from '../components/Source';
import { amazonUrl } from '../lib/actions';
import { money, when } from '../lib/format';
import { marketAside, marketDealNotes } from '../lib/market';

/**
 * The market around each counted part's listing (Nov 25, core/src/tracking/market.ts), under the parts: today's price
 * against its 30-, 90- and 180-day averages with when Keepa read them, and the notes (Amazon sells it, sellers, stock,
 * hazards). When a part is unusually priced, the deal's second estimate at its usual prices sits first. Every figure is
 * Keepa's, from the stored pull; the estimates are from the fee settings.
 */
export function MarketSection({ market }: { market: OptionMarket }) {
  const deal = marketDealNotes(market);
  const u = market.usual;
  return (
    <Fold id="market" title="Market" aside={marketAside(market)} defaultOpen={u !== null && !u.meets}>
      {u ? (
        <div className="market-usual" aria-label="Estimate at the usual prices">
          <div className="market-usual-row">
            <span className="market-usual-label">At its usual prices</span>
            <span className="fba-figures">
              <Profit value={u.profit} />
              <span className="fig">{Math.round(u.roiPercent)}% ROI</span>
            </span>
          </div>
          <p className="detail-note">
            {u.parts.map((p, i) => `${i > 0 ? (i === u.parts.length - 1 ? ' and ' : ', ') : ''}${p.model} at its 90-day average of ${money(p.usual)} (today ${money(p.price)})`).join('')}
            , the same fees. {u.meets ? 'It clears your numbers at these prices too.' : 'Below your numbers at these prices, so it is not marked Buy now.'} An estimate from your fee settings.
          </p>
        </div>
      ) : null}
      {deal.map((t) => (
        <p key={t} className="detail-note">
          {t}
        </p>
      ))}
      <ul className="detail-list">
        {market.parts.map((p) => (
          <MarketPart key={p.model} p={p} />
        ))}
      </ul>
      <p className="detail-note">New prices on Amazon, from Keepa’s record of each listing. The averages are the lowest New offer’s, else Amazon’s own.</p>
    </Fold>
  );
}

function MarketPart({ p }: { p: PartMarket }) {
  const avg = (label: string, v: number | null) => (
    <div>
      <dt>{label}</dt>
      <dd className="fig">{v === null ? '—' : money(v)}</dd>
    </div>
  );
  return (
    <li className="part">
      <div className="part-top">
        <span className="part-model code">{p.model}</span>
        <span className="detail-note">
          Keepa, {when(p.at)} · <SourceLink source={{ label: 'Amazon listing', url: amazonUrl(p.asin) }} />
        </span>
      </div>
      <dl className="detail-figures market-figures">
        <div>
          <dt>Counted</dt>
          <dd className={p.unusual ? 'fig attention-text' : 'fig'}>{money(p.price)}</dd>
        </div>
        {avg('30 days', p.avg30)}
        {avg('90 days', p.avg90)}
        {avg('180 days', p.avg180)}
      </dl>
      {p.notes.map((n) => (
        <p key={n} className="detail-note">
          {n}
        </p>
      ))}
    </li>
  );
}
