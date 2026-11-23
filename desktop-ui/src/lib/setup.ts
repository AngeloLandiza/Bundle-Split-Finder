// The three setup steps the welcome sheet walks through, read from the agent's state. Setup never
// blocks the app: the sheet can be skipped, and "Finish setup · 1 of 3" stays at the sidebar's foot
// until all three are done.

import type { AppState } from '../api/types';

export type SetupStepId = 'chrome' | 'key' | 'scan';

export interface SetupProgress {
  steps: { id: SetupStepId; done: boolean }[];
  done: number;
  total: number;
  complete: boolean;
  /** The first step still open, or the last one when all are done. */
  current: SetupStepId;
}

export function setupProgress(state: Pick<AppState, 'helper' | 'keys' | 'agent' | 'firstRun'>): SetupProgress {
  const steps: SetupProgress['steps'] = [
    { id: 'chrome', done: state.helper.paired },
    { id: 'key', done: state.keys.serpapi },
    { id: 'scan', done: !state.firstRun || state.agent.lastScan !== null },
  ];
  const done = steps.filter((s) => s.done).length;
  return { steps, done, total: steps.length, complete: done === steps.length, current: (steps.find((s) => !s.done) ?? steps[steps.length - 1]!).id };
}
