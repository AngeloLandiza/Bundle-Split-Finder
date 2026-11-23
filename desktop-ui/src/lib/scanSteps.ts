// How a running scan reads on screen (docs/ux-checklist.md, "Long-running and background work"): every step has a text
// label and a mark (done, running, waiting, skipped, failed); a step with a count says "N of M"; a time figure only
// when the agent has one; and one thin line says where the scan is for the lists that fill as it goes. Pure: the
// screens only draw it, and nothing here counts or estimates anything the agent did not say.

import type { AgentView, PipelineStepView, PipelineView } from '../api/types';

export type StepMark = 'done' | 'running' | 'waiting' | 'skipped' | 'failed';

export interface StepLook {
  mark: StepMark;
  /** The mark in words, for a screen reader and for a hover: colour is never the only signal. */
  markWord: string;
  /** "31 of 40" when the step reports its own count, else null. */
  count: string | null;
  /** What the right-hand cell says: the count when there is one, else the agent's figure ("13 read", why it was skipped). */
  figure: string;
}

const MARK: Record<PipelineStepView['state'], { mark: StepMark; word: string }> = {
  done: { mark: 'done', word: 'Done' },
  now: { mark: 'running', word: 'Running' },
  next: { mark: 'waiting', word: 'Waiting' },
  skipped: { mark: 'skipped', word: 'Skipped' },
  failed: { mark: 'failed', word: 'Failed' },
};

/** A step's mark and figure. A state the agent never uses reads as waiting, not as done. */
export function stepLook(step: PipelineStepView): StepLook {
  const m = MARK[step.state] ?? MARK.next;
  const hasCount = typeof step.done === 'number' && typeof step.total === 'number' && step.total > 0;
  const count = hasCount ? `${step.done} of ${step.total}` : null;
  // A skipped or failed step says why in its figure; a count would hide that.
  const figure = m.mark === 'skipped' || m.mark === 'failed' ? step.figure : (count ?? step.figure);
  return { mark: m.mark, markWord: m.word, count, figure };
}

/** The time figure, only when the agent has one: an empty text, or "estimating", is nothing to show (NN/g: never a permanent "estimating"). */
export function estimateShown(p: Pick<PipelineView, 'estimateText'> | null | undefined): string | null {
  const t = p?.estimateText?.trim() ?? '';
  return t && !/^estimating/i.test(t) ? t : null;
}

export const isScanning = (agent: Pick<AgentView, 'status'>): boolean => agent.status === 'scanning';

/**
 * The one line above Deals and Review while a scan runs: "Scanning · step 3 of 8 · Reading part prices 31 of 40".
 * Null when no scan runs (the AI pass has its own status in the toolbar) or the agent sent no stages.
 */
export function scanStrip(agent: Pick<AgentView, 'status' | 'pipeline'>): string | null {
  const p = agent.pipeline;
  if (agent.status !== 'scanning' || !p) return null;
  const step = Math.min(p.stepsTotal, p.stepsDone + 1);
  const stage = p.current.count ? `${p.current.label} ${p.current.count}` : p.current.label;
  return `Scanning · step ${step} of ${p.stepsTotal} · ${stage}`;
}
