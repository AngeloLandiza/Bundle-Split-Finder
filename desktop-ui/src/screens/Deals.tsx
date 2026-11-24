import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, useAction, useApp, useResource } from '../api/hooks';
import { ApiError, type DealRow, type DealSection, type DealSort } from '../api/types';
import { Button, LinkButton } from '../components/Button';
import { Money, Roi, RoiRangeLine, RowProfit } from '../components/Figure';
import { SearchField, Select } from '../components/Fields';
import { InspectorSplit } from '../components/Layout';
import { Page } from '../components/Page';
import { PopoverSection } from '../components/Popover';
import { EmptyState, LoadError, LoadingState, ScanStrip } from '../components/States';
import type { NoticeItem } from '../components/NoticeRegion';
import { Table, type Column, type RowMenu, type TableHandle } from '../components/Table';
import { WatchToggle } from '../components/WatchToggle';
import { Tag } from '../components/Tag';
import { useUi } from '../components/ui';
import { copyText, openPage } from '../lib/actions';
import { dealReason, matchColumnShown, waitingState } from '../lib/dealReason';
import { matchWords } from '../lib/matchWords';
import { lookupNotice, lookupsStartedWords } from '../lib/lookups';
import { scanStrip } from '../lib/scanSteps';
import { count, percentOff, plural, when } from '../lib/format';
import { scanSpend } from '../lib/scanSpend';
import { dealMenu, type DealMenuId } from '../lib/menus';
import { SCREEN_KEYS } from '../lib/notices';
import { breakEvenOrder, incompleteLine } from '../lib/incomplete';
import { estimateRank } from '../lib/order';
import { sortRows, type SortState } from '../lib/sort';
import { oneLine } from '../lib/today';
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
    // One rule with Today and the popover: an estimate before fulfillment never outranks a full one of the same sign.
    case 'profit':
      return estimateRank(r, 'profit');
    case 'roi':
      return estimateRank(r, 'roi');
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

/** The line under a title: the agent's verdict as one short line (the whole sentence on hover), else the reason the columns do not say. */
function lineOf(r: DealRow, matchShown: boolean): { text: string; full: string } | null {
  // Checking the app's own work: a held deal says why first; the inspector has the links and his two answers.
  if (r.needsLook) {
    const look = `Needs a look: ${r.needsLook.sentence}`;
    return { text: oneLine(look), full: look };
  }
  const note = r.signalNote?.trim();
  if (note) return { text: oneLine(note), full: note };
  const reason = dealReason(r, { matchShown });
  return reason ? { text: reason, full: reason } : null;
}

