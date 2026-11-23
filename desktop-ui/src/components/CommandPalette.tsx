import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, useApp } from '../api/hooks';
import { ApiError, type DealRow, type ReviewQuestion } from '../api/types';
import { plural } from '../lib/format';
import { isMac as mac, isWindows } from '../lib/platform';
import { openPreferences } from '../lib/shell';
import { parseRoute } from '../lib/route';
import { actionItems, dealItems, flatten, goToItems, questionItems, rank, type CommandId, type PaletteItem } from '../lib/palette';
import { Button } from './Button';
import { Glyph } from './Glyph';
import { Kbd } from './Layout';
import { Spinner } from './States';
import { useUi } from './ui';
import './CommandPalette.css';


/**
 * The command palette (Cmd+K): a floating panel over the window, in the popover's material. Go to a screen, a Deals
 * view or a Settings section; run an action; find a deal by title, model or Home Depot item number; find a question.
 * Arrow keys move, Return runs, Escape closes (or, on a question it asked, goes back). Nothing runs without his key
 * or click, and an action that changes answers asks first.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { state, navigate } = useApp();
  const ui = useUi();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [deals, setDeals] = useState<DealRow[] | null>(null);
  const [questions, setQuestions] = useState<ReviewQuestion[] | null>(null);
  const [confirming, setConfirming] = useState<PaletteItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const uid = useId();

  // What he can find: the deals and the open questions as the agent holds them now (free reads).
  useEffect(() => {
    let live = true;
    api.deals().then((d) => live && setDeals(d.rows)).catch(() => live && setDeals([]));
    api.review().then((r) => live && setQuestions(r.questions)).catch(() => live && setQuestions([]));
    return () => {
      live = false;
    };
  }, []);

  // The deal open in the inspector, for Watch and Unwatch.
  const openDeal = useMemo(() => {
    const r = parseRoute(window.location.hash);
    const row = r.screen === 'deals' && r.id ? (deals ?? []).find((d) => d.id === r.id) : undefined;
    return row ? { id: row.id, model: row.model, watched: row.watched } : null;
  }, [deals]);
  const askable = (questions ?? []).filter((q) => q.askCostUsd !== null && q.suggestion === null && q.kind !== 'ebay').length;
  const verifiedIds = (questions ?? []).filter((q) => q.suggestion?.status === 'verified').map((q) => q.id);
  const items = useMemo(
    () => [
      ...goToItems(mac, isWindows),
      ...actionItems({ state, askable, verified: verifiedIds.length, deals: deals?.length ?? 0, deal: openDeal }),
      ...dealItems(deals ?? []),
      ...questionItems(questions ?? []),
    ],
    // verifiedIds is rebuilt each render from `questions`; its length is the figure the items read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, askable, verifiedIds.length, deals, questions, openDeal],
  );
  const groups = useMemo(() => rank(items, query), [items, query]);
  const flat = useMemo(() => flatten(groups), [groups]);
  const loading = query.trim() !== '' && (deals === null || questions === null);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, groups]);

  const fail = (e: unknown) => setProblem(e instanceof ApiError ? e.message : 'That did not work. Try again.');

  const command = async (id: CommandId, dealId?: string) => {
    switch (id) {
      case 'watch':
      case 'unwatch':
        if (dealId) await api.watch(dealId, id === 'watch');
        return;
      case 'scan':
        return api.scan();
      case 'stop':
        return api.stop();
      case 'pause':
        return api.pause();
      case 'resume':
        return api.resume();
      case 'ask-all':
        return api.askAll();
      case 'csv':
        return api.downloadDealsCsv({ sort: 'profit' });
      case 'approve-all': {
        const r = await api.approve(verifiedIds);
        setDone(r.skipped.length ? `Approved ${r.approved}. Not applied: ${r.skipped.map((x) => x.reason).join(' ')}` : `Approved ${plural(r.approved, 'answer', 'answers')}.`);
        return;
      }
    }
  };

  const run = async (item: PaletteItem, confirmed = false) => {
    if (busy) return;
    setProblem(null);
    const a = item.action;
    if (a.type === 'command' && item.confirm && !confirmed) {
      setConfirming(item);
      return;
    }
    if (a.type === 'preferences') {
      openPreferences(a.tab);
      onClose();
    } else if (a.type === 'go') {
      navigate(a.route);
      onClose();
    } else if (a.type === 'deal') {
      ui.setInspectorShown(true);
      navigate({ screen: 'deals', id: a.id });
      onClose();
    } else if (a.type === 'question') {
      ui.setInspectorShown(true);
      navigate({ screen: 'review', id: a.id });
      onClose();
    } else {
      setBusy(true);
      try {
        await command(a.command, a.dealId);
        // A result he should read stays on screen; a command whose effect shows in the window just closes.
        if (a.command !== 'approve-all') onClose();
      } catch (e) {
        setConfirming(null);
        fail(e);
      } finally {
        setBusy(false);
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (confirming) setConfirming(null);
      else onClose();
      return;
    }
    if (done) {
      if (e.key === 'Enter') onClose();
      return;
    }
    if (confirming) {
      if (e.key === 'Enter') {
        e.preventDefault();
        void run(confirming, true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = flat[active];
      if (item) void run(item);
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  };

  const activeItem = flat[active];
  let at = -1;
  return (
    <div className="palette-layer" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="palette-field">
          <Glyph name="search" size={16} className="palette-glyph" />
          <input
            ref={input}
            autoFocus
            className="palette-input"
            type="text"
            role="combobox"
            aria-label="Search commands, deals and questions"
            aria-expanded="true"
            aria-controls={`${uid}-list`}
            aria-activedescendant={activeItem && !confirming ? `${uid}-${activeItem.id}` : undefined}
            aria-autocomplete="list"
            placeholder="Go to, run, or find a deal"
            autoComplete="off"
            spellCheck={false}
            value={query}
            readOnly={confirming !== null || done !== null}
            onChange={(e) => setQuery(e.target.value)}
          />
          {loading || busy ? <Spinner size={14} /> : null}
        </div>

        {confirming ? (
          <div className="palette-confirm" role="alertdialog" aria-label={confirming.title}>
            <p>{confirming.confirm}</p>
            <div className="palette-confirm-actions">
              <Button onClick={() => setConfirming(null)}>Cancel</Button>
              <Button variant="primary" busy={busy} busyLabel="Approving…" onClick={() => void run(confirming, true)} data-autofocus="">
                {confirming.title}
              </Button>
            </div>
          </div>
        ) : done ? (
          <div className="palette-confirm" role="status">
            <p>{done}</p>
            <div className="palette-confirm-actions">
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="palette-list" id={`${uid}-list`} role="listbox" aria-label="Results" ref={list}>
            {groups.map((g) => (
              <div key={g.section} role="group" aria-labelledby={`${uid}-${g.section}`}>
                <h2 className="palette-head" id={`${uid}-${g.section}`}>
                  {g.section}
                </h2>
                {g.items.map((item) => {
                  at += 1;
                  const index = at;
                  return (
                    <div
                      key={item.id}
                      id={`${uid}-${item.id}`}
                      role="option"
                      aria-selected={index === active}
                      className={`palette-row${index === active ? ' palette-row-on' : ''}`}
                      onMouseMove={() => index !== active && setActive(index)}
                      onClick={() => void run(item)}
                    >
                      <span className="palette-title">{item.title}</span>
                      {item.detail ? <span className="palette-detail">{item.detail}</span> : null}
                      {item.hint ? <span className="palette-hint">{item.hint}</span> : null}
                    </div>
                  );
                })}
              </div>
            ))}
            {flat.length === 0 && !loading ? <p className="palette-none">{query.trim() ? `Nothing matches “${query.trim()}”.` : 'Nothing to show yet.'}</p> : null}
          </div>
        )}

        <div className="palette-foot">
          {problem ? (
            <span className="palette-problem" role="alert">
              {problem}
            </span>
          ) : (
            <span className="palette-keys">
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> move · <Kbd>↩</Kbd> {confirming ? 'confirm' : 'run'} · <Kbd>esc</Kbd> {confirming ? 'back' : 'close'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
