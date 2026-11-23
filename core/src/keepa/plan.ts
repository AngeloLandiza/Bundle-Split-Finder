// Split a Keepa token allowance between discovery (search, new parts) and tracking (known ASINs).

import { KEEPA_LOOKUP_TOKEN_ESTIMATE, productTokenEstimate } from './estimates';
import type { KeepaTrackingDepth } from './types';
import { planScan, type ScanPlan, type ScanRequest } from '../scanPlan';

export type DiscoveryMode = 'auto' | 'discovery_heavy' | 'tracking_heavy';

export interface KeepaScaleSettings {
  tokensPerRun: number;
  discoveryShare: number;
  reserve: number;
  mode: DiscoveryMode;
  /** Last known account balance; when set, the cap respects reserve headroom. */
  tokensLeft?: number | null;
  trackingDepth?: KeepaTrackingDepth;
}

export interface KeepaWorkRequest {
  /** SerpApi-style pending lookups (still discovery on Amazon until Keepa search ships). */
  pendingLookups: string[];
  staleRefreshes: string[];
  /** Rows of open discovery work for auto scale (plan §4.1). */
  openDiscoveryWork: number;
  totalWork: number;
}

export interface KeepaRunPlan {
  discoveryTokens: number;
  trackingTokens: number;
  refreshes: string[];
  deferredRefreshes: string[];
  lookups: string[];
  deferredLookups: string[];
}

/** Last planned Keepa split for this scan (extension footer, agent dashboard). */
export type KeepaPlanSummary = Pick<KeepaRunPlan, 'discoveryTokens' | 'trackingTokens'> & {
  lookups: number;
  refreshes: number;
};

const MIN_SHARE = 10;
const MAX_SHARE = 90;
const BASE_AUTO = 40;

/** Auto discovery share (percent of cap) from how much discovery work is still open. */
export function autoDiscoveryShare(open: number, total: number, mode: DiscoveryMode): number {
  if (mode === 'discovery_heavy') return MAX_SHARE;
  if (mode === 'tracking_heavy') return MIN_SHARE;
  if (total <= 0) return open > 0 ? MAX_SHARE : MIN_SHARE;
  const ratio = open / total;
  return Math.round(Math.min(MAX_SHARE, Math.max(MIN_SHARE, BASE_AUTO + ratio * (100 - BASE_AUTO))));
}

/**
 * Map Keepa tokens onto refresh batches first (tracking), then reserve discovery slice for future
 * Keepa search steps. SerpApi still owns HD pages and amazon text search until Phase 1b.
 */
function spendableCap(settings: KeepaScaleSettings): number {
  const runCap = Math.max(0, Math.floor(settings.tokensPerRun));
  if (settings.tokensLeft == null || !Number.isFinite(settings.tokensLeft)) return runCap;
  const headroom = Math.max(0, settings.tokensLeft - Math.max(0, Math.floor(settings.reserve)));
  return Math.min(runCap, headroom);
}

/** Greedy refresh list that respects per-ASIN token estimates (tracking depth). */
function planRefreshes(keys: string[], tokenBudget: number, depth?: KeepaTrackingDepth): { refreshes: string[]; spent: number } {
  let left = tokenBudget;
  const refreshes: string[] = [];
  for (const k of keys) {
    const cost = productTokenEstimate(depth, 1);
    if (left < cost) break;
    left -= cost;
    refreshes.push(k);
  }
  return { refreshes, spent: tokenBudget - left };
}

export function planKeepaRun(settings: KeepaScaleSettings, req: KeepaWorkRequest): KeepaRunPlan {
  const cap = spendableCap(settings);
  const share = settings.mode === 'discovery_heavy'
    ? MAX_SHARE
    : settings.mode === 'tracking_heavy'
      ? MIN_SHARE
      : Math.min(
          settings.discoveryShare,
          autoDiscoveryShare(req.openDiscoveryWork, req.totalWork, 'auto'),
        );
  let discoveryBudget = Math.floor((cap * share) / 100);
  let trackingBudget = Math.max(0, cap - discoveryBudget);
  // Runtime identify steps after lookup (not in pendingLookups) still spend discovery tokens.
  const identifyAllowance = Math.min(discoveryBudget, productTokenEstimate(settings.trackingDepth, 1));
  discoveryBudget = Math.max(0, discoveryBudget - identifyAllowance);

  const { refreshes, spent: refreshSpent } = planRefreshes(req.staleRefreshes, trackingBudget, settings.trackingDepth);
  const deferredRefreshes = req.staleRefreshes.slice(refreshes.length);
  if (refreshSpent < trackingBudget) {
    discoveryBudget += trackingBudget - refreshSpent;
  }

  const lookupSlots = Math.floor(discoveryBudget / KEEPA_LOOKUP_TOKEN_ESTIMATE);
  const lookups = req.pendingLookups.slice(0, lookupSlots);
  const deferredLookups = req.pendingLookups.slice(lookups.length);

  return { discoveryTokens: discoveryBudget, trackingTokens: trackingBudget, refreshes, deferredRefreshes, lookups, deferredLookups };
}

export type KeepaItemStepKind = 'lookup' | 'identify' | 'refresh';

/** Kit-item steps under the discovery/tracking slices left after part lookups/refreshes. */
export function planKeepaItemKeys(
  itemKeys: string[],
  stepKind: (key: string) => KeepaItemStepKind | undefined,
  discoveryLeft: number,
  trackingLeft: number,
  trackingDepth?: KeepaTrackingDepth,
): { planned: string[]; deferred: string[] } {
  let disc = Math.max(0, discoveryLeft);
  let track = Math.max(0, trackingLeft);
  const planned: string[] = [];
  const deferred: string[] = [];
  for (const key of itemKeys) {
    const kind = stepKind(key);
    if (kind === 'lookup') {
      if (disc >= KEEPA_LOOKUP_TOKEN_ESTIMATE) {
        disc -= KEEPA_LOOKUP_TOKEN_ESTIMATE;
        planned.push(key);
      } else deferred.push(key);
    } else if (kind === 'identify') {
      const cost = productTokenEstimate(trackingDepth, 1);
      if (disc >= cost) {
        disc -= cost;
        planned.push(key);
      } else deferred.push(key);
    } else if (kind === 'refresh') {
      const cost = productTokenEstimate(trackingDepth, 1);
      if (track >= cost) {
        track -= cost;
        planned.push(key);
      } else deferred.push(key);
    } else deferred.push(key);
  }
  return { planned, deferred };
}

/** SerpApi search allocation unchanged; Keepa plan runs in parallel on token counts. */
export function planScanWithKeepa(
  serpSpendable: number,
  scanReq: ScanRequest,
  keepa: KeepaScaleSettings,
  keepaReq: KeepaWorkRequest,
): { serp: ScanPlan; keepa: KeepaRunPlan } {
  return { serp: planScan(serpSpendable, scanReq), keepa: planKeepaRun(keepa, keepaReq) };
}