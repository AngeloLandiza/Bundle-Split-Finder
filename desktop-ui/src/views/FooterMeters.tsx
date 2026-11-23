import { useEffect, useState } from 'react';

type StateResponse = {
  ok: boolean;
  searchesLeft?: number | null;
  searchesPerMonth?: number | null;
  keepaTokensLeft?: number | null;
  scanRunning?: boolean;
  askAiAllRunning?: boolean;
};

export function FooterMeters() {
  const [st, setSt] = useState<StateResponse | null>(null);

  useEffect(() => {
    const load = () => {
      void fetch('/api/state')
        .then((r) => r.json())
        .then((body) => setSt(body as StateResponse))
        .catch(() => {});
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (!st?.ok) return null;

  const share =
    st.searchesLeft !== null && st.searchesLeft !== undefined && st.searchesPerMonth
      ? Math.max(0, Math.min(1, st.searchesLeft / st.searchesPerMonth))
      : 0;

  return (
    <footer
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 16px',
        fontSize: 13,
        color: 'var(--ink-2)',
        borderTop: '1px solid var(--line)',
        background: 'var(--surface)',
      }}
    >
      <span>
        {st.scanRunning ? 'Scan running in helper' : st.askAiAllRunning ? 'Ask AI batch in helper' : 'Helper connected'}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {st.searchesLeft !== null && st.searchesLeft !== undefined ? (
          <span title="SerpApi searches left on the plan">
            <span
              className="mono"
              style={{
                display: 'inline-block',
                width: 48,
                height: 4,
                background: 'var(--line)',
                borderRadius: 2,
                marginRight: 6,
                verticalAlign: 'middle',
                position: 'relative',
              }}
            >
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${Math.round(share * 100)}%`,
                  background: 'var(--ink)',
                  borderRadius: 2,
                }}
              />
            </span>
            <span className="mono">{st.searchesLeft}</span> searches left
          </span>
        ) : null}
        {st.keepaTokensLeft !== null && st.keepaTokensLeft !== undefined ? (
          <span className="mono">{st.keepaTokensLeft} Keepa tokens</span>
        ) : null}
      </span>
    </footer>
  );
}