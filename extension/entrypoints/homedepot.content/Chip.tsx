import { useLayoutEffect, useRef, useState } from 'react';
import { type ChipModel, searchesText, splitsInto } from './chipModel';

/** Said in the chip's own place when the side panel could not be opened from the page. */
export const COULD_NOT_OPEN = 'Open Split Finder from the toolbar to see this bundle.';

/**
 * The chip under a Home Depot price: one button that opens the side panel on This page (design.md,
 * "Chip on Home Depot product pages"). `open` asks the worker to open it and says whether it did.
 */
export function Chip({ model, open }: { model: ChipModel; open(): Promise<boolean> }) {
  const [couldNotOpen, setCouldNotOpen] = useState(false);
  const pending = useRef(false);
  const { fit, wrapRef, chipRef } = useFit(`${JSON.stringify(model)}|${couldNotOpen}`, couldNotOpen ? 0 : piecesToDrop(model));

  async function click() {
    if (pending.current) return;
    pending.current = true;
    setCouldNotOpen(false);
    let opened = false;
    try {
      opened = await open();
    } catch {
      // The worker did not answer: the same as a panel that would not open.
    }
    pending.current = false;
    setCouldNotOpen(!opened);
  }

  return (
    <div className="chip-wrap" ref={wrapRef}>
      <button type="button" className="chip" ref={chipRef} onClick={() => void click()}>
        <svg className="chip-mark" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 2.75h4.75a2.5 2.5 0 0 1 2.5 2.5v9.5a2.5 2.5 0 0 1-2.5 2.5H10z" fill="currentColor" />
        </svg>
        {couldNotOpen ? (
          // The sentence takes the chip's content, so the control keeps its 40px and the page's layout does not move.
          <span className="chip-title chip-sentence">{COULD_NOT_OPEN}</span>
        ) : (
          <>
            <Words model={model} fit={fit} />
            <svg className="chip-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4.5 2.5L8 6l-3.5 3.5" />
            </svg>
          </>
        )}
      </button>
      {/* Always rendered, so a screen reader hears the sentence when it appears; visually hidden. */}
      <p className="chip-status" role="status">
        {couldNotOpen ? COULD_NOT_OPEN : null}
      </p>
    </div>
  );
}

/**
 * How much of the chip's words have been dropped so that it fits its container: 0 none, then one more piece for each
 * step, the least important first. The chip is never wider than its container and stays one 40px control, so the owner
 * on a narrow window sees fewer words, never a clipped one. Measured in the browser: the widest the chip may be is its
 * wrapper's width, and a chip whose words overflow it (scrollWidth) steps up one level, before the page is painted.
 * Starts again at 0 when what the chip says changes and when its container's width does.
 */
function useFit(says: string, most: number) {
  const [fit, setFit] = useState({ says, width: -1, level: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  // A new message or a new width starts again from the full words, in this render, so no stale level is ever drawn.
  const [width, setWidth] = useState(-1);
  const level = fit.says === says && fit.width === width ? fit.level : 0;
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (wrap === null) return;
    // Read before the first paint, so the first thing drawn already fits.
    setWidth(Math.round(wrap.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => setWidth(Math.round(wrap.getBoundingClientRect().width)));
    watch.observe(wrap);
    return () => watch.disconnect();
  }, []);
  useLayoutEffect(() => {
    const chip = chipRef.current;
    if (chip === null) return;
    // Below the width at which even the fewest words fit, the chip clips (overflow: hidden) and is still no wider than its container.
    if (chip.scrollWidth > chip.clientWidth && level < most) setFit({ says, width, level: level + 1 });
  });
  return { fit: level, wrapRef, chipRef };
}

/** How many pieces of the chip's words can be dropped, the least important first, before only the last resort is left. */
function piecesToDrop(model: ChipModel): number {
  // estimate: the ROI, then the "Est. profit" label (the profit figure stays). lookup: "Look up prices", then the searches.
  return model.kind === 'estimate' || model.kind === 'lookup' ? 2 : 0;
}

/** The chip's words. Plain spaces between the parts keep the button's name readable to a screen reader. */
function Words({ model, fit }: { model: ChipModel; fit: number }) {
  switch (model.kind) {
    case 'estimate':
      return (
        <>
          <span className="chip-title">{splitsInto(model.parts)}</span>{' '}
          <span className="chip-rule" aria-hidden="true" />{' '}
          <span className="chip-figure-group">
            {fit < 2 ? <span className="chip-label">Est. profit</span> : null}{' '}
            <span className={`chip-profit figure${model.loss ? ' chip-profit--loss' : ''}`}>{model.profit}</span>
          </span>
          {fit < 1 ? (
            <>
              {' '}
              <span className={`chip-roi figure${model.loss ? ' chip-roi--loss' : ''}`}>ROI {model.roi}</span>
            </>
          ) : null}
        </>
      );
    case 'lookup':
      return (
        <>
          <span className="chip-title">{splitsInto(model.parts)}</span>
          {fit < 1 ? (
            <>
              {' '}
              <span className="chip-label">·</span> <span className="chip-label">Look up prices</span>
            </>
          ) : null}
          {fit < 2 ? (
            <>
              {' '}
              <span className="chip-label">·</span> <span className="chip-label">{searchesText(model.searches)}</span>
            </>
          ) : null}
        </>
      );
    case 'question':
      return (
        <>
          <span className="chip-title">{model.parts === null ? 'Which parts?' : splitsInto(model.parts)}</span>{' '}
          <span className="chip-label">·</span> <span className="chip-attention">needs your answer</span>
        </>
      );
    case 'plain':
      return <span className="chip-title">{splitsInto(model.parts)}</span>;
  }
}
