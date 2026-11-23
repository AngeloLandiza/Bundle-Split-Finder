import { useEffect, useState } from 'react';
import { api, type PanelBundle } from '../api';

export function DetailView({ bundleKey, onBack }: { bundleKey: string; onBack: () => void }) {
  const [bundle, setBundle] = useState<PanelBundle | null>(null);
  const [line, setLine] = useState('Loading…');

  useEffect(() => {
    void api.deal(bundleKey).then((r) => {
      if (!r.ok || !r.bundle) {
        setLine(r.message ?? 'Could not load bundle.');
        return;
      }
      setBundle(r.bundle);
      setLine('');
    });
  }, [bundleKey]);

  if (!bundle) {
    return (
      <section className="band">
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          Back
        </button>
        <p className="figure" style={{ marginTop: 10 }}>
          {line}
        </p>
      </section>
    );
  }

  const est = bundle.estimate;

  return (
    <>
      <section className="band">
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          Back
        </button>
        <p className="label" style={{ marginTop: 12 }}>
          Bundle
        </p>
        <h2 style={{ margin: '4px 0', fontSize: 16, fontWeight: 600 }}>{bundle.title}</h2>
        <p className="deal-sub">
          {bundle.brand} · <span className="mono">{bundle.model}</span>
        </p>
        <p className="figure">
          {bundle.price !== null ? (
            <span className="mono" style={{ color: 'var(--ink)' }}>
              ${bundle.price.toFixed(2)}
            </span>
          ) : (
            'Price unknown'
          )}
          {bundle.percentOff !== null ? ` · ${bundle.percentOff}% off` : ''}
        </p>
        {est ? (
          <>
            <p className="mono" style={{ margin: '12px 0 4px', fontSize: 28, fontWeight: 600, letterSpacing: '-0.01em' }}>
              {est.profit >= 0 ? '+' : ''}${est.profit.toFixed(2)}
            </p>
            <p className="figure mono">ROI {(est.roi * 100).toFixed(0)}%</p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                gap: 12,
                marginTop: 12,
                fontSize: 13,
              }}
            >
              <div>
                <span className="figure">Bundle cost</span>
                <div className="mono">${est.cost.toFixed(2)}</div>
              </div>
              <div>
                <span className="figure">Parts sell for</span>
                <div className="mono">${est.netRevenue.toFixed(2)}</div>
              </div>
              <div>
                <span className="figure">After fees</span>
                <div className="mono">${est.netRevenue.toFixed(2)}</div>
              </div>
            </div>
            <p className="figure" style={{ marginTop: 10 }}>
              Estimate from your fee settings, not your real Amazon fees.
            </p>
          </>
        ) : (
          <p className="estimate">No estimate yet (fee settings, not your real fees).</p>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12, alignItems: 'center' }}>
          {bundle.link ? (
            <a href={bundle.link} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 500 }}>
              Open on Home Depot
            </a>
          ) : null}
          <a
            className="btn btn-secondary"
            style={{ textDecoration: 'none', height: 32, lineHeight: '30px', padding: '0 12px' }}
            href={`/api/deals/${encodeURIComponent(bundleKey)}/export.csv`}
            download
          >
            Export CSV
          </a>
        </div>
      </section>
      <section className="band">
        <p className="label">Parts · {bundle.parts.length}</p>
        <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
          {bundle.parts.map((p) => (
            <li
              key={p.model}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                gap: 12,
                padding: '8px 0',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <div>
                <span className="mono" style={{ fontWeight: 600 }}>
                  {p.model}
                </span>
                {p.grade ? <span className="figure"> · {p.grade}</span> : null}
              </div>
              {p.price !== null && p.price !== undefined ? (
                <span className="mono">${p.price.toFixed(2)}</span>
              ) : (
                <span className="figure">—</span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}