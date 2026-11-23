import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { PaidAction } from '../core/src/scan/types';

import { agentDataDir } from './paths';

export type QueuedPaid = {
  action: PaidAction;
  queuedAt: string;
};

function queuePath(): string {
  return `${agentDataDir()}/paid-queue.json`;
}

export function enqueuePaid(action: PaidAction): QueuedPaid {
  const list = readPaidQueue();
  const item: QueuedPaid = { action, queuedAt: new Date().toISOString() };
  list.push(item);
  mkdirSync(dirname(queuePath()), { recursive: true });
  writeFileSync(queuePath(), JSON.stringify(list, null, 2));
  return item;
}

export function readPaidQueue(): QueuedPaid[] {
  const path = queuePath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(raw) ? (raw as QueuedPaid[]) : [];
  } catch {
    return [];
  }
}

export function clearPaidQueue(): void {
  const path = queuePath();
  if (existsSync(path)) unlinkSync(path);
}