// Messages between the extension's pages and its service worker.
// The service worker is the only context that holds the key and talks to SerpApi.

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
  /** Reply data: Quote. */
  | { type: 'quote'; action: PaidAction }
  | { type: 'runPaid'; action: PaidAction };

export type { PaidAction, Quote, ReviewAnswer };

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

/** Sent to every extension page when AppState changes. */
export interface StateChanged {
  type: 'stateChanged';
  state: AppState;
}
