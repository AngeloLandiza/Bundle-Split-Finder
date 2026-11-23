// What the menu bar popover says (docs/design.md, Desktop app > Menu bar popover). Pure: the words and the
// choices live here so a test can read them; PopoverApp.tsx only draws them.

import type { AppState, DealRow, ReviewQuestion } from '../api/types';
import { plural } from './format';
import { bestDeals } from './today';
import { words } from './platform';

export const POPOVER_QUESTIONS = 3;

export interface PopoverStatus {
  /** The first word: Idle, Scanning, Paused, Chrome closed, Agent offline. */
  state: string;
  /** The quiet line under it. */
  detail: string | null;
  /** While a scan or the AI pass runs: the agent's own step count and share done. */
  progress: { step: number; of: number; fraction: number } | null;
  /** Chrome or the agent needs the owner: the state is drawn in the attention colour. */
  attention: boolean;
}

/**
 * The header's state. Words come from the agent's pipeline view (the step number and total are core's own
 * stepsDone and stepsTotal; nothing is counted here). Paused wins over Chrome closed, and Chrome closed over
 * Idle, because a scan cannot start without Chrome.
 */
export function popoverStatus(state: AppState | null, online: boolean): PopoverStatus {
  if (!online) return { state: 'Agent offline', detail: 'Open Split Finder to start it', progress: null, attention: true };
  if (!state) return { state: 'Loading', detail: null, progress: null, attention: false };
  const { agent, helper } = state;
  const p = agent.pipeline;
  const running = agent.status === 'scanning' || agent.status === 'asking';
  if (running) {
    const word = agent.status === 'scanning' ? 'Scanning' : 'Asking AI';
    if (!p) return { state: word, detail: agent.step ?? 'Starting', progress: null, attention: false };
    const step = Math.min(p.stepsTotal, p.stepsDone + 1);
    const stage = p.current.count ? `${p.current.label} · ${p.current.count}` : p.current.label;
    return {
      state: word,
      detail: `Step ${step} of ${p.stepsTotal} · ${stage}`,
      progress: { step, of: p.stepsTotal, fraction: p.fraction },
      attention: false,
    };
  }
  if (agent.status === 'stopping') return { state: 'Stopping', detail: 'Finishing the current step', progress: null, attention: false };
  if (agent.status === 'paused') return { state: 'Paused', detail: 'No scheduled scan runs until you resume', progress: null, attention: false };
  if (agent.status === 'error') return { state: 'Needs attention', detail: 'Open Activity to see what failed', progress: null, attention: true };
  if (helper.paired && !helper.connected) return { state: 'Chrome closed', detail: 'Scans need Chrome open', progress: null, attention: true };
  return { state: 'Idle', detail: helper.paired ? null : 'Chrome is not connected', progress: null, attention: false };
}

/** The questions as Today lists them: AI-verified first (one press approves them), then the rest, oldest first. */
export function orderQuestions(questions: readonly ReviewQuestion[]): ReviewQuestion[] {
  const verified = questions.filter((q) => q.suggestion?.status === 'verified');
  const rest = questions.filter((q) => q.suggestion?.status !== 'verified').sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  return [...verified, ...rest];
}

/** The rows shown under Needs you, and how many more Review holds. `total` is the agent's own open count. */
export function needsYou(questions: readonly ReviewQuestion[], total: number): { shown: ReviewQuestion[]; more: number } {
  const shown = orderQuestions(questions).slice(0, POPOVER_QUESTIONS);
  return { shown, more: Math.max(0, total - shown.length) };
}

/**
 * The best deal: the highest estimated profit among bundles with an estimate that is not a loss and no open question
 * (Today's rule, so the two never disagree; an estimate below zero is never a "best"). The rows carry no "first seen"
 * date, so this is the best of what the last scan holds, not only of what it found new.
 */
export function bestDeal(rows: readonly DealRow[]): DealRow | null {
  return bestDeals(rows)[0] ?? null;
}

/** Why Scan now cannot be pressed, or null when it can. */
export function scanBlocked(state: AppState | null, online: boolean): string | null {
  if (!online || !state) return 'The agent is not running.';
  if (state.agent.status === 'paused') return 'Resume the agent first.';
  if (!state.keys.serpapi) return `Add your SerpApi key in ${words.preferences} first.`;
  const { serpLeft, serpReserve } = state.budget;
  if (serpLeft !== null && serpLeft <= serpReserve) return 'Searches are at your reserve.';
  return null;
}

/** "5 searches" for the Scan now button, or undefined when the agent has not said what a scan costs. */
export function scanCost(state: AppState | null): string | undefined {
  const n = state?.budget.serpPerScan ?? 0;
  return n > 0 ? plural(n, 'search', 'searches') : undefined;
}

export const isRunning = (state: AppState | null): boolean => state?.agent.status === 'scanning' || state?.agent.status === 'asking' || state?.agent.status === 'stopping';
