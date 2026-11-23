import type { AgentState } from '../api/types';
import { count, eta, usdSpend, when } from '../lib/format';
import './StatusLine.css';

/** What the agent is doing, in words: the state, then the step and its own count. */
export function agentWords(agent: AgentState, now = Date.now()): { state: string; detail: string | null } {
  const step = agent.step;
  const stepCount = step && step.done !== null && step.total !== null ? ` · ${count(step.done)} of ${count(step.total)}` : '';
  switch (agent.status) {
    case 'scanning':
      return { state: 'Scanning', detail: step ? `${step.name}${stepCount}` : 'Starting' };
    case 'asking':
      return { state: 'Asking AI', detail: step && step.done !== null && step.total !== null ? `${count(step.done)} of ${count(step.total)} questions` : null };
    case 'stopping':
      return { state: 'Stopping', detail: 'Finishing the current step' };
    case 'paused':
      return { state: 'Paused', detail: 'No scheduled scan runs until you resume' };
    default:
      return { state: 'Idle', detail: agent.nextScanAt ? `Next scan ${when(agent.nextScanAt, now)}` : 'Scans only when you press Scan now' };
  }
}

/**
 * The one status row (design.md, Scan progress): state and step on the left, the labelled
 * estimate on the right, a 2px determinate bar under it while something runs.
 */
export function StatusLine({ agent, compact = false }: { agent: AgentState; compact?: boolean }) {
  const words = agentWords(agent);
  const running = agent.status === 'scanning' || agent.status === 'asking';
  const p = agent.progress;
  const pct = p ? Math.round(p.fraction * 100) : 0;
  return (
    <div className={`status${compact ? ' status-compact' : ''}`}>
      <div className="status-line" aria-live="polite">
        <span className="status-text">
          <span className={`status-state${agent.status === 'paused' ? ' status-paused' : ''}`}>{words.state}</span>
          {words.detail ? <span className="status-detail"> · {words.detail}</span> : null}
        </span>
        {running && p && !compact ? (
          <span className="status-right fig">
            {eta(p.etaSeconds)}
            {p.aiSpentUsd > 0 ? ` · ${usdSpend(p.aiSpentUsd)} so far` : ''}
          </span>
        ) : null}
      </div>
      {running ? (
        <span
          className="status-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${agent.step ? `Step ${agent.step.index} of ${agent.step.of}, ${agent.step.name.toLowerCase()}` : words.state}, ${eta(p?.etaSeconds)} left`}
        >
          <span className="status-fill" style={{ inlineSize: `${pct}%` }} />
        </span>
      ) : null}
    </div>
  );
}
