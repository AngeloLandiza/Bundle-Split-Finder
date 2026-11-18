// The This page tab (step 7; mockup InPage.dc.html): the Home Depot bundle page open in the active tab, split and priced
// from what is saved, with no search. It reuses Detail's part blocks and Copy ASINs and the Review question; "Open full
// detail" opens Detail for the same bundle.

import { useEffect, useState } from 'react';
import { reviewSignature } from '@core/scan/answers';
import type { PartRow, ReviewAnswer } from '@core/scan/types';
import { money, profit, roi } from '../../lib/format';
import type { AppState, PageView, PanelReport, ThisPage } from '../../lib/messages';
import { type ActiveTab, UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { waitingParts } from './dealsModel';
import { feeText, noEstimate, Part, RangeLine } from './Detail';
import { ReviewQuestion } from './ReviewQuestion';
import { useCopyAsins } from './useCopyAsins';
import './Detail.css';
import './ReviewTab.css';
import './ThisPageTab.css';

export const NO_PAGE = 'Open a Home Depot bundle page to see it here.';
export const CHIP_OFF = 'The chip is off. Turn it on in settings to read this page.';
/**
 * A question the worker has not saved yet (a scan, a Look up or a Verify holds the write back) cannot be answered. The
 * sentence names what is running: the panel knows of a scan; any other write held back is a Look up or Verify.
 */
export const SAVED_LATER_SCAN = 'Saved when the scan ends.';
export const SAVED_LATER_SEARCH = 'Saved when the search ends.';

const sameTab = (a: ActiveTab | null, b: ActiveTab | null): boolean => a === b || (a !== null && b !== null && a.id === b.id && a.url === b.url);

/** The active tab of the panel's window, kept up to date as the owner switches tabs and pages change. Null without tabs to follow. */
export function useActiveTab(api: WorkerApi): ActiveTab | null {
  const [tab, setTab] = useState<ActiveTab | null>(null);
  useEffect(() => {
    const tabs = api.tabs;
    if (!tabs) return;
    let live = true;
    const read = () => {
      tabs
        .active()
        .then((t) => {
          if (live) setTab((prev) => (sameTab(prev, t) ? prev : t));
        })
        .catch(() => {});
    };
    read();
    const stop = tabs.onChanged(read);
    return () => {
      live = false;
      stop();
    };
  }, [api]);
  return tab;
}

/** The item id in a Home Depot product page's address (/p/<name>/<item id>), or null for any other address. */
export function itemIdOfUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    return /^\/p\/(?:.*\/)?(\d+)\/?$/.exec(new URL(url).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface ThisPageTabProps {
  api: WorkerApi;
  report: PanelReport | null;
  state: AppState;
  /** The active tab; null when there is none to follow. */
  tab: ActiveTab | null;
  /** Opens Detail for a bundle. */
  onOpenDetail: (bundleKey: string) => void;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function Bundle({ view, report, state, api, onOpenDetail }: { view: Extract<PageView, { kind: 'bundle' }>; report: PanelReport | null; state: AppState; api: WorkerApi; onOpenDetail: (key: string) => void }) {
  const { row, question } = view;
  const e = row.estimate;
  const waiting = waitingParts(row).length;
  const { asins, copy, copied, copyFailed } = useCopyAsins(row);
  // Detail reads the report; a bundle a scan has not let the worker store yet is not in it, and is when the scan has ended.
  const inReport = report?.bundles.some((b) => b.key === view.key) ?? false;
  const now = Date.now();

  const answer = async (a: ReviewAnswer): Promise<string | null> => {
    if (!question) return null;
    try {
      const reply = await api.send({ type: 'answerReview', id: question.id, answer: a });
      return reply.ok ? null : reply.error;
    } catch {
      return UNREACHABLE;
    }
  };

  return (
    <div className="thispage">
      <section className="detail-headline thispage-headline" aria-label="Estimate">
        <div className="thispage-read">
          <span className="figure fig-sm">{row.model}</span>
          <span>read from this page · no search used</span>
        </div>
        {e ? (
          <>
            <div className="thispage-estimate-label">Est. profit</div>
            <div className="detail-profit-line" data-loss={e.profit < 0 ? 'true' : undefined}>
              <div className="detail-profit">{profit(e.profit)}</div>
              <div className="detail-roi">ROI {roi(e.roi)}</div>
            </div>
            <div className="thispage-cost">
              Costs <span className="figure fig-sm">{money(e.cost)}</span> · parts net <span className="figure fig-sm">{money(e.netRevenue)}</span> after fees
            </div>
            <p className="detail-estimate">Estimate from your fee settings ({feeText(state.settings.fees)}).</p>
            <RangeLine row={row} />
          </>
        ) : question ? (
          <p className="detail-noestimate">{noEstimate(row)}</p>
        ) : waiting > 0 ? (
          <p className="detail-noestimate">
            No estimate yet: {plural(waiting, 'part still needs', 'parts still need')} an Amazon lookup. Open full detail to look {waiting === 1 ? 'it' : 'them'} up.
          </p>
        ) : (
          <p className="detail-noestimate">{noEstimate(row)}</p>
        )}
      </section>

      {question ? (
        <ReviewQuestion key={`${question.id}|${reviewSignature(question)}`} item={question} scanRunning={state.scanRunning} blocked={view.questionStored ? null : state.scanRunning ? SAVED_LATER_SCAN : SAVED_LATER_SEARCH} onSave={answer} compact />
      ) : null}

      {row.parts.length > 0 ? (
        <>
          <h2 className="detail-label">PARTS · {row.parts.length}</h2>
          <ul className="detail-parts">
            {row.parts.map((p: PartRow) => (
              <Part key={p.model} part={p} row={row} fees={state.settings.fees} now={now} />
            ))}
          </ul>
        </>
      ) : null}

      <div className="thispage-actions">
        <button type="button" className="detail-copy" data-key={view.key} disabled={!inReport} onClick={() => onOpenDetail(view.key)}>
          Open full detail
        </button>
        <button type="button" className="detail-btn thispage-copy" disabled={asins.length === 0} onClick={copy}>
          {asins.length === 2 ? 'Copy both ASINs' : 'Copy ASINs'}
        </button>
      </div>
      {!inReport ? <p className="detail-estimate thispage-note">Full detail opens when the scan has ended and this bundle is saved.</p> : null}
      <p role="status" className="detail-copied thispage-note">
        {copied ?? ''}
      </p>
      {copyFailed ? (
        <p role="alert" className="detail-copied thispage-note">
          Could not copy. Select the ASINs by hand.
        </p>
      ) : null}
    </div>
  );
}

export function ThisPageTab({ api, report, state, tab, onOpenDetail }: ThisPageTabProps) {
  // The last reply, with the tab it was for: another tab's page is never shown while this one's is read.
  const [read, setRead] = useState<{ tabId: number; view: ThisPage } | { tabId: number; error: string } | null>(null);

  useEffect(() => {
    if (!tab) return;
    let live = true;
    api
      .send<ThisPage>({ type: 'getThisPage', tabId: tab.id })
      .then((reply) => {
        if (live) setRead(reply.ok ? { tabId: tab.id, view: reply.data } : { tabId: tab.id, error: reply.error });
      })
      .catch(() => {
        if (live) setRead({ tabId: tab.id, error: UNREACHABLE });
      });
    return () => {
      live = false;
    };
  }, [api, tab?.id, tab?.url, state]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tab) return <p className="thispage-empty">{NO_PAGE}</p>;
  if (read === null || read.tabId !== tab.id) return null;
  if ('error' in read) return <p className="thispage-empty" role="alert">{read.error}</p>;
  const view = read.view;
  // The owner turned the chip off, which stops pages being read: on a product page, say so rather than "open a page".
  if (view.kind === 'off') return <p className="thispage-empty">{itemIdOfUrl(tab.url) !== null ? CHIP_OFF : NO_PAGE}</p>;
  // The tab has moved on to another address (a page the chip does not read) and nothing has said so yet.
  const addressed = itemIdOfUrl(tab.url);
  if (view.kind !== 'bundle' || (tab.url !== null && addressed !== view.itemId)) return <p className="thispage-empty">{NO_PAGE}</p>;
  return <Bundle view={view} report={report} state={state} api={api} onOpenDetail={onOpenDetail} />;
}
