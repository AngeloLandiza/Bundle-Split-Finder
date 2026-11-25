import { useProfitNote } from '../api/hooks';
import type { RoiRange } from '../api/types';
import { money, profit, roi, roiRange } from '../lib/format';
import { beforeFulfillmentTip } from '../lib/order';
import { Tag } from './Tag';
import './Figure.css';

/** A dollar amount in the figure face. */
export function Money({ value, className }: { value: number | null | undefined; className?: string }) {
  if (value === null || value === undefined) return <span className={`fig muted ${className ?? ''}`}>—</span>;
  return <span className={`fig ${value < 0 ? 'loss ' : ''}${className ?? ''}`}>{money(value)}</span>;
}

/** Estimated profit: +$118.40, or −$12.50 in the loss colour. */
export function Profit({ value, size = 'md' }: { value: number; size?: 'md' | 'lg' | 'xl' }) {
  return <span className={`fig figure-profit figure-${size}${value < 0 ? ' loss' : ''}`}>{profit(value)}</span>;
}

/**
 * A row's estimated profit. When the estimate leaves out Amazon's fulfillment fee for some parts it is shown in the secondary
 * colour (never green, never the loss red) with a neutral "before fulfillment" tag beside it: said in words, not by colour.
 */
export function RowProfit({ value, before }: { value: number; before?: { parts: number; of: number } | null }) {
  // While his sales tax or inbound shipping is unanswered the estimate says what it leaves out (core/src/estimateNote.ts).
  const note = useProfitNote();
  const noteTag = note ? <Tag title={`Estimated profit ${note}: set them in Settings, Scanning.`}>{note}</Tag> : null;
  if (!before || before.parts <= 0) {
    return noteTag ? (
      <span className="figure-before">
        <Profit value={value} />
        {noteTag}
      </span>
    ) : (
      <Profit value={value} />
    );
  }
  const tip = beforeFulfillmentTip(before);
  return (
    <span className="figure-before" title={tip}>
      <span className="fig figure-profit figure-md figure-quiet">{profit(value)}</span>
      <Tag title={tip}>before fulfillment</Tag>
      {noteTag}
    </span>
  );
}

/** A line under a headline profit while sales tax or inbound shipping is unanswered; nothing once both are. */
export function ProfitQualifier({ note }: { note?: string | null }) {
  const own = useProfitNote();
  const text = note === undefined ? own : note;
  return text ? <p className="figure-estimate">Estimated profit {text}.</p> : null;
}

/** ROI as a whole percent. */
export function Roi({ value, label = false }: { value: number; label?: boolean }) {
  return (
    <span className={`fig figure-roi${value < 0 ? ' loss' : ''}`}>
      {label ? 'ROI ' : ''}
      {roi(value)}
    </span>
  );
}

/** "ROI −6% to +12%", only when the two ends read differently. */
export function RoiRangeLine({ range, bare = false }: { range: RoiRange | null | undefined; bare?: boolean }) {
  const text = roiRange(range);
  if (!text) return null;
  // Under a column headed ROI the word is not repeated; the hover text still says it in full.
  return (
    <span className="fig figure-range" title={`${text}: lowest and highest ROI across the prices each part sells for.`}>
      {bare ? text.replace(/^ROI /, '') : text}
    </span>
  );
}

/** Says out loud that a figure is an estimate (rule 5). */
export function EstimateNote({ children }: { children?: React.ReactNode }) {
  return <p className="figure-estimate">{children ?? 'Profit and ROI are estimates from your fee settings, not your real Amazon fees.'}</p>;
}
