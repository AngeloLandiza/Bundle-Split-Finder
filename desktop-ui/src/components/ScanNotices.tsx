import { useState } from 'react';
import { api, useAction, useApp } from '../api/hooks';
import { ApiError } from '../api/types';
import { helperProblem, scanProblem } from '../lib/scanProblem';
import { Button } from './Button';
import { Notice } from './States';

/** The agent answers 200 with `started: false` and a reason when it will not read; the banner says the reason. */
async function readPages(): Promise<void> {
  const r = await api.readPagesAgain();
  if (!r.started) throw new ApiError('refused', r.reason ?? 'The agent did not start reading. Try again in a moment.');
}

/**
 * The two banners for a scan that left work undone and a helper older than the app (Today and Deals). Each says what
 * happened, what it means and the one action that fixes it. Neither can be dismissed: they are drawn from the agent's
 * state, so they go when the state says the problem is gone.
 */
export function ScanNotices() {
  const { state, navigate, refreshState } = useApp();
  const read = useAction(readPages);
  const reload = useAction(api.reloadHelper);
  const [reloaded, setReloaded] = useState(false);
  const problem = scanProblem(state);
  const helper = helperProblem(state);
  if (!problem && !helper) return null;
  return (
    <>
      {problem ? (
        <Notice
          tone="attention"
          title={problem.what}
          action={
            <>
              {problem.action ? (
                <Button
                  size="sm"
                  busy={read.busy}
                  busyLabel="Reading…"
                  disabled={!problem.action.enabled}
                  cost="free"
                  aria-describedby={problem.action.reason ? 'scan-problem-reason' : undefined}
                  onClick={() => void read.run().then(() => refreshState())}
                >
                  Read pages again
                </Button>
              ) : null}
              <Button size="sm" variant="quiet" onClick={() => navigate({ screen: 'activity', id: null })}>
                Details
              </Button>
            </>
          }
        >
          {problem.consequence}
          {problem.action?.reason ? (
            <span className="notice-more" id="scan-problem-reason">
              {problem.action.reason}
            </span>
          ) : null}
          {read.error ? (
            <span className="notice-more" role="alert">
              {read.error}
            </span>
          ) : null}
        </Notice>
      ) : null}
      {helper ? (
        <Notice
          tone="attention"
          title={helper.title}
          action={
            <Button
              size="sm"
              busy={reload.busy}
              busyLabel="Reloading…"
              onClick={() =>
                void reload.run().then((ok) => {
                  setReloaded(ok);
                  refreshState();
                })
              }
            >
              Reload it
            </Button>
          }
        >
          {helper.text}
          <span className="notice-more">{reloaded ? 'Asked Chrome to reload it. This goes away when the helper reconnects.' : helper.fallback}</span>
          {reload.error ? (
            <span className="notice-more" role="alert">
              {reload.error}
            </span>
          ) : null}
        </Notice>
      ) : null}
    </>
  );
}
