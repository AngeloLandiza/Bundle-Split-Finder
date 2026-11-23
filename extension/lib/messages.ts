// Messages between the extension's pages and its service worker.
// The service worker is the only context that holds the key and talks to SerpApi.

import type { StoredSuggestion } from '../../core/src/assist/stored';
import type { ProductPage } from '../../core/src/hdPage';
import type { PageView } from '../../core/src/scan/pageView';
import type { AskAllProgress, UnitRates } from '../../core/src/scan/pipeline';
import type { PaidAction, Quote, ReviewAnswer, ScanJob, ScanReport } from '../../core/src/scan/types';
import type { AccountInfo } from '../../core/src/serpapi/budget';
import type { ExtensionSettings } from '../../core/src/settings';

export type Request =
  | { type: 'getState' }
  /** Checks the key with the free Account API. The key is saved only when it works. */
  | { type: 'checkKey'; apiKey: string }
  | { type: 'forgetKey' }
  /** Step 10: asks eBay for a token with these keys (free); they are saved only when eBay gives one. Reply data: null. */
  | { type: 'saveEbayKeys'; appId: string; certId: string }
  | { type: 'forgetEbayKeys' }
  /** Step 10: saves the Anthropic key. It is not checked: a check is a call that costs money. Reply data: null. */
  | { type: 'saveAnthropicKey'; apiKey: string }
  | { type: 'forgetAnthropicKey' }
  | { type: 'saveKeepaKey'; apiKey: string }
  | { type: 'forgetKeepaKey' }
  | { type: 'saveRelayConfig'; url: string; secret: string }
  | { type: 'forgetRelayConfig' }
  /** Step 10: the judge model and the listings judged per scan. Reply data: null. */
  | { type: 'saveEbaySettings'; judgeModel: string; listingsJudgedPerScan: number }
  /** Step 10: the owner's Yes or No to an eBay listing question (core/src/scan/ebayAnswers.ts). Reply data: null. */
  | { type: 'answerEbay'; key: string; itemId: string; answer: 'yes' | 'no' }
  | { type: 'saveSettings'; settings: ExtensionSettings }
  | { type: 'scanNow' }
  | { type: 'stopScan' }
  /** Reply data: the ranked bundles as CSV text. */
  | { type: 'exportDeals' }
  /** Reply data: JSON text of every match and every answered review item. */
  | { type: 'exportMatches' }
  /** Reply data: JSON text of the audit file (bundles, parts, listings, matches, answers). Never the key or settings. */
  | { type: 'exportAudit' }
  /** Empties the saved SerpApi responses. Nothing else is deleted. */
  | { type: 'clearSavedSearches' }
  /**
   * Deletes every deal, match, answer, confirmed price and saved search. Keys, settings and the
   * search ledger stay. Refused while a scan, a Look up, a Verify, Ask AI or a kit-page read runs.
   */
  | { type: 'deleteAllData' }
  /** Reply data: PanelReport. */
  | { type: 'getReport' }
  | { type: 'setPackaging'; model: string; packaging: Packaging }
  /** A New price the owner has seen, with a link to the listing. The worker stamps the time. Reply data: null. */
  | { type: 'setConfirmedPrice'; brand: string; model: string; price: number; link: string }
  /** Drops that price. Reply data: null. */
  | { type: 'clearConfirmedPrice'; brand: string; model: string }
  /**
   * Reads one unread kit's Home Depot page in the browser and saves it where a scan would.
   * Spends no search. Reply data: null. A refusal is one sentence.
   */
  | { type: 'readKitPage'; brand: string; model: string }
  /**
   * `aiSuggestion: true` says an Ask AI suggestion for this question was on screen when the owner answered, so the
   * worker records whether the answer is the one suggested. Accept all never sends it, and no answer ever comes from a suggestion.
   */
  | { type: 'answerReview'; id: string; answer: ReviewAnswer; aiSuggestion?: true }
  /**
   * Step 11, Ask AI: one question's evidence (stored by the scan, nothing fetched) goes to the owner's Anthropic model, which
   * drafts an answer the owner may approve. Spends no search; costs a model call. Refused while a scan runs and with no key.
   * Reply data: StoredSuggestion. It is saved as a suggestion and never as the question's answer.
   */
  | { type: 'askAi'; questionId: string }
  /**
   * Step 12: Ask AI about every open question that can be asked and has no suggestion, one at a time, in the background. Replies at
   * once, `{ queued }`; progress and the end are in AppState (`askAll`, `askAllResult`). Refused while a scan runs, with no key, and
   * with nothing to ask. A scan is refused while it runs. Spends no search; each call costs the owner's model.
   */
  | { type: 'askAiAll' }
  /** Step 12: cancels the queue: the call in flight ends and writes nothing. Nothing running is no error. Reply data: null. */
  | { type: 'stopAskAll' }
  /** Step 12: Settings › Listing check › "Ask AI after each scan". Reply data: null. */
  | { type: 'saveAskAfterScan'; on: boolean }
  /** Opens again a split question the owner answered, so it can be answered again. Reply data: null. */
  | { type: 'reopenReview'; id: string }
  /** Reply data: Quote, what the action would spend now and why it may not run. Spends nothing. */
  | { type: 'quote'; action: PaidAction }
  /** Spends at most the quote's searches. Replies once the action has ended; a refusal or failure is one sentence. */
  | { type: 'runPaid'; action: PaidAction }
  /**
   * From the chip's content script, once per Home Depot product page and again after in-page navigation.
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
  /** Step 11: the Ask AI suggestion to show for each open question that has one (made for the question as it is now). Absent in a report built before it. */
  aiSuggestions?: StoredSuggestion[];
}