/** The Deals table in the content and the open bundle in the inspector; the sidebar picks the view. */
export function DealsScreen({ openId, view }: { openId: string | null; view: DealView }) {
  const { navigate, state } = useApp();
  const ui = useUi();
  const [res, reload] = useResource(() => api.deals(), [], ['deals']);
  // Outcomes: the deals he recorded buying are marked Bought.
  const [outcomes] = useResource(() => api.outcomes(), [], ['deals']);
  const bought = useMemo(() => new Set((outcomes.data?.purchases ?? []).map((p) => p.dealId)), [outcomes.data]);
  const [sort, setSortState] = useState(readSort);
  const [section, setSection] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const table = useRef<TableHandle>(null);
  // The table's width decides whether the Match column shows, and so whether a row's reason line has anything to add.
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const matchShown = matchColumnShown(width);

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
    // Nov 23: rows with no figure keep this order: the bundles missing a price, smallest break-even first, then the rest.
    return sortRows(breakEvenOrder(shown), sort, sortValue);
  }, [inThisView, section, query, sort]);

  const close = useCallback(() => {
    const index = rows.findIndex((r) => r.id === openId);
    navigate({ screen: 'deals', id: null, view });
    // Focus goes back to the row that was open.
    requestAnimationFrame(() => table.current?.focusRow(Math.max(0, index)));
  }, [navigate, openId, rows, view]);

  const scanRunning = state?.agent.status === 'scanning';
  const scanLine = state ? scanStrip(state.agent) : null;
  const lookups = useMemo(() => lookupNotice(state, all), [state, all]);
  // What an action says it did, for a moment: "Copied PCL1600K2.", "Looking up 18 parts through Keepa." or why it could not.
  // One line at a time, in the status bar under the table; a failure stays until the next action.
  const [said, setSaid] = useState<{ tone: 'quiet' | 'attention'; text: string } | null>(null);
  useEffect(() => {
    if (!said || said.tone === 'attention') return;
    const t = setTimeout(() => setSaid(null), Math.max(4000, said.text.length * 90));
    return () => clearTimeout(t);
  }, [said]);
  const runLook = useAction(async (maxSearches: number, useReserve: boolean) => {
    const r = await api.runLookups(useReserve ? { maxSearches, useReserve } : { maxSearches });
    if (!r.started) throw new ApiError('refused', lookupsStartedWords(r));
    setSaid({ tone: 'quiet', text: lookupsStartedWords(r) });
  });
  const noticeItems: NoticeItem[] = [];
  if (lookups) {
    noticeItems.push({
      kind: 'lookups',
      key: 'lookups',
      tone: 'quiet',
      title: lookups.title,
      body: (
        <>
          {lookups.text}
          {lookups.action.reason ? (
            <span className="notice-more" id="lookups-reason">
              {lookups.action.reason}
            </span>
          ) : null}
          {runLook.error ? (
            <span className="notice-more" role="alert">
              {runLook.error}
            </span>
          ) : null}
        </>
      ),
      action: (
        <Button size="sm" busy={runLook.busy} busyLabel="Starting…" disabled={!lookups.action.enabled} cost={lookups.action.cost ?? undefined} title={lookups.action.reason ?? undefined} aria-describedby={lookups.action.reason ? 'lookups-reason' : undefined} onClick={() => void runLook.run(lookups.action.maxSearches, lookups.action.useReserve)}>
          {lookups.action.label}
        </Button>
      ),
    });
  }
  if (res.data?.staleDays) noticeItems.push({ kind: 'stale', key: 'stale', tone: 'quiet', body: `The oldest price here was seen ${plural(res.data.staleDays, 'day', 'days')} ago. A scan refreshes them.` });
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
      case 'bought':
        ui.openPurchase({ mode: 'new', dealId: r.id, title: r.title, model: r.model, price: r.price, estimate: r.profit });
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
            {bought.has(r.id) ? <Tag title="You recorded buying this deal. Open Bought to see what became of it.">Bought</Tag> : null}
            {r.needsLook ? (
              <Tag tone="attention" title={`Needs a look: ${r.needsLook.sentence} Never Buy now until you look. Open the deal to check the listing.`}>
                Needs a look
              </Tag>
            ) : null}
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
            {r.brand} · {r.setItems !== undefined ? <>Set · {r.setItems} items</> : <span className="code">{r.model}</span>}
          </span>
          {/* Only when it adds something the other columns do not say; a row without one is two lines. */}
          {lineOf(r, matchShown) ? (
            <span className="deal-reason" title={lineOf(r, matchShown)?.full}>
              {lineOf(r, matchShown)?.text}
            </span>
          ) : null}
        </div>
      ),
    },
    { key: 'price', label: 'Price', sortable: true, align: 'right', width: 'col-fig', hideBelow: 560, render: (r) => <Money value={r.price} /> },
    { key: 'off', label: 'Off', sortable: true, align: 'right', width: 'col-off', hideBelow: 900, render: (r) => <span className="fig">{percentOff(r.off)?.replace(' off', '') ?? '—'}</span> },
    {
      key: 'match',
      label: 'Amazon listings',
      sortable: true,
      natural: 'asc',
      width: 'col-match',
      hideBelow: 720,
      render: (r) =>
        waitingState(r) ? (
          <Tag title={(r.matchKind === 'waiting_page' && r.pageWait) || WAITING_WHY[r.matchKind ?? 'lookup']}>{waitingState(r)}</Tag>
        ) : r.needsAnswer ? (
          <Tag tone="attention">Needs your answer</Tag>
        ) : (
          <span className="cell-words" title={matchWords(r.matchState) ?? undefined}>
            {matchWords(r.matchState) ?? '—'}
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
          <RowProfit value={r.profit} before={r.beforeFulfillment} />
        ) : r.needsAnswer ? (
          // With the Match column hidden (a narrow list), the tag moves here so the row still says it.
          <span className="cell-flag">
            <span className="cell-none narrow-hide">—</span>
            <span className="narrow-show">
              <Tag tone="attention">Needs answer</Tag>
            </span>
          </span>
        ) : waitingState(r) ? (
          <span className="cell-flag">
            <span className="cell-none narrow-hide">—</span>
            <span className="narrow-show">
              <Tag>Waiting</Tag>
            </span>
          </span>
        ) : r.incomplete ? (
          // Nov 23: missing a price is no figure, never a loss; the reason line under the title says what it needs.
          <span className="cell-none" title={`No estimate: ${incompleteLine(r.incomplete)}.`}>
            —
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

  const csv = useAction(async (opts: { sort: DealSort }) => {
    try {
      await api.downloadDealsCsv(opts);
    } catch (e) {
      setSaid({ tone: 'attention', text: `The CSV was not saved. ${e instanceof Error ? e.message : ''}`.trim() });
    }
  });
  const title = view === 'all' ? 'Deals' : VIEW_LABEL[view];
  const sub = res.data ? `${plural(inThisView.length, 'bundle', 'bundles')}${res.data.at ? ` · updated ${when(res.data.at)}` : ''}` : undefined;
  const filtered = query.trim() !== '' || section !== 'all';

  const list = (
    <div className="deals" ref={frame}>
      {scanLine ? <ScanStrip text={scanLine} /> : null}
      <div className="list-scroll">
        {res.status === 'loading' ? <LoadingState label="Loading deals" /> : null}
        {res.status === 'error' ? <LoadError error={res.error} onRetry={reload} /> : null}
        {res.data && all.length === 0 ? (
          <EmptyState
            title="No deals yet"
            cause={`${state?.agent.lastScan ? 'The last scan found no discounted DEWALT or RYOBI bundles. The next scan looks again.' : 'The agent has not run a scan yet.'}${state ? ` ${scanSpend(state.budget).sentence}` : ''}`}
            action={
              <Button variant="primary" onClick={() => void api.scan()} disabled={!state?.keys.serpapi || scanRunning} cost={state ? scanSpend(state.budget).cost : undefined}>
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
      {rows.length > 0 || said ? (
        <p className="status-bar">
          {rows.length > 0 ? (
            <>
              <span>
                {filtered ? (
                  <>
                    <span className="fig">{count(rows.length)}</span> of <span className="fig">{count(inThisView.length)}</span>
                  </>
                ) : (
                  plural(rows.length, 'bundle', 'bundles')
                )}
              </span>
              {section !== 'all' ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    Section: {SECTION_LABEL[section]} <LinkButton onClick={() => setSection('all')}>Show all sections</LinkButton>
                  </span>
                </>
              ) : null}
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          {said ? (
            <span className={said.tone === 'attention' ? 'status-attention' : undefined} role={said.tone === 'attention' ? 'alert' : 'status'}>
              {said.text}
            </span>
          ) : (
            <span>Profit and ROI are estimates from your fee settings, not your real Amazon fees.</span>
          )}
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
      keys={SCREEN_KEYS.deals}
      notices={noticeItems}
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

/** What a waiting tag says on hover: why it waits and what moves it. */
const WAITING_WHY: Record<'lookup' | 'waiting_page' | 'waiting_parts', string> = {
  lookup: 'Its parts wait for an Amazon lookup. Keepa looks them up as its tokens refill; Look up now (above the table) spends searches.',
  waiting_page: 'Home Depot’s page for this bundle was not read. The app reads it at a slow pace, between scans and in the next scan; there is nothing to answer yet.',
  waiting_parts: 'Home Depot’s own pages for its parts are not read yet. A free read in the next scan settles what is inside; there is nothing to answer yet.',
};

const EMPTY_VIEW: Record<DealView, string> = {
  'buy-now': 'No watched bundle is worth buying now. A scan checks each one against your profit, ROI and monthly-sales numbers.',
  all: '',
  confirmed: 'No bundle has every part matched and priced yet.',
  'needs-answer': 'No bundle waits for one of your answers.',
  waiting: 'Every bundle’s parts have been looked up.',
  'missing-price': 'Every bundle with a price has every part priced.',
  losing: 'No bundle’s estimate is below zero.',
  watchlist: 'No bundle is watched yet. A bundle that is confirmed and discounted is watched by itself; star one to watch it yourself.',
};
