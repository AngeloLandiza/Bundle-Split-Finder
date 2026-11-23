import { dealListSections } from '@core/deals/sections';
import { useEffect, useMemo, useState } from 'react';
import { api, type DealRow } from '../api';
import { DEAL_SORTS, useDealSort } from '../useDealSort';

function roiRangeText(row: DealRow): string | null {
  const lo = row.roiLowest;
  const hi = row.roiHighest;
  if (lo === null || lo === undefined || hi === null || hi === undefined) return null;
  if (Math.abs(lo - hi) < 0.0001) return null;
  const pct = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(0)}%`;
  return `ROI ${pct(lo)} to ${pct(hi)}`;
}

export function DealsView({ onOpen }: { onOpen: (key: string) => void }) {
  const [rows, setRows] = useState<DealRow[]>([]);
  const [line, setLine] = useState('Loading deals…');
  const [staleDays, setStaleDays] = useState<number | null>(null);
  const [limitNotice, setLimitNotice] = useState<{ title: string; text: string; limit: boolean } | null>(null);
  const [ebayNotice, setEbayNotice] = useState<string | null>(null);
  const [scanRunning, setScanRunning] = useState(false);
  const [sort, setSort] = useDealSort();

  useEffect(() => {
    const poll = () => {
      void fetch('/api/state')
        .then((r) => r.json())
        .then((body) => setScanRunning((body as { scanRunning?: boolean }).scanRunning === true))
        .catch(() => {});
    };
    poll();
    const id = window.setInterval(poll, 20_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void api.deals().then((d) => {
      if (!d.ok || !d.bundles) {
        setLine(d.message ?? 'No deals yet.');
        setRows([]);
        setStaleDays(null);
        setLimitNotice(null);
        setEbayNotice(null);
        return;
      }
      setLine(`${d.bundles.length} bundles · synced ${d.at ?? ''}`);
      setStaleDays(typeof d.staleDays === 'number' ? d.staleDays : null);
      setLimitNotice(d.limitNotice ?? null);
      setEbayNotice(typeof d.ebayNotice === 'string' && d.ebayNotice ? d.ebayNotice : null);
      setRows(d.bundles);
    });
  }, []);

  const groups = useMemo(() => dealListSections(rows, sort), [rows, sort]);

  const labelled = groups.find((g) => g.rows.some((r) => typeof r.profit === 'number'))?.id;

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '8px 16px',
          borderBottom: '1px solid var(--line)',
          fontSize: 13,
          color: 'var(--ink-2)',
        }}
      >
        <span>{line}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {rows.length > 0 ? (
            <a
              className="btn btn-secondary"
              style={{ height: 28, lineHeight: '26px', padding: '0 8px', textDecoration: 'none' }}
              href={`/api/deals/export?sort=${encodeURIComponent(sort)}`}
              download
            >
              Download CSV
            </a>
          ) : null}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="deals-hidden" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>
            Sort by
          </span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            style={{
              height: 28,
              padding: '0 8px',
              border: '1px solid var(--line-strong)',
              borderRadius: 4,
              background: 'var(--surface)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {DEAL_SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                Sort: {s.label}
              </option>
            ))}
          </select>
        </label>
        </span>
      </div>
      {limitNotice ? (
        <div
          className={limitNotice.limit ? 'attention-tag' : undefined}
          style={{
            margin: '8px 16px',
            padding: limitNotice.limit ? undefined : 0,
            fontSize: 13,
            ...(limitNotice.limit
              ? {}
              : { color: 'var(--ink-2)' }),
          }}
        >
          <strong style={{ display: 'block', marginBottom: 4 }}>{limitNotice.title}</strong>
          <span>{limitNotice.text}</span>
        </div>
      ) : null}
      {ebayNotice ? (
        <p className="copy-muted" style={{ margin: 0, padding: '0 16px 8px', fontSize: 13 }}>
          {ebayNotice}
        </p>
      ) : null}
      {staleDays !== null ? (
        <p className="copy-muted" style={{ margin: 0, padding: '8px 16px', fontSize: 13 }}>
          Prices seen {staleDays === 1 ? '1 day' : `${staleDays} days`} ago. The next scan refreshes them.
        </p>
      ) : null}
      {groups.map((g) => (
        <section key={g.id} aria-label={g.label}>
          {g.id === labelled ? (
            <p className="copy-muted" style={{ padding: '8px 16px 0', margin: 0, fontSize: 12 }}>
              Estimated profit · ROI
            </p>
          ) : null}
          <h2
            style={{
              margin: 0,
              padding: '14px 16px 6px',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--ink-2)',
            }}
          >
            {g.label} · {g.rows.length}
          </h2>
          {g.rows.map((b) => (
            <DealRowButton
              key={b.key}
              row={b}
              onOpen={onOpen}
              showCaption={g.id === labelled}
              scanRunning={scanRunning}
            />
          ))}
        </section>
      ))}
    </>
  );
}

function DealRowButton({
  row: b,
  onOpen,
  showCaption,
  scanRunning,
}: {
  row: DealRow;
  onOpen: (key: string) => void;
  showCaption: boolean;
  scanRunning: boolean;
}) {
  const range = showCaption ? roiRangeText(b) : null;
  const lookup = b.lookupParts;
  const searchLabel =
    lookup && lookup.length
      ? `at most ${lookup.length} ${lookup.length === 1 ? 'search' : 'searches'}`
      : null;
  return (
    <div className="deal-row" style={{ display: 'flex', alignItems: 'stretch', gap: 8, paddingRight: 8 }}>
      <button
        type="button"
        style={{ flex: 1, border: 0, cursor: 'pointer', textAlign: 'left', background: 'transparent', padding: 0 }}
        onClick={() => onOpen(b.key)}
      >
      <div>
        <div className="deal-title">{b.title}</div>
        <div className="deal-sub">
          {b.brand} · <span className="mono">{b.model}</span>
          {b.matchLine ? ` · ${b.matchLine}` : null}
        </div>
        {b.needsReview ? (
          <span className="attention-tag" style={{ marginTop: 4 }}>
            Needs your answer
          </span>
        ) : null}
        {b.price !== null && b.price !== undefined ? (
          <div className="deal-sub">
            <span className="mono" style={{ color: 'var(--ink)' }}>
              ${b.price.toFixed(2)}
            </span>
            {typeof b.percentOff === 'number' ? ` · ${b.percentOff}% off` : ''}
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
        {typeof b.profit === 'number' ? (
          <>
            <span
              className="mono figure"
              style={{ fontWeight: 600, color: b.profit < 0 ? 'var(--loss)' : undefined }}
            >
              {b.profit >= 0 ? '+' : ''}${b.profit.toFixed(2)}
            </span>
            {typeof b.roi === 'number' ? (
              <span
                className="mono figure"
                style={{ color: b.profit < 0 ? 'var(--loss)' : 'var(--ink-2)' }}
              >
                ROI {(b.roi * 100).toFixed(0)}%
              </span>
            ) : null}
            {range ? (
              <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                {range}
              </span>
            ) : null}
          </>
        ) : (
          <span className="mono" style={{ color: 'var(--ink-2)' }}>
            {b.itemId ? `#${b.itemId}` : '—'}
          </span>
        )}
      </div>
      </button>
      {lookup?.length ? (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={scanRunning}
          style={{ alignSelf: 'center', height: 32, whiteSpace: 'nowrap' }}
          onClick={() => void api.queueLookUp(b.brand, lookup)}
        >
          Look up · {searchLabel}
        </button>
      ) : null}
    </div>
  );
}