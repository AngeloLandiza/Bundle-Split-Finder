import type { ReactNode } from 'react';
import { Figurized } from './Button';
import { EmptyState } from './States';
import type { ScoreLine, Scorecard } from '../lib/scorecard';
import './Scorecard.css';

/**
 * Today's scorecard (docs/design.md, Desktop app > Scorecard): the three numbers that decide whether the estimates can be trusted, as
 * rows of one grouped box, and everything else behind one disclosure. A figure with no record behind it is not drawn; with no
 * purchases the box says so and what to do. Presentational: Today's block fetches and passes the model.
 */
export function ScorecardRows({ card, action }: { card: Scorecard; action?: ReactNode }) {
  return (
    <>
      {card.recorded.kind === 'empty' ? (
        <EmptyState compact title={card.recorded.title} cause={card.recorded.cause} action={action} />
      ) : (
        <dl className="score">
          {card.recorded.lines.map((l) => (
            <Line key={l.id} line={l} />
          ))}
        </dl>
      )}
      {card.details.length > 0 ? (
        <details className="score-more">
          <summary>More detail</summary>
          <dl className="score">
            {card.details.map((l) => (
              <Line key={l.id} line={l} />
            ))}
          </dl>
        </details>
      ) : null}
    </>
  );
}

function Line({ line }: { line: ScoreLine }) {
  return (
    <div className="score-line">
      <dt>{line.label}</dt>
      <dd>
        <span className="score-value">
          <Figurized text={line.value} />
        </span>
        {line.sub.map((s, i) => (
          <span className="score-sub" key={i}>
            <Figurized text={s} />
          </span>
        ))}
      </dd>
    </div>
  );
}
