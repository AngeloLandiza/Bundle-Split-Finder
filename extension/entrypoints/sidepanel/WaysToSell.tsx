import { Fragment, useId, type ReactNode } from 'react';
import type { BundleRow, PaidAction, SaleOption } from '@core/scan/types';
import { profit, roi } from '../../lib/format';
import type { WorkerApi } from '../../lib/pageClient';
import { waitingOf } from './dealsModel';
import { LookUp } from './DealsLookUp';

export const LOOSE_PARTS_NOTE = 'Parts from a kit have no retail box of their own.';

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

function Way({ option, primary, kits, row, report, api, scanRunning, version, busy, run }: Props & { option: SaleOption; primary: boolean; kits: string[] }) {
  const e = option.estimate;
  const items = waitingOf(row.brand, option.parts);
  const labelId = useId();
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
      {option.loose ? <p className="detail-way-line">{LOOSE_PARTS_NOTE}</p> : null}
      {items.length > 0 ? (
        <LookUp row={row} report={report} api={api} scanRunning={scanRunning} version={version} busy={busy} items={items} describedBy={labelId} onRun={(parts, button) => run({ kind: 'lookUp', parts }, button)} />
      ) : null}
    </li>
  );
}

/** One block per way to sell, the primary first. Shown only when a bundle has more than one. */
export function WaysToSell(props: Props) {
  const id = useId();
  // Every kit the options name: the whole option's label names them too, though it splits none.
  const kits = [...new Set(props.row.options.flatMap((o) => o.splitKits))];
  return (
    <section aria-labelledby={id} className="detail-ways">
      <h2 id={id} className="detail-label detail-ways-label">
        Ways to sell
      </h2>
      <ul className="detail-parts">
        {props.row.options.map((o, i) => (
          <Way key={o.id} option={o} primary={i === 0} kits={kits} {...props} />
        ))}
      </ul>
      <p className="detail-ways-note">Estimated profit and ROI for each way, from your fee settings.</p>
    </section>
  );
}
