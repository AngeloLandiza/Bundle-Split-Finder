import { browser } from 'wxt/browser';
import { when } from '../../lib/format';
import type { BundleRow } from '@core/scan/types';
import type { AppState } from '../../lib/messages';
import { sentenceFor } from '../../lib/sentences';
import { lookupsWaiting, waitingKeys } from './dealsModel';
import { tryAgain } from './hourlyBlock';

const HOUR = 60 * 60_000;

/** The title and sentence for each limit that can stop a scan; null when the last scan did not stop at one. */
export function limitCopy(state: AppState, now: number, bundles: BundleRow[]): { title: string; text: string; limit: boolean } | null {
  const job = state.lastJob;
  if (!job || job.status !== 'stopped') return null;
  const k = lookupsWaiting(job, bundles);
  // Said only when something waits.
  // It does not promise an order: at a limit of 1 the listing phase can take the only search.
  const waiting = () => (k === 0 ? '' : ` ${k} ${k === 1 ? 'part still needs' : 'parts still need'} an Amazon lookup.`);
  const n = state.settings.searchesPerScan;
  switch (job.stopReason) {
    case 'user':
      // Not a limit: no link to the settings. A message kept from an earlier failure is said below it (Ruling 44).
      return { title: 'You stopped the last scan', text: `Scan now picks up where it left off.${waiting()}`, limit: false };
    case 'run_cap': {
      const noun = n === 1 ? 'search' : 'searches';
      // Said as it was: all of the allowance, or part of it (a scan can stop at the limit with searches to spare, or none used).
      const used = job.searchesUsed === n ? `the ${n} ${noun}` : `${job.searchesUsed} of the ${n} ${noun}`;
      return { title: 'Scan stopped at your search limit', text: `It used ${used} allowed per scan.${waiting()}`, limit: true };
    }
    case 'reserve':
      return {
        title: 'Scan stopped at your reserve',
        text: `The rest of this month's searches are kept for scans you start yourself.${waiting()}`,
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

/** The sentence a failed lookup leaves in the job's message (core/src/scan/runner.ts, setAside). */
const LOOKUP_FAILED = /The lookup of (\S+) failed: /;

/** The runner's note when Home Depot refused a page (core/src/scan/runner.ts): "(HTTP 403)" or "(no answer)" may follow "a page". */
const REFUSED_PAGE = /Home Depot refused a page(?: \([^)]*\))?; the rest are read next scan\./;

/**
 * A step that failed and was set aside leaves its message on the job while the scan goes on. An error or a rate limit
 * is shown by the Notice above the tabs; every other job that kept a message says it here. A lookup's sentence is said
 * only while that part still waits in the report: a Look up on the panel does not rewrite the job, so the part's own
 * state decides. A page's sentence stays.
 */
export function setAsideSentence(state: AppState, bundles: BundleRow[]): string | null {
  const job = state.lastJob;
  if (!job || job.stopReason === 'error' || job.stopReason === 'rate_limited') return null;
  let message = job.stopMessage;
  const lookup = message === null ? null : LOOKUP_FAILED.exec(message);
  if (message !== null && lookup) {
    const waiting = waitingKeys(bundles);
    const still = [...waiting].some((k) => k.endsWith(`:${lookup[1]!.toUpperCase()}`));
    // The lookup's sentence is the last the runner adds, after any page's.
    if (!still) message = message.slice(0, lookup.index).trim();
  }
  const text = sentenceFor(message, 'try again');
  if (text === null) return null;
  // A refusal's own sentence already says the rest are read next scan: it is said as it is, and only what follows it is "set aside".
  const refusal = REFUSED_PAGE.exec(text);
  if (!refusal) return `Set aside for the next scan. ${text}`;
  const rest = `${text.slice(0, refusal.index)}${text.slice(refusal.index + refusal[0].length)}`.trim();
  return rest === '' ? refusal[0] : `${refusal[0]} Set aside for the next scan. ${rest}`;
}

export function LimitNotice({ state, now, bundles }: { state: AppState; now: number; bundles: BundleRow[] }) {
  const copy = limitCopy(state, now, bundles);
  if (!copy) return null;
  const aside = setAsideSentence(state, bundles);
  return (
    <section className="deal-notice" aria-labelledby="deal-notice-title">
      <div className="deal-notice-text">
        <h2 className="deal-notice-title" id="deal-notice-title">{copy.title}</h2>
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
