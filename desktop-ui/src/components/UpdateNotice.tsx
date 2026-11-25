import { useState } from 'react';
import { api, useAction, useApp } from '../api/hooks';
import type { UpdateNotice } from '../api/types';
import { openPage } from '../lib/actions';
import { Button } from './Button';
import './UpdateNotice.css';

/**
 * What the new-version notice says: the version, a "What changed" disclosure, and, when the agent has no usable link,
 * to ask the developer. The app never downloads or runs anything itself: Download opens the link in the browser and he runs
 * the installer himself (docs/decisions.md, "New versions"). Never a modal; the lowest-priority notice, and he can close it.
 */
export function updateTitle(u: UpdateNotice): string {
  return `Split Finder ${u.version} is ready.`;
}

export function UpdateBody({ update, problem }: { update: UpdateNotice; problem: string | null }) {
  return (
    <>
      {update.link ? 'Download it and run the installer when you like.' : 'Ask the developer for the download link.'}
      <details className="update-changes">
        <summary>What changed</summary>
        <ul>
          {update.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </details>
      {problem ? (
        <span className="notice-more" role="alert">
          {problem}
        </span>
      ) : null}
    </>
  );
}

export function UpdateActions({ update, onProblem }: { update: UpdateNotice; onProblem: (text: string | null) => void }) {
  const { refreshState } = useApp();
  const dismiss = useAction(api.dismissUpdate);
  return (
    <>
      {update.link ? (
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

/** The notice's pieces with the one piece of state they share (a link that could not be opened). */
export function useUpdateNotice(update: UpdateNotice | undefined) {
  const [problem, setProblem] = useState<string | null>(null);
  if (!update) return null;
  return {
    title: updateTitle(update),
    body: <UpdateBody update={update} problem={problem} />,
    action: <UpdateActions update={update} onProblem={setProblem} />,
  };
}
