import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, useAction, useApp, useResource } from '../api/hooks';
import type { DealRow, DealSection, DealSort } from '../api/types';
import { Button } from '../components/Button';
import { Money, Profit, Roi, RoiRangeLine } from '../components/Figure';
import { SearchField, Select } from '../components/Fields';
import { InspectorSplit } from '../components/Layout';
import { Page } from '../components/Page';
import { PopoverSection } from '../components/Popover';
import { EmptyState, LoadError, LoadingState, Notice } from '../components/States';
import { Table, type Column, type RowMenu, type TableHandle } from '../components/Table';
import { WatchToggle } from '../components/WatchToggle';
import { Tag } from '../components/Tag';
import { useUi } from '../components/ui';
import { copyText, openPage } from '../lib/actions';
import { count, percentOff, plural, upToSearches, when } from '../lib/format';
import { dealMenu, type DealMenuId } from '../lib/menus';
import { sortRows, type SortState } from '../lib/sort';
import { VIEW_LABEL, inView, type DealView } from '../lib/views';
import { DealDetailPane } from './DealDetail';
import { SECTION_LABEL, SECTION_ORDER } from './reviewModel';
import './Deals.css';

const SORT_KEY = 'splitFinder.desktopDealsSort';
type Filter = DealSection | 'all';
type Col = DealSort | 'match' | 'watch';

function readSort(): SortState<Col> {
  try {
    const v = JSON.parse(localStorage.getItem(SORT_KEY) ?? 'null') as SortState<Col> | null;
    if (v && typeof v.key === 'string' && (v.dir === 'asc' || v.dir === 'desc')) return v;
  } catch {
    // default below
  }
  return { key: 'profit', dir: 'desc' };
}

/** A bundle that needs an answer has no figure to compare, so it sorts last (design.md, Deals row). */
function sortValue(r: DealRow, key: Col): number | string | null {
  switch (key) {
    case 'profit':
      return r.needsAnswer ? null : r.profit;
    case 'roi':
      return r.needsAnswer ? null : r.roi;
    case 'off':
      return r.off;
    case 'price':
      return r.price;
    case 'updated':
      return r.updatedAt;
    case 'title':
      return r.title;
    case 'match':
      return r.matchState;
    case 'watch':
      return r.watched ? 1 : 0;
  }
}