export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** Step 10: what Settings shows of the eBay keys, the Anthropic key and the judge's settings. The keys themselves never leave the worker. */
export interface EbayState {
  hasEbayKeys: boolean;
  hasAnthropicKey: boolean;
  judgeModel: string;
  listingsJudgedPerScan: number;
}

export interface KeepaState {
  hasKeepaKey: boolean;
  tokensPerScan: number;
  reserve: number;
  discoveryMode: ExtensionSettings['discoveryMode'];
  trackingDepth: ExtensionSettings['trackingDepth'];
  /** Last Keepa response balance, if the key has been used this browser. */
  tokensLeft: number | null;
  refillIn: number | null;
}

/** How the last Ask AI about all ended: what it did and what it cost. Kept until the next one starts. */
export interface AskAllResult {
  /** Questions in the queue when it began. */
  total: number;
  /** Questions it made a call for that said something or cost something. Not one with nothing to ask, a failed call, or a question it skipped. */
  asked: number;
  /** Of those, how many left something to show (not a failed call). */
  suggested: number;
  /** Of those, how many are verified: the ones Approve all offers. */
  verified: number;
  /** Dollars the questions cost, at the model's rates. */
  costUsd: number;
  /** Stop was pressed (or the key was removed) before the end. */
  stopped: boolean;
  /** One plain sentence when the queue gave up on repeated failures of the call; null otherwise. */
  problem: string | null;
  /** The queue stopped because what it had cost passed twice the estimate its button showed. */
  overspent: boolean;
}

export interface RelayState {
  hasRelayConfig: boolean;
}

export interface AppState {
  hasKey: boolean;
  /** Step 10. Absent in a state built before it (tests): it reads as no keys and the default settings. */
  ebay?: EbayState;
  keepa?: KeepaState;
  relay?: RelayState;
  account: AccountInfo | null;
  accountCheckedAt: number | null;
  /** One plain sentence when the last account check or scan start failed; null otherwise. */
  problem: string | null;
  settings: ExtensionSettings;
  scanRunning: boolean;
  lastJob: ScanJob | null;
  /** When the next scheduled scan is due; null in manual mode. */
  nextRunAt: number | null;
  /** Step 11: how long a unit of each kind took in recent scans (the progress estimate's rates). Absent: seeds only. */
  rates?: UnitRates;
  /** Step 12: the Ask AI about all queue, while it runs; absent otherwise. */
  askAll?: AskAllProgress | null;
  /** Step 12: how the last queue ended; absent before the first. */
  askAllResult?: AskAllResult | null;
  /** Step 12: whether a finished scan is followed by Ask AI about all. Absent in a state built before it: off. */
  askAfterScan?: boolean;
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
