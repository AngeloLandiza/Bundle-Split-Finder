import { Fragment, useId, type ReactNode } from 'react';
import type { BundleRow, PaidAction, SaleOption } from '@core/scan/types';
import { profit, roi } from '../../lib/format';
import type { WorkerApi } from '../../lib/pageClient';
import { RANGE_MEANING, roiRangeText, waitingOf } from './dealsModel';
import { ConfirmSellPrice, SCAN_PRICE_LATER, unnamedPart } from './ConfirmPrice';
import { LookUp } from './DealsLookUp';

const escape = (m: string): string => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` with each of `models` set in the figure face: every model number is JetBrains Mono (docs/design.md). */
export function withModels(text: string, models: string[]): ReactNode {
  if (models.length === 0) return text;
  const pattern = new RegExp(`(${[...models].sort((x, y) => y.length - x.length).map(escape).join('|')})`);
  return text.split(pattern).map((piece, i) =>
    i % 2 === 1 ? (
      <span className="figure" key={i}>
        {piece}
      </span>
    ) : (
      <Fragment key={i}>{piece}</Fragment>
    ),
  );
}

/** "Leaves nothing", or "Leaves 11 parts: 18V Charger, Tool Bag". Models of the option are in the figure face; named parts stay in the body face. */
export function Leaves({ leftovers, models }: { leftovers: string[]; models: string[] }) {
  if (leftovers.length === 0) return <>Leaves nothing</>;
  return (
    <>
      Leaves {leftovers.length} {leftovers.length === 1 ? 'part' : 'parts'}:{' '}
      {leftovers.map((l, i) => (
        <Fragment key={i}>
          {i > 0 ? ', ' : ''}
          {withModels(l, models.filter((m) => l === m || l.startsWith(`${m} ×`)))}
        </Fragment>
      ))}
    </>
  );
}

/** "PCL1600K2's contents are not known yet: its Home Depot page has not been read." */
export function KitNotRead({ model }: { model: string }) {
  return (
    <>
      <span className="figure fig-sm">{model}</span>&apos;s contents are not known yet: its Home Depot page has not been read.
    </>
  );
}

interface Props {
  row: BundleRow;
  report: unknown;
  api: WorkerApi;
  scanRunning: boolean;
  version: number;
  busy: boolean;
  run: (action: PaidAction, button: HTMLButtonElement | null) => Promise<string | null>;
}

/** The first way that is not the one on screen, per leftover. The form lives there once, under that way's profit. */
function pricedOn(options: SaleOption[]): Map<string, string> {
  const primary = new Set((options[0]?.unnamed ?? []).map((item) => item.model));
  const owner = new Map<string, string>();
  for (const option of options) {
    for (const item of option.unnamed ?? []) {
      if (primary.has(item.model) || owner.has(item.model)) continue;
      owner.set(item.model, option.id);
    }
  }
  return owner;
}

function Way({ option, primary, kits, pricedOn: where, row, report, api, scanRunning, version, busy, run }: Props & { option: SaleOption; primary: boolean; kits: string[]; pricedOn: Map<string, string> }) {
  const e = option.estimate;
  const items = waitingOf(row.brand, option.parts);
  const labelId = useId();
  const range = roiRangeText(e, option.range);
  const mine = (option.unnamed ?? []).filter((item) => where.get(item.model) === option.id);
  const elsewhere = (option.unnamed ?? []).filter((item) => {
    const owner = where.get(item.model);
    return owner !== undefined && owner !== option.id;
  });
  return (
    <li className="detail-way">
      <div className="detail-part-top">
        <div className="detail-part-name">
          <div className="detail-way-label" id={labelId}>
            {withModels(option.label, kits)}
          </div>
        </div>
        <div className="detail-part-money" data-loss={e && e.profit < 0 ? 'true' : undefined}>
          {e ? (
            <>
              <div className="detail-part-price detail-way-profit">{profit(e.profit)}</div>
              <div className="detail-part-net">ROI {roi(e.roi)}</div>
              {range ? (
                <div className="detail-part-net detail-way-range" title={RANGE_MEANING}>
                  {range}
                </div>
              ) : null}
            </>
          ) : (
            <div className="detail-part-net detail-way-none">No estimate yet</div>
          )}
        </div>
      </div>
      {primary ? <div className="detail-way-shown">Shown above</div> : null}
      <p className="detail-way-line">
        <Leaves leftovers={option.leftovers} models={option.parts.map((p) => p.model)} />
      </p>
      {scanRunning && mine.length > 1 ? <p className="detail-confirm-why">{SCAN_PRICE_LATER}</p> : null}
      {mine.map((item) => (
        <div key={item.model} className="detail-way-unnamed">
          <div className="detail-part-model">
            {item.name}
            {item.qty > 1 ? ` ×${item.qty}` : ''}
          </div>
          <ConfirmSellPrice brand={row.brand} model={item.model} part={unnamedPart(item)} api={api} scanRunning={scanRunning} showFigure hideScanNote={scanRunning && mine.length > 1} />
        </div>
      ))}
      {elsewhere.map((item) => {
        const label = row.options.find((o) => o.id === where.get(item.model))?.label ?? '';
        const line = item.price !== null && e
          ? `${item.name} counts here: est. profit ${profit(e.profit)}. Entered on ${label}.`
          : `${item.name} is entered on ${label}.`;
        return (
          <p key={item.model} className="detail-confirm-why">
            {line}
          </p>
        );
      })}
      {items.length > 0 ? (
        <LookUp
          row={row} report={report} api={api} scanRunning={scanRunning} version={version} busy={busy} items={items} describedBy={labelId} stacked
          onRun={(parts, button) => run({ kind: 'lookUp', parts }, button)}
        />
      ) : null}
    </li>
  );
}

/** One block per way to sell, the primary first. Shown only when a bundle has more than one. */
export function WaysToSell(props: Props) {
  const id = useId();
  // Every kit the options name: the whole option's label names them too, though it splits none.
  const kits = [...new Set(props.row.options.flatMap((o) => o.splitKits))];
  const where = pricedOn(props.row.options);
  return (
    <section aria-labelledby={id} className="detail-ways">
      <h2 id={id} className="detail-label detail-ways-label">
        Ways to sell
      </h2>
      <ul className="detail-parts">
        {props.row.options.map((o, i) => (
          <Way key={o.id} option={o} primary={i === 0} kits={kits} pricedOn={where} {...props} />
        ))}
      </ul>
      <p className="detail-ways-note">Estimated profit and ROI for each way, from your fee settings.</p>
    </section>
  );
}
