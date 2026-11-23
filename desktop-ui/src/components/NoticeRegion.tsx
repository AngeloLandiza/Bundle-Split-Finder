import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api, useAction, useApp } from '../api/hooks';
import { ApiError, type KeyName } from '../api/types';
import { plural } from '../lib/format';
import { chooseNotices, moreWords, rejectedKeyNotice, type NoticeKind } from '../lib/notices';
import { words } from '../lib/platform';
import { helperProblem, scanProblem } from '../lib/scanProblem';
import { Button } from './Button';
import { spacedCode } from './PairingNotice';
import { Notice } from './States';
import { useUi } from './ui';
import './Popover.css';
import './NoticeRegion.css';

/** One thing the window has to say: a banner, or a row in the "N more" list. */
export interface NoticeItem {
  kind: NoticeKind;
  key: string;
  tone: 'quiet' | 'attention';
  title?: string;
  body: ReactNode;
  action?: ReactNode;
}

/** The agent answers 200 with `started: false` and a reason when it will not read; the banner says the reason. */
async function readPages(): Promise<void> {
  const r = await api.readPagesAgain();
  if (!r.started) throw new ApiError('refused', r.reason ?? 'The agent did not start reading. Try again in a moment.');
}

/**
 * The one notice region of a screen (docs/ux-checklist.md: one notice at a time). Everything the window may need to say
 * is gathered here and ordered by lib/notices.ts; the most urgent is the banner, and when more apply its trailing area
 * says "1 more" and opens a small list of the others with their actions. Nothing here can be dismissed: each item is
 * drawn from the agent's state, so it goes when the state says the problem is gone.
 *
 * `scan` adds the scan problem and the outdated helper (Today and Deals), `keys` the saved keys this screen works with,
 * and `extra` what only the screen knows (Deals: the parts waiting for a lookup).
 */
