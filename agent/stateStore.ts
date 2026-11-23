import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ScanJob } from '../core/src/scan/types';

import { agentDataDir } from './paths';

export type HelperLastJob = Pick<
  ScanJob,
  'status' | 'stopReason' | 'stopMessage' | 'searchesUsed' | 'finishedAt' | 'deferred' | 'ebayNotice'
>;

/** Sanitized helper state for the app footer (no keys). */
export type HelperStateSnapshot = {
  at: string;
  hasKey: boolean;
  hasAnthropicKey: boolean;
  scanRunning: boolean;
  askAiAllRunning: boolean;
  searchesLeft: number | null;
  searchesPerMonth: number | null;
  keepaTokensLeft: number | null;
  keepaRefillMin: number | null;
  searchesPerScan: number;
  rateLimitPerHour: number | null;
  lastJob: HelperLastJob | null;
};

function statePath(): string {
  return `${agentDataDir()}/helper-state.json`;
}

export function writeHelperState(body: Omit<HelperStateSnapshot, 'at'>): HelperStateSnapshot {
  const snap: HelperStateSnapshot = { ...body, at: new Date().toISOString() };
  mkdirSync(dirname(statePath()), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(snap, null, 2));
  return snap;
}

export function readHelperState(): HelperStateSnapshot | null {
  const path = statePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HelperStateSnapshot;
  } catch {
    return null;
  }
}