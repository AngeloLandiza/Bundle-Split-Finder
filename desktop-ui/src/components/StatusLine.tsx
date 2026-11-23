import type { AgentView } from '../api/types';
import { when } from '../lib/format';
import './StatusLine.css';

/** What the agent is doing, in words: the state, then the step the agent reports with its own count. */
export function agentWords(agent: AgentView, now = Date.now()): { state: string; detail: string | null } {
  const p = agent.pipeline;
  const stage = p ? (p.current.count ? `${p.current.label} · ${p.current.count}` : p.current.label) : agent.step;
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
  const pct = p ? Math.round(p.fraction * 100) : 0;
  return (
    <div className={`status${compact ? ' status-compact' : ''}`}>
      <div className="status-line" aria-live="polite">
        <span className="status-text">
          <span className={`status-state${agent.status === 'paused' ? ' status-paused' : ''}`}>{words.state}</span>
          {words.detail ? <span className="status-detail"> · {words.detail}</span> : null}
        </span>
        {running && p && !compact ? <span className="status-right fig">{p.estimateText}</span> : null}
      </div>
      {running && p ? (
        <span className="status-bar" role="progressbar" aria-label={p.labels?.bar ?? 'Scan progress'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={p.ariaValueText}>
          <span className="status-fill" style={{ inlineSize: `${pct}%` }} />
        </span>
      ) : null}
      {running && p && !compact ? (
        <ol className="status-steps" aria-label={p.labels?.steps ?? 'Scan steps'}>
          {p.steps.map((s) => (
            <li key={s.label} className={`status-step status-step-${s.state}`} aria-current={s.state === 'now' ? 'step' : undefined}>
              <span>{s.label}</span>
              <span className="fig">{s.figure}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
