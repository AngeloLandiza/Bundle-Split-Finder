import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { StoredSuggestion } from '../core/src/assist/stored';
import type { BundleRow, EbayQuestion, ReviewItem } from '../core/src/scan/types';
import { waitingParts } from '../core/src/deals/waiting';
import { matchState } from '../core/src/scan/matchState';

import { agentDataDir } from './paths';

export type DealRow = {
  key: string;
  brand: string;
  model: string;
  title: string;
  section: string;
  itemId: number | null;
  price?: number | null;
  percentOff?: number | null;
  /** Estimated profit in dollars (fee settings, not real fees). */
  profit?: number | null;
  roi?: number | null;
  roiLowest?: number | null;
  roiHighest?: number | null;
  /** Row subtitle from the same rules as the helper Deals list. */
  matchLine?: string | null;
  needsReview?: boolean;
  /** Parts this row's Look up would search for (from panel). */
  lookupParts?: Array<{ brand: string; model: string }>;
};

export type ReviewRow = {
  id: string;
  kind: string;
  bundleKey: string | null;
};

export type DealsSnapshot = {
  at: string;
  bundles: DealRow[];
  reviewOpen: ReviewRow[];
  openQuestions: ReviewItem[];
  openEbayQuestions: EbayQuestion[];
  aiSuggestions: StoredSuggestion[];
};

function snapshotPath(): string {
  return `${agentDataDir()}/deals-snapshot.json`;
}

type AuditBody = {
  kind?: string;
  bundles?: Array<{
    key: string;
    brand: string;
    model: string;
    title: string;
    section: string;
    itemId?: number;
  }>;
  questions?: ReviewItem[];
  ebayQuestions?: EbayQuestion[];
  aiSuggestions?: StoredSuggestion[];
};

export function ingestAuditBody(body: unknown, at: string): DealsSnapshot | null {
  const audit = body as AuditBody;
  if (audit.kind !== 'split-finder-audit' || !Array.isArray(audit.bundles)) return null;
  const bundles: DealRow[] = audit.bundles.map((b) => ({
    key: b.key,
    brand: b.brand,
    model: b.model,
    title: b.title,
    section: b.section,
    itemId: typeof b.itemId === 'number' ? b.itemId : null,
  }));
  const openQuestions = (audit.questions ?? []).filter(
    (q): q is ReviewItem => typeof q === 'object' && q !== null && typeof (q as ReviewItem).id === 'string',
  );
  const reviewOpen: ReviewRow[] = openQuestions.map((q) => ({
    id: q.id,
    kind: q.kind,
    bundleKey: q.kind === 'split' ? q.subject : q.subject,
  }));
  const openEbayQuestions = (audit.ebayQuestions ?? []).filter(
    (q): q is EbayQuestion => typeof q === 'object' && q !== null && typeof (q as EbayQuestion).id === 'string',
  );
  const aiSuggestions = (audit.aiSuggestions ?? []).filter(
    (s): s is StoredSuggestion =>
      typeof s === 'object' && s !== null && typeof (s as StoredSuggestion).questionId === 'string',
  );
  const snap: DealsSnapshot = { at, bundles, reviewOpen, openQuestions, openEbayQuestions, aiSuggestions };
  mkdirSync(dirname(snapshotPath()), { recursive: true });
  writeFileSync(snapshotPath(), JSON.stringify(snap, null, 2));
  return snap;
}

export function mergeDealRowsFromPanel(
  base: DealRow[],
  panel: BundleRow[],
  reviewKeys?: Set<string>,
): DealRow[] {
  const byKey = new Map(panel.map((b) => [b.key, b]));
  return base.map((row) => {
    const full = byKey.get(row.key);
    if (!full) {
      return { ...row, needsReview: reviewKeys?.has(row.key) ?? false };
    }
    return {
      ...row,
      section: full.section,
      price: full.price,
      percentOff: full.percentOff,
      profit: full.estimate?.profit ?? null,
      roi: full.estimate?.roi ?? null,
      roiLowest: full.range.lowest?.roi ?? null,
      roiHighest: full.range.highest?.roi ?? null,
      matchLine: matchState(full),
      needsReview: reviewKeys?.has(row.key) ?? false,
      lookupParts: (() => {
        const parts = waitingParts(full);
        return parts.length ? parts : undefined;
      })(),
    };
  });
}

export function readDealsSnapshot(): DealsSnapshot | null {
  const path = snapshotPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as DealsSnapshot;
    return { ...raw, openEbayQuestions: raw.openEbayQuestions ?? [], aiSuggestions: raw.aiSuggestions ?? [] };
  } catch {
    return null;
  }
}