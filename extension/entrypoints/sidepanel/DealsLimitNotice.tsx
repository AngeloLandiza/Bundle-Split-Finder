import { browser } from 'wxt/browser';
import { when } from '../../lib/format';
import type { AppState } from '../../lib/messages';
import { lookupsWaiting } from './dealsModel';
import { tryAgain } from './hourlyBlock';

const HOUR = 60 * 60_000;

/** The title and sentence for each limit that can stop a scan; null when the last scan did not stop at one. */
export function limitCopy(state: AppState, now: number): { title: string; text: string } | null {
  const job = state.lastJob;
  if (!job || job.status !== 'stopped') return null;
  const k = lookupsWaiting(job);
  // Said only when something waits.
  const waiting = (tail: string) => (k === 0 ? '' : ` ${k} ${k === 1 ? 'part still needs' : 'parts still need'} an Amazon lookup${tail}`);
  const n = state.settings.searchesPerScan;
  switch (job.stopReason) {
    case 'run_cap':
      return {
        title: 'Scan stopped at your search limit',
        text: `It used the ${n} ${n === 1 ? 'search' : 'searches'} allowed per scan.${waiting(k === 1 ? ' and goes first next time.' : ' and go first next time.')}`,
      };
    case 'reserve':
      return {
        title: 'Scan stopped at your reserve',
        text: `The rest of this month's searches are kept for scans you start yourself.${waiting('.')}`,
      };
    case 'hourly_limit': {
      const until = (job.finishedAt ?? now) + HOUR;
      const again = tryAgain(until, now);
      const limit = state.account?.rateLimitPerHour;
      return { title: 'Scan stopped at the hourly limit', text: limit ? `SerpApi allows ${limit} searches an hour. ${again}` : again };
    }
    default:
      return null;
  }
}

export function LimitNotice({ state, now }: { state: AppState; now: number }) {
  const copy = limitCopy(state, now);
  if (!copy) return null;
  return (
    <section className="deal-notice" aria-label="Scan limit">
      <div className="deal-notice-text">
        <h2 className="deal-notice-title">{copy.title}</h2>
        <p className="deal-notice-body">{copy.text}</p>
      </div>
      <div className="deal-notice-actions">
        <a className="deal-notice-link" href={browser.runtime.getURL('/options.html')} target="_blank" rel="noreferrer">
          Change the limit
        </a>
        {state.nextRunAt !== null ? <span className="deal-notice-next">Next scan {when(state.nextRunAt, now)}</span> : null}
      </div>
    </section>
  );
}
