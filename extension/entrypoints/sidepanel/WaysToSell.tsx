import { useId } from 'react';
import type { BundleRow, PaidAction, SaleOption } from '@core/scan/types';
import { profit, roi } from '../../lib/format';
import type { WorkerApi } from '../../lib/pageClient';
import { waitingOf } from './dealsModel';
import { LookUp } from './DealsLookUp';

export const LOOSE_ITEMS_NOTE = 'Items from a kit have no retail box of their own.';

/** "Leaves nothing", or "Leaves 11 items: 18V Charger, Tool Bag". */
export function leavesText(leftovers: string[]): string {
  if (leftovers.length === 0) return 'Leaves nothing';
  return `Leaves ${leftovers.length} ${leftovers.length === 1 ? 'item' : 'items'}: ${leftovers.join(', ')}`;
}

/** "PCL1600K2's contents are not known yet: its Home Depot page has not been read." */
export const notReadText = (model: string): string => `${model}'s contents are not known yet: its Home Depot page has not been read.`;

interface Props {
  row: BundleRow;
  report: unknown;
  api: WorkerApi;
  scanRunning: boolean;
  version: number;
  busy: boolean;
  run: (action: PaidAction, button: HTMLButtonElement | null) => Promise<string | null>;
}

function Way({ option, primary, row, report, api, scanRunning, version, busy, run }: Props & { option: SaleOption; primary: boolean }) {
  const e = option.estimate;
  const items = waitingOf(row.brand, option.parts);
  return (
    <li className="detail-way">
      <div className="detail-part-top">
        <div className="detail-part-name">
          <div className="detail-way-label">{option.label}</div>
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
      <p className="detail-way-line">{leavesText(option.leftovers)}</p>
      {option.loose ? <p className="detail-way-line">{LOOSE_ITEMS_NOTE}</p> : null}
      {items.length > 0 ? (
        <LookUp row={row} report={report} api={api} scanRunning={scanRunning} version={version} busy={busy} items={items} onRun={(parts, button) => run({ kind: 'lookUp', parts }, button)} />
      ) : null}
    </li>
  );
}

/** One block per way to sell, the primary first. Shown only when a bundle has more than one. */
export function WaysToSell(props: Props) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="detail-ways">
      <h2 id={id} className="detail-label detail-ways-label">
        Ways to sell
      </h2>
      <ul className="detail-parts">
        {props.row.options.map((o, i) => (
          <Way key={o.id} option={o} primary={i === 0} {...props} />
        ))}
      </ul>
      <p className="detail-ways-note">Estimated profit and ROI for each way, from your fee settings.</p>
    </section>
  );
}
