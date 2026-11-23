import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { BundleRow } from '../core/src/scan/types';

import { agentDataDir } from './paths';
import { mergeDealRowsFromPanel, type DealRow } from './dealsStore';

export type PanelSnapshot = {
  at: string;
  bundles: BundleRow[];
};

function panelPath(): string {
  return `${agentDataDir()}/deals-panel.json`;
}

type PanelBody = {
  kind?: string;
  bundles?: BundleRow[];
};

export function ingestPanelBody(body: unknown, at: string): PanelSnapshot | null {
  const panel = body as PanelBody;
  if (panel.kind !== 'split-finder-panel' || !Array.isArray(panel.bundles)) return null;
  const snap: PanelSnapshot = { at, bundles: panel.bundles };
  mkdirSync(dirname(panelPath()), { recursive: true });
  writeFileSync(panelPath(), JSON.stringify(snap, null, 2));
  return snap;
}

export function readPanelSnapshot(): PanelSnapshot | null {
  const path = panelPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PanelSnapshot;
  } catch {
    return null;
  }
}

export function readPanelBundle(key: string): BundleRow | null {
  const snap = readPanelSnapshot();
  return snap?.bundles.find((b) => b.key === key) ?? null;
}

/** Merges panel profit rows into audit deal rows when both exist. */
export function enrichedDealRows(base: DealRow[], reviewKeys?: Set<string>): DealRow[] {
  const panel = readPanelSnapshot();
  if (!panel) return base.map((row) => ({ ...row, needsReview: reviewKeys?.has(row.key) ?? false }));
  return mergeDealRowsFromPanel(base, panel.bundles, reviewKeys);
}