export function NoticeRegion({ inset = false, scan = false, keys = [], extra = [] }: { inset?: boolean; scan?: boolean; keys?: readonly KeyName[]; extra?: readonly NoticeItem[] }) {
  const { state, online, offlineSentence, refreshState, pairing, navigate } = useApp();
  const ui = useUi();
  const read = useAction(readPages);
  const reload = useAction(api.reloadHelper);
  const [reloaded, setReloaded] = useState(false);

  const items: NoticeItem[] = [];
  if (online && pairing.requests.length > 0) {
    for (const r of pairing.requests) {
      items.push({
        kind: 'pairing',
        key: `pair-${r.requestId}`,
        tone: 'attention',
        title: 'Chrome wants to connect.',
        body: (
          <>
            Code <span className="fig">{spacedCode(r.code)}</span>. Allow it only if Chrome shows the same code.
            {pairing.error ? <span role="alert"> {pairing.error}</span> : null}
          </>
        ),
        action: (
          <>
            <Button variant="primary" size="sm" busy={pairing.busyId === r.requestId} busyLabel="Allowing…" onClick={() => void pairing.decide(r.requestId, true)}>
              Allow
            </Button>
            <Button size="sm" disabled={pairing.busyId === r.requestId} onClick={() => void pairing.decide(r.requestId, false)}>
              Deny
            </Button>
          </>
        ),
      });
    }
  }
  if (!online) {
    items.push({
      kind: 'offline',
      key: 'offline',
      tone: 'attention',
      title: 'The agent is not running.',
      body: `${offlineSentence ?? `Open Split Finder from the ${words.trayPlace} to start it.`} What is on screen is from before it stopped.`,
      action: (
        <Button size="sm" onClick={refreshState}>
          Try again
        </Button>
      ),
    });
  } else if (state) {
    const h = state.helper;
    if (h.paired && !h.connected) {
      items.push({
        kind: 'chrome',
        key: 'chrome',
        tone: 'quiet',
        title: 'Chrome is closed.',
        body: h.jobsWaiting > 0 ? `${plural(h.jobsWaiting, 'page waits', 'pages wait')} to be read; they run when Chrome opens.` : 'Scans read Home Depot pages in Chrome; open it and the agent carries on.',
      });
    } else if (!h.paired && pairing.requests.length === 0) {
      items.push({
        kind: 'chrome',
        key: 'chrome-pair',
        tone: 'attention',
        title: 'Chrome is not connected.',
        body: 'Scans need it to read Home Depot pages.',
        action: (
          <Button size="sm" onClick={ui.openSetup}>
            Connect Chrome
          </Button>
        ),
      });
    }
    if (!state.keys.serpapi) {
      items.push({
        kind: 'key-missing',
        key: 'serpapi-missing',
        tone: 'attention',
        title: 'No SerpApi key.',
        body: 'Scans and lookups need it.',
        action: (
          <Button size="sm" onClick={ui.openSetup}>
            Add key
          </Button>
        ),
      });
    } else if (state.budget.serpLeft !== null && state.budget.serpLeft <= state.budget.serpReserve) {
      items.push({
        kind: 'reserve',
        key: 'reserve',
        tone: 'attention',
        title: 'Searches are at your reserve.',
        body:
          state.agent.lastScan?.result === 'limit' && state.agent.lastScan.message
            ? state.agent.lastScan.message
            : `${plural(state.budget.serpLeft, 'search', 'searches')} left, all held in reserve. Scheduled scans wait; lookups you start come out of the reserve.`,
      });
    }
    const bad = rejectedKeyNotice(state, keys);
    if (bad) {
      items.push({
        kind: 'key-rejected',
        key: 'key-rejected',
        tone: 'attention',
        title: bad.title,
        body: bad.text,
        action: (
          <Button size="sm" onClick={() => navigate({ screen: 'settings', id: 'keys' })}>
            Fix in {words.preferences} › Keys
          </Button>
        ),
      });
    }
    if (scan) {
      const problem = scanProblem(state);
      if (problem) {
        items.push({
          kind: 'scan',
          key: 'scan-problem',
          tone: 'attention',
          title: problem.what,
          body: (
            <>
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
            </>
          ),
          action: (
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
          ),
        });
      }
      const helper = helperProblem(state);
      if (helper) {
        items.push({
          kind: 'helper',
          key: 'helper-outdated',
          tone: 'attention',
          title: helper.title,
          body: (
            <>
              {helper.text}
              <span className="notice-more">{reloaded ? 'Asked Chrome to reload it. This goes away when the helper reconnects.' : helper.fallback}</span>
              {reload.error ? (
                <span className="notice-more" role="alert">
                  {reload.error}
                </span>
              ) : null}
            </>
          ),
          action: (
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
          ),
        });
      }
    }
  }
  items.push(...extra);

  const scanning = state?.agent.status === 'scanning' || state?.agent.status === 'stopping';
  const { first, more } = chooseNotices(items, { scanning });
  if (!first) return null;
  return (
    <div className={`notices${inset ? ' inset-notices' : ''}`}>
      <Notice
        key={first.key}
        tone={first.tone}
        title={first.title}
        action={
          first.action || more.length ? (
            <>
              {first.action}
              {more.length ? <MoreNotices items={more} /> : null}
            </>
          ) : undefined
        }
      >
        {first.body}
      </Notice>
    </div>
  );
}

/** "1 more": a small popover under the banner with the other notices and their actions. Escape or a click outside closes it. */
function MoreNotices({ items }: { items: readonly NoticeItem[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || button.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  // The list shrinks as problems go away; with none left there is nothing to open.
  useEffect(() => {
    if (items.length === 0) setOpen(false);
  }, [items.length]);
  return (
    <span className="popover-anchor">
      <Button ref={button} size="sm" variant="quiet" aria-expanded={open} aria-controls={id} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        {moreWords(items.length)}
      </Button>
      {open ? (
        <div className="popover notice-popover" id={id} role="dialog" aria-label="Other notices" ref={panel}>
          <ul className="notice-list">
            {items.map((i) => (
              <li key={i.key} className="notice-row">
                <p className="notice-row-text">
                  {i.title ? <strong>{i.title} </strong> : null}
                  <span>{i.body}</span>
                </p>
                {i.action ? <div className="notice-row-action">{i.action}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </span>
  );
}
