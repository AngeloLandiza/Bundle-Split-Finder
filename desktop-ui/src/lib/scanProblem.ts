// The banner on Today and Deals for a scan that did not finish its work (docs/ux-checklist.md, item 5 and NN/g
// heuristic 1: the window says what happened, what it means and what to do). Pure: the screen only draws it.
// It is a function of the agent's state, so it goes away by itself when the state says the problem is gone.

import type { AppState, DealRow } from '../api/types';
import { clockTime, plural } from './format';

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
  // Nov 25: when the agent counts the waiting pages itself (agent.homeDepot), `pagesUnread` (written once, when the scan ended)
  // is not read: it said 139 while the between-scan reader had brought the waiting sets to 80. waitingPages() says them live.
  const unread = state.agent.homeDepot !== undefined ? 0 : (last.pagesUnread ?? 0);
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

export interface HelperProblem {
  title: string;
  text: string;
  /** A second line under the text, or null. */
  fallback: string | null;
  /** The one button that helps: reload it (its files are the app's), install it again (they are not), or none (the app is on it). */
  action: 'reload' | 'install' | 'none';
  /** The app is on it: said quietly, with no button. */
  quiet: boolean;
}

/**
 * The Chrome helper is older than the app. When the app updates the helper's own folder by itself (agent/helperUpdate.ts)
 * it says it is on it; when it cannot, or the helper still reports the old build after it did, the one button is "Install
 * the helper again" (a reload would load the same old files). Only a helper the app has no files for gets the reload.
 */
export function helperProblem(state: AppState | null): HelperProblem | null {
  if (!state?.helper.outdated) return null;
  const version = state.helper.version ? `It is version ${state.helper.version}. ` : '';
  const u = state.helper.update;
  if (u?.state === 'updating') {
    return { title: 'The Chrome helper is being updated.', text: 'The app put its new files in the helper folder and asked Chrome to reload it. This goes away when it reconnects.', fallback: null, action: 'none', quiet: true };
  }
  if (u?.state === 'install') {
    return {
      title: 'The Chrome helper is older than the app.',
      text: `${version}${u.why}`,
      fallback: 'Install the helper again puts the new files in its folder; then Chrome loads them.',
      action: 'install',
      quiet: false,
    };
  }
  return {
    title: 'The Chrome helper is older than the app.',
    text: `${version}It may not read Home Depot pages the way this version expects.`,
    fallback: 'If nothing changes: open chrome://extensions and press Reload on Split Finder.',
    action: 'reload',
    quiet: false,
  };
}

export interface WaitingPages {
  /** `quiet`: the app is reading them by itself. `attention`: it cannot go on until he does something. */
  tone: 'quiet' | 'attention';
  /** Set for an attention banner (what is waiting); a quiet line is one sentence in `text`. */
  title?: string;
  text: string;
  /** The one thing that helps, when there is one: resume the paused app. */
  action: 'resume' | null;
}

/**
 * Nov 25: the Home Depot pages waiting, counted live by the agent (not by the last scan). While the app is reading them by
 * itself it is one quiet line with no button: how many wait, the pace and when the next page is read. An attention banner is
 * only for reading that cannot go on by itself: the app paused (the button resumes it). Chrome closed or not connected is
 * said by its own notice, and a scan that is running reads pages itself, so neither is said here. Null: nothing to say.
 */
export function waitingPages(state: AppState | null, now: number = Date.now()): WaitingPages | null {
  const h = state?.agent.homeDepot;
  if (!state || !h || h.pagesWaiting <= 0) return null;
  if (!state.helper.paired || !state.helper.connected || running(state)) return null;
  const who = [
    ...(h.setsWaiting > 0 ? [plural(h.setsWaiting, 'set', 'sets')] : []),
    ...(h.bundlesWaiting > 0 ? [plural(h.bundlesWaiting, 'bundle', 'bundles')] : []),
  ];
  const pages = plural(h.pagesWaiting, 'Home Depot page', 'Home Depot pages');
  const waiting = who.length > 0 ? `${who.join(' and ')} ${h.setsWaiting + h.bundlesWaiting === 1 ? 'is' : 'are'} waiting for ${pages}.` : `${pages} ${h.pagesWaiting === 1 ? 'is' : 'are'} waiting to be read.`;
  if (state.agent.status === 'paused') return { tone: 'attention', title: waiting, text: 'Reading is switched off while the app is paused.', action: 'resume' };
  const paused = h.pausedUntil !== null && Date.parse(h.pausedUntil) > now ? h.pausedUntil : null;
  if (paused !== null) return { tone: 'quiet', text: `${waiting} Home Depot paused reading until ${clockTime(paused, now)}; the app reads them then.`, action: null };
  if (h.perDay > 0 && h.readToday >= h.perDay) return { tone: 'quiet', text: `${waiting} Today's ${h.perDay} pages are read; the app goes on tomorrow.`, action: null };
  const pace = `about ${h.perHour} an hour${h.slowed ? ' today' : ''}`;
  const next = h.nextReadAt !== null ? `; next at ${clockTime(h.nextReadAt, now)}` : '';
  return { tone: 'quiet', text: `${waiting} The app is reading them: ${pace}${next}.`, action: null };
}

/** A bundle whose Home Depot page was not read: shown as waiting, never as a question. */
export const isWaitingPage = (r: Pick<DealRow, 'matchKind'>): boolean => r.matchKind === 'waiting_page';
export const WAITING_PAGE_LABEL = 'Waiting for its Home Depot page';