/** The Deals table in the content and the open bundle in the inspector; the sidebar picks the view. */
export function DealsScreen({ openId, view }: { openId: string | null; view: DealView }) {
  const { navigate, state } = useApp();
  const ui = useUi();
  const [res, reload] = useResource(() => api.deals(), [], ['deals']);
  const [sort, setSortState] = useState(readSort);
  const [section, setSection] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const table = useRef<TableHandle>(null);

  const setSort = (s: SortState<Col>) => {
    setSortState(s);
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(s));
    } catch {
      // session only
    }
  };

  const all = res.data?.rows ?? [];
  const inThisView = useMemo(() => all.filter((r) => inView(r, view)), [all, view]);
  const counts = useMemo(() => {
    const c = new Map<DealSection, number>();
    for (const r of inThisView) c.set(r.section, (c.get(r.section) ?? 0) + 1);
    return c;
  }, [inThisView]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = inThisView.filter((r) => (section === 'all' || r.section === section) && (!q || `${r.title} ${r.model} ${r.brand}`.toLowerCase().includes(q)));
    return sortRows(shown, sort, sortValue);
  }, [inThisView, section, query, sort]);

  const close = useCallback(() => {
    const index = rows.findIndex((r) => r.id === openId);
    navigate({ screen: 'deals', id: null, view });
    // Focus goes back to the row that was open.
    requestAnimationFrame(() => table.current?.focusRow(Math.max(0, index)));
  }, [navigate, openId, rows, view]);

  const scanRunning = state?.agent.status === 'scanning';

  // What a row's menu says it did, for a moment: "Copied PCL1600K2." or why it could not.
  const [said, setSaid] = useState<{ tone: 'quiet' | 'attention'; text: string } | null>(null);
  useEffect(() => {
    if (!said || said.tone === 'attention') return;
    const t = setTimeout(() => setSaid(null), 4000);
    return () => clearTimeout(t);
  }, [said]);
  const failed = (e: unknown) => setSaid({ tone: 'attention', text: e instanceof Error ? e.message : 'That did not work. Try again.' });
  const openRow = (r: DealRow) => {
    ui.setInspectorShown(true);
    navigate({ screen: 'deals', id: r.id, view });
  };
  // Watch or Unwatch from the star or the menu: the agent keeps his choice over what a scan would do by itself.
  const [watching, setWatching] = useState<ReadonlySet<string>>(new Set());
  const setWatch = (r: DealRow, watch: boolean) => {
    setWatching((cur) => new Set(cur).add(r.id));
    api
      .watch(r.id, watch)
      .then(() => {
        setSaid({ tone: 'quiet', text: watch ? `Watching ${r.model}. Each scan judges it.` : `Stopped watching ${r.model}.` });
        reload();
      })
      .catch(failed)
      .finally(() =>
        setWatching((cur) => {
          const next = new Set(cur);
          next.delete(r.id);
          return next;
        }),
      );
  };
  const pick = (id: DealMenuId, r: DealRow) => {
    switch (id) {
      case 'open':
      case 'verify':
        openRow(r);
        return;
      case 'open-hd':
        if (!openPage(r.link)) setSaid({ tone: 'attention', text: 'Home Depot’s page could not be opened.' });
        return;
      case 'copy-model':
        void copyText(r.model).then((ok) => setSaid(ok ? { tone: 'quiet', text: `Copied ${r.model}.` } : { tone: 'attention', text: 'Could not copy. Select the model by hand.' }));
        return;
      case 'copy-asins':
        api
          .deal(r.id)
          .then(async (d) => {
            if (d.asins.length === 0) return setSaid({ tone: 'quiet', text: 'No ASIN is chosen for this deal yet.' });
            const ok = await copyText(d.asins.join('\n'));
            setSaid(ok ? { tone: 'quiet', text: `Copied ${plural(d.asins.length, 'ASIN', 'ASINs')}.` } : { tone: 'attention', text: 'Could not copy. Select the ASINs by hand.' });
          })
          .catch(failed);
        return;
      case 'watch':
      case 'unwatch':
        setWatch(r, id === 'watch');
        return;
      case 'bogo':
        // The sheet needs the promotion as it stands (its eligible list), which the row does not carry.
        api
          .deal(r.id)
          .then((d) => ui.openBogo({ dealId: r.id, model: r.model, bogo: d.bogo }))
          .catch(failed);
        return;
      case 'lookup':
        api.lookUp(r.id).then(() => setSaid({ tone: 'quiet', text: `Looked up ${r.model}.` })).catch(failed);
        return;
      case 'review':
        api
          .review()
          .then((rev) => navigate({ screen: 'review', id: rev.questions.find((q) => q.bundle.id === r.id)?.id ?? null }))
          .catch(failed);
        return;
    }
  };
  const menuOf = (r: DealRow): RowMenu => ({ label: r.title, items: dealMenu(r, { scanRunning }), onPick: (id) => pick(id as DealMenuId, r) });

  const columns: Column<DealRow, Col>[] = [
    {
      key: 'watch',
      label: 'Watched',
      hideLabel: true,
      width: 'col-watch',
      render: (r) => <WatchToggle watched={r.watched} label={r.title} busy={watching.has(r.id)} onToggle={() => setWatch(r, !r.watched)} />,
    },
    {
      key: 'title',
      label: 'Bundle',
      sortable: true,
      natural: 'asc',
      width: 'col-title',
      render: (r) => (
        <div className="deal-cell">
          <span className="deal-line">
            <span className="deal-title" title={r.title}>
              {r.title}
            </span>
            {r.buyNow ? (
              <Tag tone="buy" title="The last scan found this worth buying now: above your profit and ROI numbers, selling well, and better than before.">
                Buy now
              </Tag>
            ) : null}
            {r.bogoChoices ? (
              <Tag title={`${r.bogoChoices.label}${r.bogoPair ? ` This pair: ${r.bogoPair.starterModel} with ${r.bogoPair.freeModel} free.` : ''} Found in Home Depot’s Featured BOGO listing.`}>
                {r.bogoChoices.best ? 'BOGO best' : 'BOGO'}
              </Tag>
            ) : r.bogo ? (
              <Tag title={r.bogo === 'choose' ? 'A BOGO promotion you entered: the free tool is not chosen yet.' : 'A BOGO promotion you entered, with its free tool chosen.'}>BOGO</Tag>
            ) : null}
          </span>
          <span className="deal-sub">
            {r.brand} · <span className="code">{r.model}</span>
            {r.lookup ? <span className="deal-flag-quiet"> · Waiting for lookup</span> : null}
          </span>
        </div>
      ),
    },
    { key: 'price', label: 'Price', sortable: true, align: 'right', width: 'col-fig', hideBelow: 560, render: (r) => <Money value={r.price} /> },
    { key: 'off', label: 'Off', sortable: true, align: 'right', width: 'col-off', hideBelow: 900, render: (r) => <span className="fig">{percentOff(r.off)?.replace(' off', '') ?? '—'}</span> },
    {
      key: 'match',
      label: 'Match',
      sortable: true,
      natural: 'asc',
      width: 'col-match',
      hideBelow: 720,
      render: (r) =>
        r.lookup ? (
          <LookUp row={r} disabled={scanRunning} />
        ) : r.needsAnswer ? (
          <Tag tone="attention">Needs your answer</Tag>
        ) : (
          <span className="cell-words" title={r.matchState ?? undefined}>
            {r.matchState ?? '—'}
          </span>
        ),
    },
    {
      key: 'profit',
      label: 'Estimated profit',
      short: 'Est. profit',
      sortable: true,
      align: 'right',
      width: 'col-fig-wide',
      render: (r) =>
        r.profit !== null && !r.needsAnswer ? (
          <Profit value={r.profit} />
        ) : r.needsAnswer ? (
          // With the Match column hidden (a narrow list), the tag moves here so the row still says it.
          <span className="cell-flag">
            <span className="cell-none narrow-hide">—</span>
            <span className="narrow-show">
              <Tag tone="attention">Needs answer</Tag>
            </span>
          </span>
        ) : (
          <span className="cell-none">—</span>
        ),
    },
    {
      key: 'roi',
      label: 'ROI',
      sortable: true,
      align: 'right',
      width: 'col-roi',
      render: (r) =>
        r.roi !== null && !r.needsAnswer ? (
          <span className="cell-roi">
            <Roi value={r.roi} />
            <RoiRangeLine range={r.roiRange} bare />
          </span>
        ) : (
          <span className="cell-none">—</span>
        ),
    },
    { key: 'updated', label: 'Updated', sortable: true, align: 'right', width: 'col-time', hideBelow: 900, render: (r) => <span className="cell-time">{when(r.updatedAt)}</span> },
  ];

  const csv = useAction(api.downloadDealsCsv);
  const title = view === 'all' ? 'Deals' : VIEW_LABEL[view];
  const sub = res.data ? `${plural(inThisView.length, 'bundle', 'bundles')}${res.data.at ? ` · updated ${when(res.data.at)}` : ''}` : undefined;
  const filtered = query.trim() !== '' || section !== 'all';

  const list = (
    <div className="deals">
      {res.data?.limitNotice ? (
        <Notice tone="attention" title={res.data.limitNotice.title}>
          {res.data.limitNotice.text}
        </Notice>
      ) : null}
      {res.data?.staleDays ? <Notice>The oldest price here was seen {plural(res.data.staleDays, 'day', 'days')} ago. A scan refreshes them.</Notice> : null}
      {res.data?.ebayNotice ? <Notice>{res.data.ebayNotice}</Notice> : null}
      {csv.error ? (
        <Notice tone="attention" title="The CSV was not saved.">
          {csv.error}
        </Notice>
      ) : null}
      {said ? <Notice tone={said.tone}>{said.text}</Notice> : null}
      <div className="list-scroll">
        {res.status === 'loading' ? <LoadingState label="Loading deals" /> : null}
        {res.status === 'error' ? <LoadError error={res.error} onRetry={reload} /> : null}
        {res.data && all.length === 0 ? (
          <EmptyState
            title="No deals yet"
            cause={state?.agent.lastScan ? 'The last scan found no discounted DEWALT or RYOBI bundles. The next scan looks again.' : 'The agent has not run a scan yet.'}
            action={
              <Button variant="primary" onClick={() => void api.scan()} disabled={!state?.keys.serpapi || scanRunning} cost={state && state.budget.serpPerScan > 0 ? upToSearches(state.budget.serpPerScan) : undefined}>
                Scan now
              </Button>
            }
          />
        ) : null}
        {res.data && all.length > 0 && inThisView.length === 0 ? <EmptyState title={`Nothing in ${VIEW_LABEL[view]}`} cause={EMPTY_VIEW[view]} action={<Button onClick={() => navigate({ screen: 'deals', id: null })}>Show all deals</Button>} /> : null}
        {inThisView.length > 0 && rows.length === 0 ? (
          <EmptyState
            title="No bundle matches"
            cause={query ? `Nothing here has “${query}” in its title or model.` : 'This section is empty.'}
            action={
              <Button
                onClick={() => {
                  setQuery('');
                  setSection('all');
                }}
              >
                Clear the filter
              </Button>
            }
          />
        ) : null}
        {rows.length > 0 ? (
          <Table
            caption="Deals. Profit and ROI are estimates."
            rows={rows}
            columns={columns}
            rowKey={(r) => r.id}
            rowLabel={(r) => `${r.title}, ${r.model}`}
            sort={sort}
            onSort={setSort}
            selected={openId}
            onOpen={(r) => {
              // Opening a bundle brings the inspector back if it was hidden.
              ui.setInspectorShown(true);
              navigate({ screen: 'deals', id: r.id, view });
            }}
            onClose={openId ? close : undefined}
            handle={table}
            menu={menuOf}
          />
        ) : null}
      </div>
      {rows.length > 0 ? (
        <p className="status-bar">
          <span>
            {filtered ? (
              <>
                <span className="fig">{count(rows.length)}</span> of <span className="fig">{count(inThisView.length)}</span>
              </>
            ) : (
              plural(rows.length, 'bundle', 'bundles')
            )}
          </span>
          <span aria-hidden="true">·</span>
          <span>Profit and ROI are estimates from your fee settings, not your real Amazon fees.</span>
        </p>
      ) : null}
    </div>
  );

  const sectionOptions = [{ value: 'all' as Filter, label: 'All sections', count: inThisView.length }, ...SECTION_ORDER.filter((s) => counts.get(s)).map((s) => ({ value: s as Filter, label: SECTION_LABEL[s], count: counts.get(s) ?? 0 }))];

  return (
    <Page
      title={title}
      sub={sub}
      inspector
      scanNotices
      search={all.length ? <SearchField label="Search deals" placeholder="Title or model" value={query} onChange={setQuery} /> : null}
      viewOptions={
        all.length ? (
          <PopoverSection title="Section">
            <Select label={<span className="sr-only">Section</span>} value={section} onChange={(e) => setSection(e.target.value as Filter)} width="fill">
              {sectionOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label} ({o.count})
                </option>
              ))}
            </Select>
          </PopoverSection>
        ) : null
      }
      actions={
        all.length ? (
          <Button variant="toolbar" glyph="download" busy={csv.busy} busyLabel="Preparing…" onClick={() => void csv.run({ sort: sort.key === 'roi' || sort.key === 'off' ? sort.key : 'profit' })} title="Save the deals as a CSV file, in the order shown">
            Download CSV
          </Button>
        ) : null
      }
    >
      <InspectorSplit main={list} inspector={openId ? <DealDetailPane id={openId} /> : null} label="Bundle" onClose={openId ? close : undefined} empty="No bundle selected" />
    </Page>
  );
}

const EMPTY_VIEW: Record<DealView, string> = {
  'buy-now': 'No watched bundle is worth buying now. A scan checks each one against your profit, ROI and monthly-sales numbers.',
  all: '',
  confirmed: 'No bundle has every part matched and priced yet.',
  'needs-answer': 'No bundle waits for one of your answers.',
  waiting: 'Every bundle’s parts have been looked up.',
  losing: 'No bundle’s estimate is below zero.',
  watchlist: 'No bundle is watched yet. A bundle that is confirmed and discounted is watched by itself; star one to watch it yourself.',
};

function LookUp({ row, disabled }: { row: DealRow; disabled: boolean }) {
  const look = useAction(api.lookUp);
  if (!row.lookup) return null;
  return (
    <span className="row-control">
      <Button size="sm" busy={look.busy} busyLabel="Looking up…" disabled={disabled} title={disabled ? 'A scan is running. Look up when it has finished.' : undefined} onClick={() => void look.run(row.id)} cost={plural(row.lookup.searches, 'search', 'searches')}>
        Look up
      </Button>
      {look.error ? <span className="sr-only" role="alert">{look.error}</span> : null}
    </span>
  );
}
