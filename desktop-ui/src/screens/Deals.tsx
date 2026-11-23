import { useCallback, useMemo, useRef, useState } from 'react';
import { api, useAction, useApp, useResource } from '../api/hooks';
import type { DealRow, DealSection, DealSort } from '../api/types';
import { Button } from '../components/Button';
import { Money, Profit, Roi, RoiRangeLine } from '../components/Figure';
import { Segmented, Select, TextField } from '../components/Fields';
import { SplitPane } from '../components/Layout';
import { Page } from '../components/Page';
import { EmptyState, LoadError, Notice, SkeletonRows } from '../components/States';
import { Table, type Column, type TableHandle } from '../components/Table';
import { Tag } from '../components/Tag';
import { count, percentOff, plural, when } from '../lib/format';
import { sortRows, type SortState } from '../lib/sort';
import { DealDetailPane } from './DealDetail';
import { SECTION_LABEL, SECTION_ORDER } from './reviewModel';
import './Deals.css';

const SORT_KEY = 'splitFinder.desktopDealsSort';
type Filter = DealSection | 'all';
type Col = DealSort | 'match';

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
  }
}

export function DealsScreen({ openId }: { openId: string | null }) {
  const { navigate, state } = useApp();
  const [res, reload] = useResource(() => api.deals(), [], ['deals']);
  const [sort, setSortState] = useState(readSort);
  const [filter, setFilter] = useState<Filter>('all');
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
  const counts = useMemo(() => {
    const c = new Map<DealSection, number>();
    for (const r of all) c.set(r.section, (c.get(r.section) ?? 0) + 1);
    return c;
  }, [all]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = all.filter((r) => (filter === 'all' || r.section === filter) && (!q || `${r.title} ${r.model} ${r.brand}`.toLowerCase().includes(q)));
    return sortRows(shown, sort, sortValue);
  }, [all, filter, query, sort]);

  const close = useCallback(() => {
    const index = rows.findIndex((r) => r.id === openId);
    navigate({ screen: 'deals', id: null });
    // Focus goes back to the row that was open.
    requestAnimationFrame(() => table.current?.focusRow(Math.max(0, index)));
  }, [navigate, openId, rows]);

  const scanRunning = state?.agent.status === 'scanning';
  const columns: Column<DealRow, Col>[] = [
    {
      key: 'title',
      label: 'Bundle',
      sortable: true,
      natural: 'asc',
      width: 'col-title',
      render: (r) => (
        <div className="deal-cell">
          <span className="deal-title" title={r.title}>
            {r.title}
          </span>
          <span className="deal-sub">
            {r.brand} · <span className="fig">{r.model}</span>
            {r.lookup ? <span className="deal-flag-quiet"> · Waiting for lookup</span> : null}
          </span>
        </div>
      ),
    },
    { key: 'price', label: 'Price', sortable: true, align: 'right', width: 'col-fig', hideBelow: 560, render: (r) => <Money value={r.price} className="cell-fig" /> },
    { key: 'off', label: 'Off', sortable: true, align: 'right', width: 'col-off', hideBelow: 900, render: (r) => <span className="fig cell-fig">{percentOff(r.off)?.replace(' off', '') ?? '—'}</span> },
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

  const sectionOptions = [
    { value: 'all' as Filter, label: 'All', count: all.length },
    ...SECTION_ORDER.filter((s) => counts.get(s)).map((s) => ({ value: s as Filter, label: SECTION_LABEL[s], count: counts.get(s) })),
  ];

  const csv = useAction(api.downloadDealsCsv);
  const sub = res.data ? `${plural(all.length, 'bundle', 'bundles')}${res.data.at ? ` · updated ${when(res.data.at)}` : ''}` : undefined;

  const list = (
    <div className="deals">
      {res.data && all.length > 0 ? (
        <div className="deals-bar">
          <span className="deals-seg">
            <Segmented legend="Show" value={filter} options={sectionOptions} onChange={setFilter} />
          </span>
          <span className="deals-select">
            <Select label={<span className="sr-only">Show</span>} value={filter} onChange={(e) => setFilter(e.target.value as Filter)} width="md">
              {sectionOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label} ({o.count})
                </option>
              ))}
            </Select>
          </span>
          <TextField
            label={<span className="sr-only">Filter bundles</span>}
            placeholder="Filter by title or model"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            width="md"
            data-find=""
            type="search"
            className="deals-filter"
          />
        </div>
      ) : null}
      {res.data?.limitNotice ? (
        <div className="deals-pad deals-notices">
          <Notice tone="attention" title={res.data.limitNotice.title}>
            {res.data.limitNotice.text}
          </Notice>
        </div>
      ) : null}
      {res.data?.staleDays ? (
        <p className="deals-quiet">The oldest price here was seen {plural(res.data.staleDays, 'day', 'days')} ago. A scan refreshes them.</p>
      ) : null}
      {res.data?.ebayNotice ? <p className="deals-quiet">{res.data.ebayNotice}</p> : null}
      {csv.error ? (
        <p className="deals-quiet" role="alert">
          {csv.error}
        </p>
      ) : null}
      {res.status === 'loading' ? <SkeletonRows rows={8} columns={4} label="Loading deals" /> : null}
      {res.status === 'error' ? <div className="deals-pad"><LoadError error={res.error} onRetry={reload} /></div> : null}
      {res.data && all.length === 0 ? (
        <div className="deals-pad">
          <EmptyState
            title="No deals yet."
            cause={state?.agent.lastScan ? 'The last scan found no discounted DEWALT or RYOBI bundles. The next scan looks again.' : 'The agent has not run a scan yet.'}
            action={
              <Button variant="primary" onClick={() => void api.scan()} disabled={!state?.keys.serpapi || scanRunning} cost={state && state.budget.serpPerScan > 0 ? plural(state.budget.serpPerScan, 'search', 'searches') : undefined}>
                Scan now
              </Button>
            }
          />
        </div>
      ) : null}
      {res.data && all.length > 0 && rows.length === 0 ? (
        <div className="deals-pad">
          <EmptyState
            title="No bundle matches."
            cause={query ? `Nothing in ${filter === 'all' ? 'the deals' : SECTION_LABEL[filter]} has “${query}” in its title or model.` : 'This section is empty.'}
            action={
              <Button
                onClick={() => {
                  setQuery('');
                  setFilter('all');
                }}
              >
                Show all
              </Button>
            }
          />
        </div>
      ) : null}
      {rows.length > 0 ? (
        <>
          <Table
            caption="Deals. Profit and ROI are estimates."
            rows={rows}
            columns={columns}
            rowKey={(r) => r.id}
            rowLabel={(r) => `${r.title}, ${r.model}`}
            sort={sort}
            onSort={setSort}
            selected={openId}
            onOpen={(r) => navigate({ screen: 'deals', id: r.id })}
            onClose={openId ? close : undefined}
            handle={table}
          />
          <p className="deals-foot">
            Profit and ROI are estimates from your fee settings, not your real Amazon fees. Showing <span className="fig">{count(rows.length)}</span> of <span className="fig">{count(all.length)}</span>.
          </p>
        </>
      ) : null}
    </div>
  );

  return (
    <Page
      title="Deals"
      sub={sub}
      bodyClass="page-body-split"
      actions={
        all.length ? (
          <Button busy={csv.busy} busyLabel="Preparing…" onClick={() => void csv.run({ sort: sort.key === 'roi' || sort.key === 'off' ? sort.key : 'profit' })} title={csv.error ?? undefined}>
            Download CSV
          </Button>
        ) : null
      }
    >
      <SplitPane main={list} pane={openId ? <DealDetailPane id={openId} onClose={close} /> : null} paneLabel="Bundle detail" onClose={close} />
    </Page>
  );
}

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
