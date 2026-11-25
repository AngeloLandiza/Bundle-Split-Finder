import { useEffect, useMemo, useRef, useState } from 'react';
import type { CostsView } from '../api/types';
import { chartSummary, costChart, dayLabel, dayOf, dayReadout, isBudgeted, nearestPoint } from '../lib/costs';
import { money } from '../lib/format';
import './CostChart.css';

const HEIGHT = 232;

/**
 * Dollars this month (docs/design.md, Desktop app > Costs): the days so far as a solid line, from today to the month's end the
 * forecast as a dashed line with its low-to-high range as a flat tint, the total budget as a rule, today marked. Hand-drawn SVG
 * sized to its box; the ends are labelled in dollars so nothing needs hover. Hover or the arrow keys read one day by service.
 * The geometry is lib/costs.ts costChart; this only draws it. The picture has a text alternative with the three figures.
 */
export function CostChart({ view }: { view: CostsView }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setWidth(Math.max(280, Math.round(el.getBoundingClientRect().width)));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const g = useMemo(() => costChart(view, { width, height: HEIGHT, margin: { top: 22, right: width < 460 ? 62 : 78, bottom: 24, left: 46 } }), [view, width]);
  if (!g) return <p className="cc-empty">Nothing has been counted yet this month. The first day appears here once the agent has used a service or a price is entered.</p>;

  const n = g.points.length;
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(nearestPoint(g, g.box.margin.left + (e.clientX - r.left)));
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (step !== 0) {
      e.preventDefault();
      setHover((cur) => (cur === null ? n - 1 : Math.max(0, Math.min(n - 1, cur + step))));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setHover(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Escape' && hover !== null) {
      e.preventDefault();
      setHover(null);
    }
  };

  const day = hover === null ? null : [...view.days].sort((a, b) => a.date.localeCompare(b.date))[hover];
  const point = hover === null ? null : g.points[hover]!;
  const tipLeft = point ? point.x : 0;
  const flip = tipLeft + 210 > width;
  const baseline = g.y(0);

  return (
    <figure className="cc">
      <ul className="cc-legend" aria-label="Key">
        <li>
          <span className="cc-key cc-key-line" aria-hidden="true" />
          So far
        </li>
        {g.dashed ? (
          <li>
            <span className="cc-key cc-key-dash" aria-hidden="true" />
            Forecast{g.band ? ', its range shaded' : ''}
          </li>
        ) : null}
        {g.budget ? (
          <li>
            <span className="cc-key cc-key-rule" aria-hidden="true" />
            Total budget
          </li>
        ) : null}
      </ul>
      <div
        className="cc-box"
        ref={box}
        tabIndex={0}
        role="group"
        aria-label="Dollars by day. Use the left and right arrow keys to read each day."
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        onPointerLeave={() => setHover(null)}
      >
        <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={chartSummary(view)} focusable="false">
          <line className="cc-base" x1={g.box.margin.left} x2={g.box.margin.left + (width - g.box.margin.left - g.box.margin.right)} y1={baseline} y2={baseline} />
          {g.yTicks.map((t) => (
            <text key={t.usd} className="cc-axis" x={g.box.margin.left - 7} y={t.y} textAnchor="end" dominantBaseline="central">
              {t.label}
            </text>
          ))}
          {g.xTicks.map((t, i) => (
            <text key={t.day} className="cc-axis" x={t.x} y={HEIGHT - 6} textAnchor={i === 0 ? 'start' : i === g.xTicks.length - 1 ? 'end' : 'middle'}>
              {t.label}
            </text>
          ))}

          {g.band ? <path className="cc-band" d={g.band} /> : null}
          {g.budget ? <line className="cc-budget" x1={g.budget.x1} x2={g.budget.x2} y1={g.budget.y} y2={g.budget.y} /> : null}
          <line className="cc-today" x1={g.today.x} x2={g.today.x} y1={g.box.margin.top} y2={baseline} />
          {g.dashed ? <path className="cc-forecast" d={g.dashed} /> : null}
          {g.solid ? <path className="cc-line" d={g.solid} /> : null}
          <circle className="cc-dot" cx={g.today.x} cy={g.today.y} r={3.5} />

          {g.labels.map((l) => (
            <text key={l.key} className={`cc-label cc-label-${l.key}`} x={l.x} y={l.y} textAnchor={l.anchor}>
              {l.text}
            </text>
          ))}

          {point ? (
            <g>
              <line className="cc-cross" x1={point.x} x2={point.x} y1={g.box.margin.top} y2={baseline} />
              <circle className="cc-dot cc-dot-on" cx={point.x} cy={point.y} r={4} />
            </g>
          ) : null}
          <rect className="cc-hit" x={g.box.margin.left} y={g.box.margin.top} width={width - g.box.margin.left - g.box.margin.right} height={baseline - g.box.margin.top} onPointerMove={onMove} onPointerDown={onMove} />
        </svg>
        {point && day ? (
          <div className="cc-tip" style={{ left: flip ? Math.max(g.box.margin.left, tipLeft - 200) : tipLeft + 12 }} aria-hidden="true">
            <span className="cc-tip-day">{dayLabel(view.month, dayOf(day.date))}</span>
            {view.services
              .filter((s) => isBudgeted(s.service))
              .map((s) => (
                <span key={s.service} className="cc-tip-row">
                  <span className="cc-tip-label">{s.label}</span>
                  <span className="fig cc-tip-value">{money(day.byService[s.service] ?? 0)}</span>
                </span>
              ))}
            <span className="cc-tip-row cc-tip-total">
              <span className="cc-tip-label">So far this month</span>
              <span className="fig cc-tip-value">{money(day.cumulativeUsd)}</span>
            </span>
          </div>
        ) : null}
        <span className="sr-only" role="status" aria-live="polite">
          {hover !== null ? dayReadout(view, hover) : ''}
        </span>
      </div>
    </figure>
  );
}
