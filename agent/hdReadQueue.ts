import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { agentDataDir } from './paths';

export type HdReadPending = { id: string; itemIds: number[]; requestedAt: string };

function pendingPath(): string {
  return `${agentDataDir()}/hd-read-pending.json`;
}

function resultPath(id: string): string {
  return `${agentDataDir()}/hd-read-results/${id}.json`;
}

export function requestHdRead(itemIds: number[]): HdReadPending | null {
  const ids = [...new Set(itemIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return null;
  const pending: HdReadPending = { id: `hd-${Date.now()}`, itemIds: ids, requestedAt: new Date().toISOString() };
  mkdirSync(dirname(pendingPath()), { recursive: true });
  writeFileSync(pendingPath(), JSON.stringify(pending, null, 2));
  return pending;
}

export function peekHdReadPending(): HdReadPending | null {
  const path = pendingPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HdReadPending;
  } catch {
    return null;
  }
}

export function clearHdReadPending(): void {
  const path = pendingPath();
  if (existsSync(path)) unlinkSync(path);
}

export function storeHdReadResult(id: string, outcomes: unknown): void {
  const path = resultPath(id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ id, at: new Date().toISOString(), outcomes }, null, 2));
}

export function readHdReadResult(id: string): unknown | null {
  const path = resultPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}