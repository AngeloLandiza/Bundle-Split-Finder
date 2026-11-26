import { useEffect, useState } from 'react';
import { api, useAction, useApp } from '../api/hooks';
import type { UpdateNotice } from '../api/types';
import { openPage } from '../lib/actions';
import { Button } from './Button';
import './UpdateNotice.css';

/**
 * The new-version notice, the lowest priority in the notice region, never a modal, and he can close it. Three kinds
 * (docs/decisions.md, "The app updates itself from GitHub releases"):
 * - `updated`: "Split Finder was updated to X." with what changed. Calm: no action but Dismiss.
 * - `ready` (automatic installs off): "Version X is ready." with Install now, which installs once nothing is running.
 * - `download` (a copy that cannot update itself): the release note's link; he runs the installer himself.
 */
export function updateTitle(u: UpdateNotice): string {
  if (u.kind === 'updated') return `Split Finder was updated to ${u.version}.`;
  if (u.kind === 'ready') return `Version ${u.version} is ready.`;
  return `Split Finder ${u.version} is ready.`;
}

function leadOf(u: UpdateNotice, pressed: boolean): string {
  if (u.kind === 'updated') return 'Your data, keys and settings are as they were.';
  if (u.kind === 'ready') {
    if (u.waiting) return u.waiting;
    if (pressed) return 'Installing. Split Finder closes and opens again in about a minute.';
    return 'It installs when you press Install now, once nothing is running, and Split Finder opens again by itself.';
  }
  return u.link ? 'Download it and run the installer when you like.' : 'Ask the developer for the download link.';
}

export function UpdateBody({ update, problem, pressed = false }: { update: UpdateNotice; problem: string | null; pressed?: boolean }) {
  return (
    <>
      {leadOf(update, pressed)}
      {update.notes.length ? (
        <details className="update-changes">
          <summary>What changed</summary>
          <ul>
            {update.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {problem ? (
        <span className="notice-more" role="alert">
          {problem}
        </span>
      ) : null}
    </>
  );
}

export function UpdateActions({ update, onProblem, onPressed }: { update: UpdateNotice; onProblem: (text: string | null) => void; onPressed?: () => void }) {
  const { refreshState } = useApp();
  const dismiss = useAction(api.dismissUpdate);
  const install = useAction(api.installUpdate);
  // The agent's refusal (the version is no longer downloaded) is its own sentence; it shows in the body.
  useEffect(() => {
    if (install.error) onProblem(install.error);
  }, [install.error, onProblem]);
  return (
    <>
      {update.kind === 'ready' ? (
        <Button
          size="sm"
          variant="primary"
          busy={install.busy}
          busyLabel="Installing…"
          onClick={() =>
            void install.run(update.version).then((ok) => {
              if (ok) {
                onProblem(null);
                onPressed?.();
              }
              void refreshState();
            })
          }
        >
          Install now
        </Button>
      ) : null}
      {update.kind !== 'ready' && update.kind !== 'updated' && update.link ? (
        <Button
          size="sm"
          onClick={() => onProblem(openPage(update.link) ? null : 'The link could not be opened. Ask the developer for it.')}
        >
          Download
        </Button>
      ) : null}
      <Button size="sm" variant="quiet" busy={dismiss.busy} onClick={() => void dismiss.run(update.version).then(() => refreshState())}>
        Dismiss
      </Button>
    </>
  );
}

/** The notice's pieces with the state they share (a problem to show, and Install now pressed). */
export function useUpdateNotice(update: UpdateNotice | undefined) {
  const [problem, setProblem] = useState<string | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  if (!update) return null;
  const isPressed = pressed === update.version;
  return {
    title: updateTitle(update),
    body: <UpdateBody update={update} problem={problem} pressed={isPressed} />,
    action: <UpdateActions update={update} onProblem={setProblem} onPressed={() => setPressed(update.version)} />,
  };
}
