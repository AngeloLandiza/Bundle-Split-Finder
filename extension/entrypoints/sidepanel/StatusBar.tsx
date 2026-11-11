import type { AppState } from '../../lib/messages';
import { when } from '../../lib/format';

const LIMITS = ['run_cap', 'reserve', 'hourly_limit'];

function leftText(state: AppState, now: number): string {
  const job = state.lastJob;
  if (job && job.status === 'stopped' && job.stopReason && LIMITS.includes(job.stopReason) && job.finishedAt !== null) {
    return `Scanned ${when(job.finishedAt, now)}`;
  }
  if (state.nextRunAt === null) return 'No scan scheduled';
  return state.nextRunAt < now ? 'Next scan due now' : `Next scan ${when(state.nextRunAt, now)}`;
}

export function StatusBar({ state, now }: { state: AppState; now: number }) {
  const account = state.account;
  const share = account && account.searchesPerMonth > 0 ? Math.max(0, Math.min(1, account.totalSearchesLeft / account.searchesPerMonth)) : 0;
  const left = leftText(state, now);
  return (
    <footer className="statusbar">
      <span className="status-left" title={left}>
        {left}
      </span>
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
