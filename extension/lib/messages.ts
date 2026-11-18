// Messages between the extension's pages and its service worker.
// The service worker is the only context that holds the key and talks to SerpApi.

import type { ProductPage } from '../../core/src/hdPage';
import type { PageView } from '../../core/src/scan/pageView';
import type { PaidAction, Quote, ReviewAnswer, ScanJob, ScanReport } from '../../core/src/scan/types';
import type { AccountInfo } from '../../core/src/serpapi/budget';
import type { ExtensionSettings } from '../../core/src/settings';

export type Request =
  | { type: 'getState' }
  /** Checks the key with the free Account API. The key is saved only when it works. */
  | { type: 'checkKey'; apiKey: string }
  | { type: 'forgetKey' }
  | { type: 'saveSettings'; settings: ExtensionSettings }
  | { type: 'scanNow' }
  | { type: 'stopScan' }
  /** Reply data: the ranked bundles as CSV text. */
  | { type: 'exportDeals' }
  /** Reply data: JSON text of every match and every answered review item. */
  | { type: 'exportMatches' }
  /** Empties the saved SerpApi responses. Nothing else is deleted. */
  | { type: 'clearSavedSearches' }
  /** Reply data: PanelReport. */
  | { type: 'getReport' }
  | { type: 'setPackaging'; model: string; packaging: Packaging }
  | { type: 'answerReview'; id: string; answer: ReviewAnswer }
  /** Opens again a split question the owner answered, so it can be answered again. Reply data: null. */
  | { type: 'reopenReview'; id: string }
  /** Reply data: Quote, what the action would spend now and why it may not run. Spends nothing. */
  | { type: 'quote'; action: PaidAction }
  /** Spends at most the quote's searches. Replies once the action has ended; a refusal or failure is one sentence. */
  | { type: 'runPaid'; action: PaidAction }
  /**
   * From the chip's content script, once per Home Depot product page and again after in-page navigation. Reply data: PageView.
   * The worker remembers the page for the sender's tab and shows it as a scan would (notePage); it never searches.
   * Reply data: PageSeenReply, which is `off` while the owner has the chip turned off (nothing is read or stored), and
   * `none` for a tab the extension itself opened to read a bundle page for a scan.
   */
  | { type: 'pageSeen'; page: ProductPage }
  /** From the chip's content script. Reply data: { opened }, false when Chrome refused to open the panel. */
  | { type: 'openThisPage' }
  /** Reply data: ThisPage, the page the tab last showed, rebuilt from the store with no search and no write. */
  | { type: 'getThisPage'; tabId: number }
  /**
   * From the panel, when it starts and when it hears showThisPage. Reply data: true once, if the chip opened the panel
   * for this tab and nobody has asked since; the answer is then consumed.
   */
  | { type: 'takeShowThisPage'; tabId: number };

export type { PaidAction, Quote, ReviewAnswer };

/** The messages a content script on a Home Depot page may send; everything else is for the extension's own pages. */
export const CONTENT_REQUESTS: readonly Request['type'][] = ['pageSeen', 'openThisPage'];

/** The reply to pageSeen: the page's view, or `off` when the owner turned the chip off in settings. */
export type PageSeenReply = PageView | { kind: 'off' };

/** A page's view when it is a bundle: what the chip shows and the This page tab lays out. */
export type BundleView = Extract<PageView, { kind: 'bundle' }>;

/** The reply to openThisPage: false when Chrome refused to open the side panel. */
export interface OpenThisPageReply {
  opened: boolean;
}

/** The messages a content script sends (CONTENT_REQUESTS). */
export type ContentRequest = Extract<Request, { type: 'pageSeen' | 'openThisPage' }>;

/** Sent by the worker to a tab's content script (chrome.tabs.sendMessage) when the owner turns the chip on or off. */
export interface ChipSetting {
  type: 'chipSetting';
  show: boolean;
}

/**
 * What the This page tab shows: the page's bundle; `empty` when that tab has no Home Depot product page seen; `off` when
 * the owner turned the chip off, which stops pages being read (the panel says so on a Home Depot product page).
 */
export type ThisPage = PageView | { kind: 'empty' } | { kind: 'off' };

export type { PageView, ProductPage };

export type Packaging = 'retail_boxed' | 'loose';

export interface PanelReport extends ScanReport {
  /** The owner's packaging answers by bundle model, upper case. A model not here is not answered. */
  packaging: Record<string, Packaging>;
}

export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export interface AppState {
  hasKey: boolean;
  account: AccountInfo | null;
  accountCheckedAt: number | null;
  /** One plain sentence when the last account check or scan start failed; null otherwise. */
  problem: string | null;
  settings: ExtensionSettings;
  scanRunning: boolean;
  lastJob: ScanJob | null;
  /** When the next scheduled scan is due; null in manual mode. */
  nextRunAt: number | null;
}

/** Sent to every extension page when the chip opened the side panel on This page. The panel then takes the answer for its tab. */
export interface ShowThisPage {
  type: 'showThisPage';
  tabId: number;
}

/** Sent to every extension page when AppState changes. */
export interface StateChanged {
  type: 'stateChanged';
  state: AppState;
}
