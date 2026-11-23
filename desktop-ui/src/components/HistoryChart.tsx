import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DealHistoryPoint } from '../api/types';
import { CHART_LABEL, axisTime, chartKinds, chartOf, extent, isolated, linePath, nearestScan, niceScale, readout, tipTime, type ChartKind } from '../lib/chart';
import { Segmented } from './Fields';
import './HistoryChart.css';

const HEIGHT = 140;
const M = { top: 8, right: 10, bottom: 20, left: 44 };

/**
 * What the scans stored about a bundle, drawn small (docs/design.md, Desktop app > Deal inspector > History): thin lines in
 * the system colours, light gridlines, axis labels in the secondary label colour, a crosshair with a value tooltip on hover.
 * Inline SVG; no library. A scan with no figure is a gap in the line. Left and Right step through the scans from the keyboard.
 */
export function HistoryChart({ history }: { history: DealHistoryPoint[] }) {
  const kinds = useMemo(() => chartKinds(history), [history]);
  const [picked, setPicked] = useState<ChartKind>('prices');
  const kind = kinds.includes(picked) ? picked : kinds[0];
  if (history.length < 2) return <p className="chart-empty">History starts after two scans.</p>;
  if (!kind) return <p className="chart-empty">The scans so far stored no figures to draw.</p>;
  return (
    <div className="chart">
      {kinds.length > 1 ? (
        <Segmented<ChartKind> legend="Chart" size="sm" value={kind} onChange={setPicked} options={kinds.map((k) => ({ value: k, label: CHART_LABEL[k] }))} />
      ) : null}
      <Plot history={history} kind={kind} />
    </div>
  );
}

