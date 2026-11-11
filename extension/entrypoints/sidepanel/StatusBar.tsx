import type { AppState } from '../../lib/messages';
import { when } from '../../lib/format';

export function StatusBar({ state, now }: { state: AppState; now: number }) {
  const account = state.account;
  const share = account && account.searchesPerMonth > 0 ? Math.max(0, Math.min(1, account.totalSearchesLeft / account.searchesPerMonth)) : 0;
  return (
    <footer className="statusbar">
      <span>{state.nextRunAt === null ? 'Scans when you click Scan now' : `Next scan ${when(state.nextRunAt, now)}`}</span>
      {account ? (
        <span className="searches-left">
          <span
            className="meter"
            role="img"
            aria-label={`${account.totalSearchesLeft} of ${account.searchesPerMonth} searches left`}
          >
            <span className="meter-fill" style={{ width: `${Math.round(share * 100)}%` }} />
          </span>
          <span>
            <span className="figure left-count">{account.totalSearchesLeft}</span> searches left
          </span>
        </span>
      ) : (
        <span>Searches left unknown</span>
      )}
    </footer>
  );
}
