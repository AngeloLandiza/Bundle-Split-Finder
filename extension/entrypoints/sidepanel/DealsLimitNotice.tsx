import { browser } from 'wxt/browser';
import { when } from '../../lib/format';
import type { AppState } from '../../lib/messages';
import { sentenceFor } from '../../lib/sentences';
import { lookupsWaiting } from './dealsModel';
import { tryAgain } from './hourlyBlock';

const HOUR = 60 * 60_000;

/** The title and sentence for each limit that can stop a scan; null when the last scan did not stop at one. */
export function limitCopy(state: AppState, now: number): { title: string; text: string; limit: boolean } | null {
  const job = state.lastJob;
  if (!job || job.status !== 'stopped') return null;
  const k = lookupsWaiting(job);
  // Said only when something waits.
  const waiting = (tail: string) => (k === 0 ? '' : ` ${k} ${k === 1 ? 'part still needs' : 'parts still need'} an Amazon lookup${tail}`);
  const n = state.settings.searchesPerScan;
  const first = k === 1 ? ' and goes first next time.' : ' and go first next time.';
  switch (job.stopReason) {
    case 'user':
      // Not a limit: no link to the settings. A message kept from an earlier failure is not shown.
      return { title: 'You stopped the last scan', text: `Scan now picks up where it left off.${waiting(first)}`, limit: false };
    case 'run_cap': {
      const noun = n === 1 ? 'search' : 'searches';
      // Said as it was: all of the allowance, or part of it (a scan can stop at the limit with searches to spare, or none used).
      const used = job.searchesUsed === n ? `the ${n} ${noun}` : `${job.searchesUsed} of the ${n} ${noun}`;
      return { title: 'Scan stopped at your search limit', text: `It used ${used} allowed per scan.${waiting(first)}`, limit: true };
    }
    case 'reserve':
      return {
        title: 'Scan stopped at your reserve',
        text: `The rest of this month's searches are kept for scans you start yourself.${waiting('.')}`,
        limit: true,
      };
    case 'hourly_limit': {
      const until = (job.finishedAt ?? now) + HOUR;
      const again = tryAgain(until, now);
      const limit = state.account?.rateLimitPerHour;
      return { title: 'Scan stopped at the hourly limit', text: limit ? `SerpApi allows ${limit} searches an hour. ${again}` : again, limit: true };
    }
    default:
      return null;
  }
}

/**
 * A step that failed and was set aside leaves its message on the job while the scan goes on. An error or a rate limit
 * is shown by the Notice above the tabs; every other job that kept a message says it here.
 */
export function setAsideSentence(state: AppState): string | null {
  const job = state.lastJob;
  if (!job || job.stopReason === 'error' || job.stopReason === 'rate_limited') return null;
  const text = sentenceFor(job.stopMessage, 'try again');
  return text === null ? null : `Set aside for the next scan: ${text}`;
}

export function LimitNotice({ state, now }: { state: AppState; now: number }) {
  const copy = limitCopy(state, now);
  if (!copy) return null;
  const aside = setAsideSentence(state);
  return (
    <section className="deal-notice" aria-label="Scan limit">
      <div className="deal-notice-text">
        <h2 className="deal-notice-title">{copy.title}</h2>
        <p className="deal-notice-body">{copy.text}</p>
        {aside ? <p className="deal-notice-body">{aside}</p> : null}
      </div>
      <div className="deal-notice-actions">
        {copy.limit ? (
          <a className="deal-notice-link" href={browser.runtime.getURL('/options.html')} target="_blank" rel="noreferrer">
            Change the limit
          </a>
        ) : null}
        {state.nextRunAt !== null ? <span className="deal-notice-next">Next scan {when(state.nextRunAt, now)}</span> : null}
      </div>
    </section>
  );
}
