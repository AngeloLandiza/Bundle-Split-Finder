import { useRef, useState } from 'react';
import { type ChipModel, searchesText, splitsInto } from './chipModel';

/** Said under the chip when the side panel could not be opened from the page. */
export const COULD_NOT_OPEN = 'Open Split Finder from the toolbar to see this bundle.';

/**
 * The chip under a Home Depot price: one button that opens the side panel on This page (design.md,
 * "Chip on Home Depot product pages"). `open` asks the worker to open it and says whether it did.
 */
export function Chip({ model, open }: { model: ChipModel; open(): Promise<boolean> }) {
  const [couldNotOpen, setCouldNotOpen] = useState(false);
  const pending = useRef(false);

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
    <div className="chip-wrap">
      <button type="button" className="chip" onClick={() => void click()}>
        <svg className="chip-mark" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 2.75h4.75a2.5 2.5 0 0 1 2.5 2.5v9.5a2.5 2.5 0 0 1-2.5 2.5H10z" fill="currentColor" />
        </svg>
        <Words model={model} />
        <svg className="chip-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4.5 2.5L8 6l-3.5 3.5" />
        </svg>
      </button>
      <p className="chip-note" role="status">
        {couldNotOpen ? COULD_NOT_OPEN : null}
      </p>
    </div>
  );
}

/** The chip's words. Plain spaces between the parts keep the button's name readable to a screen reader. */
function Words({ model }: { model: ChipModel }) {
  switch (model.kind) {
    case 'estimate':
      return (
        <>
          <span className="chip-title">{splitsInto(model.parts)}</span>{' '}
          <span className="chip-rule" aria-hidden="true" />{' '}
          <span className="chip-figure-group">
            <span className="chip-label">Est. profit</span>{' '}
            <span className={`chip-profit figure${model.loss ? ' chip-profit--loss' : ''}`}>{model.profit}</span>
          </span>{' '}
          <span className="chip-roi figure">ROI {model.roi}</span>
        </>
      );
    case 'lookup':
      return (
        <>
          <span className="chip-title">{splitsInto(model.parts)}</span> <span className="chip-label">·</span>{' '}
          <span className="chip-label">Look up prices</span> <span className="chip-label">·</span>{' '}
          <span className="chip-label">{searchesText(model.searches)}</span>
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
