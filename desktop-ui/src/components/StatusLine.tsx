import type { AgentView } from '../api/types';
import { when } from '../lib/format';
import { estimateShown, stepLook } from '../lib/scanSteps';
import { ProgressBar, Spinner, StepMark } from './States';
import './StatusLine.css';

/** What the agent is doing, in words: the state, then the step the agent reports with its own count. */
export function agentWords(agent: AgentView, now = Date.now()): { state: string; detail: string | null } {
  const p = agent.pipeline;
  const stage = p ? `Step ${Math.min(p.stepsTotal, p.stepsDone + 1)} of ${p.stepsTotal} · ${p.current.count ? `${p.current.label} ${p.current.count}` : p.current.label}` : agent.step;
  switch (agent.status) {
    case 'scanning':
      return { state: 'Scanning', detail: stage ?? 'Starting' };
    case 'asking':
      return { state: 'Asking AI', detail: stage };
    case 'stopping':
      return { state: 'Stopping', detail: 'Finishing the current step' };
    case 'paused':
      return { state: 'Paused', detail: 'No scheduled scan runs until you resume' };
    default:
      return { state: 'Idle', detail: agent.nextScanAt ? `Next scan ${when(agent.nextScanAt, now)}` : 'Scans only when you press Scan now' };
  }
}

/**
 * The one status row (design.md, Scan progress): state and stage on the left, the labelled estimate on the right, a
 * 2px determinate bar under it while the scan runs. The words and figures are core's pipeline view as the agent sends
 * it; nothing is counted here. A run with no stages (the AI pass) shows no bar rather than a made-up one.
 */
export function StatusLine({ agent, compact = false }: { agent: AgentView; compact?: boolean }) {
  const words = agentWords(agent);
  const running = agent.status === 'scanning' || agent.status === 'asking';
  const p = agent.pipeline;
  return (
    <div className={`status${compact ? ' status-compact' : ''}`}>
      <div className="status-line" aria-live="polite">
        <span className="status-text">
          {running || agent.status === 'stopping' ? <Spinner size={14} /> : null}
          <span>
            <span className={`status-state${agent.status === 'paused' ? ' status-paused' : ''}`}>{words.state}</span>
            {words.detail ? <span className="status-detail"> · {words.detail}</span> : null}
          </span>
        </span>
        {running && p && !compact && estimateShown(p) ? <span className="status-right fig">{estimateShown(p)}</span> : null}
      </div>
      {running && p ? <ProgressBar value={p.fraction} label={p.labels?.bar ?? 'Scan progress'} valueText={p.ariaValueText} /> : null}
      {running && p && !compact ? (
        <ol className="status-steps" aria-label={p.labels?.steps ?? 'Scan steps'}>
          {p.steps.map((s) => {
            const look = stepLook(s);
            return (
              <li key={s.label} className={`status-step status-step-${s.state}`} aria-current={s.state === 'now' ? 'step' : undefined}>
                <StepMark mark={look.mark} word={look.markWord} />
                <span className="status-step-label">{s.label}</span>
                <span className="fig status-step-figure">{look.figure}</span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
