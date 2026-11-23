// The banner on Today and Deals for a scan that did not finish its work (docs/ux-checklist.md, item 5 and NN/g
// heuristic 1: the window says what happened, what it means and what to do). Pure: the screen only draws it.
// It is a function of the agent's state, so it goes away by itself when the state says the problem is gone.

import type { AppState, DealRow } from '../api/types';
import { plural } from './format';

export interface ScanProblem {
  /** What happened, in plain words. */
  what: string;
  /** What it means for the deals on screen. */
  consequence: string;
  /** "Read pages again" is offered only when the agent said it can (`canReadPagesAgain` is present). */
  action: { enabled: boolean; /** Why it is greyed, said on screen, or null when it is not. */ reason: string | null } | null;
}

const running = (s: AppState): boolean => s.agent.status === 'scanning' || s.agent.status === 'asking' || s.agent.status === 'stopping';

/** The problem the last scan left, or null. A stop the owner asked for is not one. */
export function scanProblem(state: AppState | null): ScanProblem | null {
  const last = state?.agent.lastScan;
  if (!state || !last) return null;
  const unread = last.pagesUnread ?? 0;
  // A stop at the reserve is already said by the app's own notice under the toolbar (AppNotices); not twice.
  const atReserve = state.budget.serpLeft !== null && state.budget.serpLeft <= state.budget.serpReserve;
  // When the agent says what is waiting and why (`waitingLookups`), the lookup notice on Deals owns a stop at a limit.
  const lookupsSaid = last.waitingLookups !== undefined;
  const stoppedEarly = (last.result === 'stopped' && !last.userStopped) || last.result === 'failed' || (last.result === 'limit' && !atReserve && !lookupsSaid);
  if (unread <= 0 && !stoppedEarly) return null;

  let what: string;
  let consequence: string;
  if (unread > 0) {
    what = `The last scan could not read ${plural(unread, 'Home Depot page', 'Home Depot pages')}, so ${unread === 1 ? 'its parts are' : 'their parts are'} not known yet.`;
    consequence = `${unread === 1 ? 'That bundle has' : 'Those bundles have'} no estimate until the page is read. The prices already found are kept.`;
  } else if (last.result === 'failed') {
    what = last.message ? `The last scan failed. ${last.message}` : 'The last scan failed.';
    consequence = 'Deals and prices from before it are kept; the next scan looks again.';
  } else if (last.result === 'limit') {
    what = last.message ?? 'The last scan stopped at its search limit.';
    consequence = 'Whatever it found is kept; the rest waits for the next scan.';
  } else {
    what = last.message ?? 'The last scan stopped early.';
    consequence = 'Whatever it found is kept; the rest is read next scan.';
  }

  if (unread <= 0 || last.canReadPagesAgain === undefined) return { what, consequence, action: null };
  const reason = running(state)
    ? 'A scan is running. Read the pages when it has finished.'
    : !last.canReadPagesAgain
      ? !state.helper.connected
        ? 'Chrome is closed. Open it, then read the pages again.'
        : 'The agent cannot read them again right now.'
      : null;
  return { what, consequence, action: { enabled: reason === null, reason } };
}

/** The Chrome helper is older than the app: what to say and the line for when reloading changes nothing. */
export function helperProblem(state: AppState | null): { title: string; text: string; fallback: string } | null {
  if (!state?.helper.outdated) return null;
  return {
    title: 'The Chrome helper is older than the app.',
    text: `${state.helper.version ? `It is version ${state.helper.version}. ` : ''}It may not read Home Depot pages the way this version expects.`,
    fallback: 'If nothing changes: open chrome://extensions and press Reload on Split Finder.',
  };
}

/** A bundle whose Home Depot page was not read: shown as waiting, never as a question. */
export const isWaitingPage = (r: Pick<DealRow, 'matchKind'>): boolean => r.matchKind === 'waiting_page';
export const WAITING_PAGE_LABEL = 'Waiting for its Home Depot page';
