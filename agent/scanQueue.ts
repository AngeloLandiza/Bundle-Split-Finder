import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { agentDataDir } from './paths';

export type ScanPending = { id: string; requestedAt: string };

function queuePath(): string {
  return `${agentDataDir()}/scan-pending.json`;
}

export function requestScan(): ScanPending {
  const pending: ScanPending = { id: `scan-${Date.now()}`, requestedAt: new Date().toISOString() };
  mkdirSync(dirname(queuePath()), { recursive: true });
  writeFileSync(queuePath(), JSON.stringify(pending, null, 2));
  return pending;
}

export function takePendingScan(): ScanPending | null {
  const path = queuePath();
  if (!existsSync(path)) return null;
  try {
    const pending = JSON.parse(readFileSync(path, 'utf8')) as ScanPending;
    unlinkSync(path);
    return pending;
  } catch {
    return null;
  }
}

export function clearPendingScan(): void {
  const path = queuePath();
  if (existsSync(path)) unlinkSync(path);
}

export function peekPendingScan(): ScanPending | null {
  const path = queuePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ScanPending;
  } catch {
    return null;
  }
}