function Plot({ history, kind }: { history: DealHistoryPoint[]; kind: ChartKind }) {
  const data = useMemo(() => chartOf(history, kind), [history, kind]);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(340);
  const [hover, setHover] = useState<number | null>(null);
  const clip = useId().replace(/[^a-zA-Z0-9]/g, '');

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setWidth(Math.max(200, Math.round(el.getBoundingClientRect().width)));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Another chart or another bundle: the crosshair does not carry over.
  useEffect(() => setHover(null), [kind, history]);

  const range = extent(data.series);
  const n = data.times.length;
  const plotW = width - M.left - M.right;
  const plotH = HEIGHT - M.top - M.bottom;
  const first = data.times[0]!;
  const span = data.times[n - 1]! - first;
  const scale = niceScale(range?.[0] ?? 0, range?.[1] ?? 1);
  const x = (i: number) => M.left + (span > 0 ? ((data.times[i]! - first) / span) * plotW : plotW / 2);
  const y = (v: number) => M.top + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH;
  const zeroY = scale.min < 0 && scale.max > 0 ? y(0) : null;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(nearestScan(data.times, (e.clientX - r.left) / r.width));
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (step !== 0) {
      e.preventDefault();
      setHover((cur) => (cur === null ? (step < 0 ? n - 1 : 0) : Math.max(0, Math.min(n - 1, cur + step))));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setHover(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Escape' && hover !== null) {
      // The first Escape clears the crosshair; the next one deselects the bundle as it does elsewhere.
      e.preventDefault();
      setHover(null);
    }
  };

  const tipLeft = hover === null ? 0 : x(hover);
  // The tooltip is about 170px wide: it goes to the side with room for it.
  const flip = tipLeft + 190 > width;
  const summary = `${CHART_LABEL[kind]} over ${n} scans, ${axisTime(first, span)} to ${axisTime(data.times[n - 1]!, span)}.`;

  return (
    <figure className="chart-figure">
      <ul className="chart-legend" aria-label="Lines">
        {data.series.map((s) => (
          <li key={s.key}>
            <span className={`chart-key chart-key-${s.tone}${s.dashed ? ' chart-key-dashed' : ''}`} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      <div
        className="chart-box"
        ref={box}
        tabIndex={0}
        role="group"
        aria-label={`${summary} Use the left and right arrow keys to read each scan.`}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        onPointerLeave={() => setHover(null)}
      >
        <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} aria-hidden="true" focusable="false">
          <defs>
            {/* A profit line is green above zero and red below it: the same path, clipped twice. */}
            <clipPath id={`${clip}-up`}>
              <rect x={0} y={0} width={width} height={Math.max(0, Math.min(HEIGHT, zeroY ?? (scale.min >= 0 ? HEIGHT : 0)))} />
            </clipPath>
            <clipPath id={`${clip}-down`}>
              <rect x={0} y={zeroY ?? (scale.min >= 0 ? HEIGHT : 0)} width={width} height={HEIGHT} />
            </clipPath>
          </defs>
          {scale.ticks.map((t) => (
            <g key={t}>
              <line className={`chart-grid${t === 0 ? ' chart-grid-zero' : ''}`} x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} />
              <text className="chart-axis" x={M.left - 6} y={y(t)} textAnchor="end" dominantBaseline="central">
                {data.axis(t)}
              </text>
            </g>
          ))}
          <text className="chart-axis" x={M.left} y={HEIGHT - 5} textAnchor="start">
            {axisTime(first, span)}
          </text>
          {width > 300 && n > 2 ? (
            <text className="chart-axis" x={M.left + plotW / 2} y={HEIGHT - 5} textAnchor="middle">
              {axisTime(first + span / 2, span)}
            </text>
          ) : null}
          <text className="chart-axis" x={width - M.right} y={HEIGHT - 5} textAnchor="end">
            {axisTime(data.times[n - 1]!, span)}
          </text>

          {data.series.map((s) => {
            const d = linePath(s.values, x, y);
            const dots = isolated(s.values);
            return (
              <g key={s.key}>
                {s.tone === 'profit' ? (
                  <>
                    <path className="chart-line chart-line-profit" d={d} clipPath={`url(#${clip}-up)`} />
                    <path className="chart-line chart-line-loss" d={d} clipPath={`url(#${clip}-down)`} />
                  </>
                ) : (
                  <path className={`chart-line chart-line-${s.tone}${s.dashed ? ' chart-line-dashed' : ''}`} d={d} />
                )}
                {dots.map((i) => (
                  <circle key={i} className={`chart-dot chart-dot-${s.tone === 'profit' && (s.values[i] ?? 0) < 0 ? 'loss' : s.tone}`} cx={x(i)} cy={y(s.values[i]!)} r={2.5} />
                ))}
              </g>
            );
          })}

          {hover !== null ? (
            <g>
              <line className="chart-cross" x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + plotH} />
              {data.series.map((s) =>
                s.values[hover] === null || s.values[hover] === undefined ? null : (
                  <circle key={s.key} className={`chart-dot chart-dot-on chart-dot-${s.tone === 'profit' && (s.values[hover] as number) < 0 ? 'loss' : s.tone}`} cx={x(hover)} cy={y(s.values[hover] as number)} r={3.5} />
                ),
              )}
            </g>
          ) : null}
          <rect className="chart-hit" x={M.left} y={M.top} width={plotW} height={plotH} onPointerMove={onMove} onPointerDown={onMove} />
        </svg>
        {hover !== null ? (
          <div className="chart-tip" style={{ left: flip ? Math.max(M.left, tipLeft - 180) : tipLeft + 10 }} aria-hidden="true">
            <span className="chart-tip-time">{tipTime(data.times[hover]!)}</span>
            {data.series.map((s) => (
              <span key={s.key} className="chart-tip-row">
                <span className={`chart-key chart-key-${s.tone}${s.dashed ? ' chart-key-dashed' : ''}`} />
                <span className="chart-tip-label">{s.short}</span>
                <span className={`fig chart-tip-value${s.tone === 'profit' && (s.values[hover] ?? 0) < 0 ? ' loss' : ''}`}>{s.values[hover] === null || s.values[hover] === undefined ? 'no figure' : data.format(s.values[hover] as number)}</span>
              </span>
            ))}
          </div>
        ) : null}
        <span className="sr-only" role="status" aria-live="polite">
          {hover !== null ? readout(data, hover) : ''}
        </span>
      </div>
      <figcaption className="chart-note">{data.note}</figcaption>
    </figure>
  );
}
