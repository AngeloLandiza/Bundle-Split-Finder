// "Connect to the Split Finder app": the one control for the link, in the side panel (compact) and on the settings page. Unpaired it
// starts pairing; waiting it shows the code to approve in the app; paired it says so and offers Disconnect. The words are the
// owner's own to read, so they are plain: what happens, what to do, and nothing about tokens.

import { useEffect, useState } from 'react';
import { spokenCode, type AgentLink } from './agentLink';
import type { AgentLinkActions } from './useAgentLink';
import { when } from './format';
import { CONNECT_BUTTON_LABEL } from '../../core/src/api/labels';
import './AgentConnect.css';

export interface AgentConnectProps {
  link: AgentLink;
  actions: AgentLinkActions;
  /** The side panel's one-paragraph form. */
  compact?: boolean;
  now?: () => number;
}

/** "last job 2 min ago", or that there has been none yet. */
export function lastJobText(lastJobAt: number | null, now: number): string {
  return lastJobAt === null ? 'no jobs yet' : `last job ${when(lastJobAt, now)}`;
}

const minutesLeft = (expiresAt: number, now: number): number => Math.max(1, Math.round((expiresAt - now) / 60_000));

export function useClock(now: () => number, everyMs = 30_000): number {
  const [t, setT] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setT(now()), everyMs);
    return () => clearInterval(id);
  }, [now, everyMs]);
  return t;
}

export function AgentConnect({ link, actions, compact = false, now = Date.now }: AgentConnectProps) {
  const clock = useClock(now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (f: () => Promise<string | null>) => async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const refused = await f();
    setBusy(false);
    setError(refused);
  };

  if (link.status === 'paired') {
    return (
      <section className="agent-connect" data-status="paired" aria-label="Split Finder app">
        <p className="agent-connect-line" role="status">
          <span className="agent-connect-strong">Connected to the app</span>
          <span className="agent-connect-dot" aria-hidden="true">
            {' · '}
          </span>
          <span>{lastJobText(link.lastJobAt, clock)}</span>
        </p>
        {compact ? null : <p className="agent-connect-text">The app runs scans and holds your keys. This browser reads Home Depot for it when it asks.</p>}
        <button type="button" className="agent-btn agent-btn--secondary" disabled={busy} onClick={run(actions.disconnect)}>
          Disconnect
        </button>
        {error ? (
          <p className="agent-connect-text" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  if (link.status === 'pairing') {
    return (
      <section className="agent-connect" data-status="pairing" aria-label="Split Finder app">
        <p className="agent-connect-line" role="status">
          Enter nothing — approve code <span className="agent-code">{spokenCode(link.code)}</span> in the app.
        </p>
        <p className="agent-connect-text">
          Waiting for the app. The code works for about {minutesLeft(link.expiresAt, clock)} more {minutesLeft(link.expiresAt, clock) === 1 ? 'minute' : 'minutes'}.
        </p>
        <button type="button" className="agent-btn agent-btn--secondary" disabled={busy} onClick={run(actions.disconnect)}>
          Cancel
        </button>
        {error ? (
          <p className="agent-connect-text" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="agent-connect" data-status="unpaired" aria-label="Split Finder app">
      {link.notice ? (
        <p className="agent-connect-line" role="status">
          {link.notice}
        </p>
      ) : null}
      <p className="agent-connect-text">
        {compact
          ? 'The Split Finder app can run the scans and keep the questions. The app must be open.'
          : 'Connect this browser to the Split Finder app, which then runs scans, holds your keys and sends questions here to answer. The app must be open. Until you connect, this extension works on its own.'}
      </p>
      <button type="button" className="agent-btn agent-btn--primary" disabled={busy} onClick={run(actions.connect)}>
        {CONNECT_BUTTON_LABEL}
      </button>
      {error ? (
        <p className="agent-connect-text" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
