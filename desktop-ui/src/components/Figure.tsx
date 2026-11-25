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
  // What the estimates leave out while sales tax or inbound shipping is unanswered is said once per screen (estimateWords
  // under the list, ProfitQualifier under a headline profit), not as a tag on every row.
  if (!before || before.parts <= 0) return <Profit value={value} />;
  const tip = beforeFulfillmentTip(before);
  return (
    <span className="figure-before" title={tip}>
      <span className="fig figure-profit figure-md figure-quiet">{profit(value)}</span>
      <Tag title={tip}>before fulfillment</Tag>
    </span>
  );
}

/**
 * The sentence under a list of estimates (rule 5). While sales tax or inbound shipping is unanswered it says what the
 * estimates leave out, in the words every other surface uses (`note` is core's profitQualifier, from the agent's state).
 */
export function estimateWords(note: string | null): string {
  return note
    ? `Profit and ROI are estimates from your fee settings, ${note}, not your real Amazon fees.`
    : 'Profit and ROI are estimates from your fee settings, not your real Amazon fees.';
}

export function useEstimateWords(): string {
  return estimateWords(useProfitNote());
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
  const words = useEstimateWords();
  return <p className="figure-estimate">{children ?? words}</p>;
}
