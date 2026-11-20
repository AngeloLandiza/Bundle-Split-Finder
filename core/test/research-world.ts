// Real data for the research agent's tests: the validation replay's questions and catalog
// (assist-world.ts), and Home Depot pages and searches recorded in the owner's Chrome on Nov 20
// (fixtures/homedepot-pages/research-2026-11-20.json), through the recorded tools of
// scripts/research-tools.ts. No network: a page or search with no recording answers 'not recorded'.


import { gatherEvidence } from '../src/assist/evidence';
import type { AssistEvidence } from '../src/assist/types';
import { bundleIdentity, ledgerFromEvidence, pageEntry, searchEntry } from '../src/research/ledger';
import type { CatalogEntry, ResearchLedgerEntry } from '../src/research/types';
import type { ReviewItem } from '../src/scan/types';
import { loadRecordedSources, type RecordedSources } from '../../scripts/research-tools';
import { asked, assistWorld, type AssistWorld } from './assist-world';

export const PCL500525SB = 'split:homedepot:328690510';

let sources: RecordedSources | null = null;
export function recorded(): RecordedSources {
  sources ??= loadRecordedSources('fixtures');
  return sources;
}

export async function catalogOf(w: AssistWorld): Promise<CatalogEntry[]> {
  return (await w.store.listCatalog()).map((c) => ({ brand: c.brand, model: c.model, title: c.title, kind: c.isKit ? 'kit' : 'part' }));
}

export interface ResearchCase {
  w: AssistWorld;
  q: ReviewItem;
  evidence: AssistEvidence;
  catalog: CatalogEntry[];
}

export async function researchCase(id: string): Promise<ResearchCase> {
  const w = await assistWorld();
  const q = asked(w, id);
  return { w, q, evidence: await gatherEvidence(w.store, q), catalog: await catalogOf(w) };
}

/**
 * The ledger a run on PCL500525SB would keep after reading the bundle's page and searching Home Depot
 * for "ryobi pcl500" and "ryobi jig saw tool only": every entry from a recording.
 */
export async function pcl500525sbLedger(): Promise<ResearchCase & { ledger: ResearchLedgerEntry[] }> {
  const c = await researchCase(PCL500525SB);
  const r = recorded();
  const page = r.pages.get('328690510')!;
  const ledger = [
    ...ledgerFromEvidence(c.evidence),
    pageEntry('hd-page:328690510', page, bundleIdentity(c.q), '328690510'),
    searchEntry('hd-search:1', r.searches.get('ryobi pcl500')!),
    searchEntry('hd-search:2', r.searches.get('ryobi jig saw tool only')!),
  ];
  return { ...c, ledger };
}

/** The search row line for a model, exactly as the ledger shows it. */
export function rowLine(ledger: ResearchLedgerEntry[], sourceId: string, model: string): string {
  const l = ledger.find((e) => e.id === sourceId)!.lines.find((x) => x.model === model);
  if (!l) throw new Error(`no row for ${model} in ${sourceId}`);
  return l.text;
}
