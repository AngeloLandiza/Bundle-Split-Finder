// npm run audit: turn a real scan into a scored audit, and keep every labelled pair as a test.
//
//   prepare <export.json> [--out <dir>]
//              reads the extension's audit export (Settings, Your data, Export for audit) and writes
//              <dir>/blind.json, for a blind checker (docs/audit-checker.md), and <dir>/tool.json, the
//              tool's choices, which the checker never sees. <dir> is audit/<date of the export>.
//   score <dir>
//              reads <dir>/labels.json (the checker's labels, the validation labels format), writes
//              <dir>/failures.md, and adds every labelled (part, listing) pair to fixtures/audit/corpus.json,
//              which core/test/match-corpus.test.ts runs through the matcher on every npm test.
//   seed-validation
//              adds the validation set's labelled pairs (fixtures/validation) to the corpus.
//
// Nothing here sends a search, opens a client or reads the key: an audit works only from files.
// The grade of a pair is the matcher's own, the one a scan gives a search row (corpusGrade).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { Catalog } from '../core/src/decompose';
import { type Candidate, grade, type Graded, titleHasModel } from '../core/src/match';
import { wantedFor } from '../core/src/scan/classify';
import { knownModels } from '../core/src/scan/runner';
import { type ListingRecord, type MatchRecord, partKey, type ReviewItem } from '../core/src/scan/types';
import { parseAmazonSearch } from '../core/src/serpapi/parsers';
import {
  buildResults, CacheOnlyClient, type Labels, loadInputs, type PartLabel, readLabels, ResponsesCache, runValidationPipeline, VALIDATION_DATE, validationFiles,
} from './validate-cli';

// ---------------------------------------------------------------- the export (Task 1's contract)

export interface AuditPart {
  brand: string;
  model: string;
  qty: number;
  asin: string | null;
  grade: string | null;
  source: string | null;
  /**
   * Added to version 1 in step 8c fix round 1 (older files lack it): whether the scan asks for this part as a kit
   * (wantedFor's catalog). Absent: the pair is graded as for a part the catalog does not know.
   */
  isKit?: boolean;
}

export interface AuditBundle {
  key: string;
  itemId: string;
  brand: string;
  model: string;
  title: string;
  section: string;
  split: string[] | null;
  /** The report's rows for the primary way to sell. */
  parts: AuditPart[];
}

export interface AuditExport {
  kind: 'split-finder-audit';
  version: 1;
  exportedAt: number;
  bundles: AuditBundle[];
  listings: ListingRecord[];
  matches: MatchRecord[];
  answers: ReviewItem[];
  /** The open review items (answer null), as stored. Added to version 1 in fix round 1; older files lack it. */
  questions?: ReviewItem[];
}

/** A problem with the export file: nothing was written. */
export class ExportRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportRefused';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const FORBIDDEN_KEY = /api_?key|apikey|^settings$/i;

/** The first property name, at any depth, that would carry the key or the settings; null when none does. */
function forbiddenProperty(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const x of v) {
      const found = forbiddenProperty(x);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(v)) return null;
  for (const [k, x] of Object.entries(v)) {
    if (FORBIDDEN_KEY.test(k)) return k;
    const found = forbiddenProperty(x);
    if (found) return found;
  }
  return null;
}

/** Reads and checks an audit export. Refuses (ExportRefused) one that names the key or the settings, or is not the contract's shape. */
export function readExport(text: string): AuditExport {
  if (/api_key/i.test(text)) throw new ExportRefused('The export names api_key. An audit export never carries the key; nothing was written.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ExportRefused('The export is not JSON.');
  }
  if (!isObject(raw) || raw.kind !== 'split-finder-audit') throw new ExportRefused('Not an audit export: kind is not "split-finder-audit".');
  if (raw.version !== 1) throw new ExportRefused(`Audit export version ${String(raw.version)} is not supported (version 1 is).`);
  const bad = forbiddenProperty(raw);
  if (bad) throw new ExportRefused(`The export has a "${bad}" field. An audit export never carries the key or the settings; nothing was written.`);
  if (typeof raw.exportedAt !== 'number') throw new ExportRefused('The export has no exportedAt time.');
  for (const field of ['bundles', 'listings', 'matches', 'answers'] as const) {
    if (!Array.isArray(raw[field])) throw new ExportRefused(`The export has no ${field} list.`);
  }
  if (raw.questions !== undefined && !Array.isArray(raw.questions)) throw new ExportRefused('The export has a questions field that is not a list.');
  for (const b of raw.bundles as unknown[]) {
    if (!isObject(b) || !isText(b.itemId) || !isText(b.brand) || !isText(b.model) || !Array.isArray(b.parts)) {
      throw new ExportRefused('A bundle in the export needs itemId, brand, model and parts.');
    }
    for (const p of b.parts as unknown[]) {
      if (!isObject(p) || !isText(p.brand) || !isText(p.model) || !(p.asin === null || isText(p.asin))) {
        throw new ExportRefused(`A part of bundle ${b.model} needs brand, model and asin (or null).`);
      }
    }
  }
  for (const l of raw.listings as unknown[]) {
    if (!isObject(l) || !isText(l.asin) || typeof l.title !== 'string') throw new ExportRefused('A listing in the export needs asin and title.');
  }
  return raw as unknown as AuditExport;
}

// ---------------------------------------------------------------- prepare

/** A listing as the blind checker sees it: never its grade, never whether the tool chose it. */
export interface BlindCandidate {
  asin: string;
  /** Null when the export holds no title for it (a chosen listing that is not among the saved listings). */
  title: string | null;
  /** Amazon's brand field; null when the export does not say. */
  brand: string | null;
  price: number | null;
  reviews: number | null;
  link: string;
}

export interface BlindPart {
  model: string;
  qty: number;
  candidates: BlindCandidate[];
}

export interface BlindBundle {
  itemId: string;
  brand: string;
  model: string;
  title: string;
  link: string;
  /** The bundle's parts as the tool split it; null when the split is not resolved. */
  split: string[] | null;
  parts: BlindPart[];
}

export interface BlindFile {
  about: string;
  exportedAt: number;
  bundles: BlindBundle[];
}

/**
 * Where a candidate's row came from. Only a saved listing is a search row as a scan saw it (its brand
 * field included), so only those pairs join the corpus.
 */
export type RowFrom = 'saved listing' | 'match question' | 'chosen, not saved';

export interface ToolPart {
  brand: string;
  model: string;
  qty: number;
  isKit: boolean | null;
  /** The match record's status; 'matched' when the report row names a listing; 'unmatched' when there is no record. */
  status: string;
  asin: string | null;
  grade: string | null;
  source: string | null;
  candidates: { asin: string; from: RowFrom }[];
}

export interface ToolFile {
  about: string;
  exportedAt: number;
  bundles: { itemId: string; brand: string; model: string; title: string; section: string; parts: ToolPart[] }[];
}

export const amazonLink = (asin: string): string => `https://www.amazon.com/dp/${asin}`;
export const homeDepotLink = (itemId: string): string => `https://www.homedepot.com/p/${itemId}`;

const BLIND_ABOUT = 'For a blind checker: docs/audit-checker.md says how to label it. Per bundle part, the Amazon listings that may '
  + 'be it: every listing the scan saved whose title names the part\'s model as a whole token (RYOBI: with or without its '
  + 'tool-only B), the listings of an answered or open match question, and the listing the tool chose, in ASIN order. Nothing here says '
  + 'which listing the tool chose or how it graded any of them. Write the labels to labels.json in this folder.';
const TOOL_ABOUT = 'What the tool chose for each part of the audited scan. Never shown to the checker. npm run audit -- score '
  + 'reads it with labels.json.';

/** The audit folder's name: the export file's date, else the export time's UTC date. */
export function auditDate(file: string, exportedAt: number): string {
  const m = /split-finder-audit-(\d{4}-\d{2}-\d{2})/.exec(basename(file));
  return m ? m[1]! : new Date(exportedAt).toISOString().slice(0, 10);
}

/** blind.json and tool.json for an export. Pure: writes nothing. */
export function prepareAudit(exp: AuditExport): { blind: BlindFile; tool: ToolFile } {
  const listings = new Map(exp.listings.map((l) => [l.asin, l]));
  const matches = new Map(exp.matches.map((m) => [m.key, m]));
  const blindBundles: BlindBundle[] = [];
  const toolBundles: ToolFile['bundles'] = [];
  const bundles = [...exp.bundles].sort((a, b) => a.itemId.localeCompare(b.itemId, 'en', { numeric: true }));
  for (const b of bundles) {
    const blindParts: BlindPart[] = [];
    const toolParts: ToolPart[] = [];
    for (const p of b.parts) {
      const key = partKey(p.brand, p.model);
      const rows = new Map<string, { c: BlindCandidate; from: RowFrom }>();
      for (const l of exp.listings) {
        if (!titleHasModel(p.brand, l.title, p.model)) continue;
        rows.set(l.asin, { c: { asin: l.asin, title: l.title, brand: l.brand ?? null, price: l.price ?? null, reviews: l.reviews ?? null, link: amazonLink(l.asin) }, from: 'saved listing' });
      }
      for (const q of [...exp.answers, ...(exp.questions ?? [])]) {
        if (q.kind !== 'match' || q.subject !== key) continue;
        for (const c of q.candidates ?? []) {
          if (rows.has(c.asin)) continue;
          const saved = listings.get(c.asin);
          rows.set(c.asin, saved
            ? { c: { asin: c.asin, title: saved.title, brand: saved.brand ?? null, price: saved.price ?? null, reviews: saved.reviews ?? null, link: amazonLink(c.asin) }, from: 'saved listing' }
            : { c: { asin: c.asin, title: c.title, brand: null, price: c.price ?? null, reviews: c.reviews ?? null, link: amazonLink(c.asin) }, from: 'match question' });
        }
      }
      if (p.asin && !rows.has(p.asin)) {
        const saved = listings.get(p.asin);
        rows.set(p.asin, saved
          ? { c: { asin: p.asin, title: saved.title, brand: saved.brand ?? null, price: saved.price ?? null, reviews: saved.reviews ?? null, link: amazonLink(p.asin) }, from: 'saved listing' }
          : { c: { asin: p.asin, title: null, brand: null, price: null, reviews: null, link: amazonLink(p.asin) }, from: 'chosen, not saved' });
      }
      const sorted = [...rows.values()].sort((x, y) => x.c.asin.localeCompare(y.c.asin));
      blindParts.push({ model: p.model, qty: p.qty, candidates: sorted.map((r) => r.c) });
      const match = matches.get(key);
      toolParts.push({
        brand: p.brand, model: p.model, qty: p.qty, isKit: typeof p.isKit === 'boolean' ? p.isKit : null,
        status: p.asin ? 'matched' : (match?.status ?? 'unmatched'), asin: p.asin, grade: p.grade, source: p.source,
        candidates: sorted.map((r) => ({ asin: r.c.asin, from: r.from })),
      });
    }
    blindBundles.push({ itemId: b.itemId, brand: b.brand, model: b.model, title: b.title, link: homeDepotLink(b.itemId), split: b.split, parts: blindParts });
    toolBundles.push({ itemId: b.itemId, brand: b.brand, model: b.model, title: b.title, section: b.section, parts: toolParts });
  }
  return {
    blind: { about: BLIND_ABOUT, exportedAt: exp.exportedAt, bundles: blindBundles },
    tool: { about: TOOL_ABOUT, exportedAt: exp.exportedAt, bundles: toolBundles },
  };
}

// ---------------------------------------------------------------- the corpus

export type PairLabel = 'part' | 'not-part' | 'uncertain';

/** A search row as the matcher grades it. */
export interface CorpusListing {
  asin: string;
  title: string;
  brand: string | null;
  price: number | null;
  reviews: number | null;
}

export interface CorpusPair {
  part: { brand: string; model: string; isKit: boolean | null };
  listing: CorpusListing;
  label: PairLabel;
  /** The audit (or validation run) whose labels gave the pair: 'audit-<date>', 'validation-<date>'. */
  source: string;
  /** The checker's note on the part. */
  note: string;
  /**
   * Set when the matcher's grade goes against the label and the fix has not landed: the reason. The
   * test then expects the pair to fail still, so the mark is removed once it passes.
   */
  known?: string;
}

export interface Corpus {
  about: string;
  pairs: CorpusPair[];
}

export const CORPUS_ABOUT = 'Labelled (part, Amazon listing) pairs from audits and the validation set. core/test/match-corpus.test.ts '
  + 'grades every pair with the matcher (grade over wantedFor, as a scan grades a search row): a pair labelled not-part must never '
  + 'grade probable or better, a pair labelled part must grade at least review; uncertain pairs wait for a person. A pair marked '
  + 'known fails today for the reason given and must keep failing until its fix lands, when the mark is removed. One pair per part '
  + 'and ASIN. Written by npm run audit -- score and seed-validation (docs/audit.md).';

export const pairKey = (p: Pick<CorpusPair, 'part' | 'listing'>): string => `${partKey(p.part.brand, p.part.model)}|${p.listing.asin}`;

/**
 * The matcher's grade of the pair: grade() over wantedFor(), exactly as a scan grades a search row
 * for a part (applyLookup, pickFromListings). The catalog holds the part only when it is a kit.
 */
export function corpusGrade(pair: Pick<CorpusPair, 'part' | 'listing'>): Graded {
  const { brand, model, isKit } = pair.part;
  const catalog: Catalog = new Map(isKit ? [[model.trim().toUpperCase(), { model: model.trim().toUpperCase(), brand, kinds: [], isKit: true }]] : []);
  const row: Candidate = { asin: pair.listing.asin, title: pair.listing.title, brand: pair.listing.brand, price: pair.listing.price, reviews: pair.listing.reviews };
  return grade(wantedFor(brand, model, catalog), row);
}

const USABLE = new Set(['exact', 'strong', 'probable']);

/** Why the matcher's grade goes against the pair's label; null when it does not (and for uncertain pairs). */
export function pairProblem(pair: Pick<CorpusPair, 'part' | 'listing' | 'label'>): string | null {
  if (pair.label === 'uncertain') return null;
  const g = corpusGrade(pair);
  const why = g.reasons.join('; ');
  if (pair.label === 'not-part' && USABLE.has(g.grade)) return `labelled not the part, graded ${g.grade} (${why})`;
  if (pair.label === 'part' && g.grade === 'reject') return `labelled the part, graded reject (${why})`;
  return null;
}

export function readCorpus(file: string): Corpus {
  if (!existsSync(file)) return { about: CORPUS_ABOUT, pairs: [] };
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Corpus>;
  return { about: CORPUS_ABOUT, pairs: Array.isArray(raw.pairs) ? raw.pairs : [] };
}

const comparePairs = (a: CorpusPair, b: CorpusPair): number =>
  a.part.brand.localeCompare(b.part.brand) || a.part.model.localeCompare(b.part.model) || a.listing.asin.localeCompare(b.listing.asin);

export function writeCorpus(file: string, corpus: Corpus): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const pairs = [...corpus.pairs].sort(comparePairs);
  writeFileSync(file, `${JSON.stringify({ about: CORPUS_ABOUT, pairs }, null, 2)}\n`);
}

export interface Merge {
  corpus: Corpus;
  /** New pairs, with `known` set on those the matcher fails today. */
  added: CorpusPair[];
  /** Uncertain pairs a certain label settled. */
  settled: CorpusPair[];
  /** A certain label against the corpus's other certain label: the corpus is left as it was for a person to settle. */
  conflicts: { kept: CorpusPair; incoming: CorpusPair }[];
  /** Pairs already in the corpus with the same label, or certain there and uncertain here. */
  unchanged: number;
}

/**
 * Adds pairs to the corpus, one per part and ASIN. A new pair is added; an uncertain pair takes a
 * certain label; a certain label is never replaced (a different one is a conflict, listed, not
 * applied). A pair that is added or settled and that the matcher fails today is marked known.
 */
export function mergePairs(corpus: Corpus, incoming: CorpusPair[]): Merge {
  const byKey = new Map(corpus.pairs.map((p) => [pairKey(p), p]));
  const out: Merge = { corpus, added: [], settled: [], conflicts: [], unchanged: 0 };
  const mark = (p: CorpusPair): CorpusPair => {
    const { known: _drop, ...rest } = p;
    const problem = pairProblem(rest);
    return problem ? { ...rest, known: `${p.source}: ${problem}` } : rest;
  };
  for (const p of incoming) {
    const key = pairKey(p);
    const old = byKey.get(key);
    if (!old) {
      const added = mark(p);
      byKey.set(key, added);
      out.added.push(added);
    } else if (old.label === p.label || p.label === 'uncertain') {
      out.unchanged += 1;
    } else if (old.label === 'uncertain') {
      const settled = mark({ ...p, part: old.part, listing: old.listing });
      byKey.set(key, settled);
      out.settled.push(settled);
    } else {
      out.conflicts.push({ kept: old, incoming: p });
    }
  }
  out.corpus = { about: CORPUS_ABOUT, pairs: [...byKey.values()].sort(comparePairs) };
  return out;
}

/** A part's label for one listing. */
export function labelOf(label: PartLabel & { uncertain?: string[] }, asin: string): PairLabel {
  if (label.correct !== 'none' && label.correct.includes(asin)) return 'part';
  if ((label.uncertain ?? []).includes(asin)) return 'uncertain';
  return 'not-part';
}

// ---------------------------------------------------------------- score

interface Row {
  bundle: string;
  itemId: string;
  part: ToolPart;
  label: (PartLabel & { uncertain?: string[] }) | undefined;
}

export interface AuditScore {
  wrong: Row[];
  /** The tool chose a listing the checker could not settle. */
  chosenUncertain: Row[];
  missed: Row[];
  notLookedUp: Row[];
  unlabelled: Row[];
  /** Labelled listings the corpus cannot hold: no saved search row (brand field unknown), or not among the candidates. */
  notAdded: { bundle: string; model: string; asin: string; why: string }[];
  /** The same pair labelled two ways within this audit: not added. */
  inconsistent: { model: string; asin: string; labels: PairLabel[] }[];
  pairs: CorpusPair[];
}

const correctList = (l: PartLabel | undefined): string[] => (l && l.correct !== 'none' ? l.correct : []);

/** Scores the tool's choices against the labels and lists the pairs for the corpus. Pure. */
export function scoreAudit(blind: BlindFile, tool: ToolFile, labels: Labels, source: string): AuditScore {
  const s: AuditScore = { wrong: [], chosenUncertain: [], missed: [], notLookedUp: [], unlabelled: [], notAdded: [], inconsistent: [], pairs: [] };
  const blindRows = new Map<string, BlindCandidate>();
  for (const b of blind.bundles) for (const p of b.parts) for (const c of p.candidates) blindRows.set(c.asin, c);
  const incoming = new Map<string, CorpusPair[]>();
  for (const b of tool.bundles) {
    for (const part of b.parts) {
      const label = labels[b.model]?.[part.model] as (PartLabel & { uncertain?: string[] }) | undefined;
      const row: Row = { bundle: b.model, itemId: b.itemId, part, label };
      if (!label) {
        s.unlabelled.push(row);
        continue;
      }
      const correct = correctList(label);
      if (part.status === 'waiting' || part.status === 'unmatched') s.notLookedUp.push(row);
      else if (part.status === 'matched' && part.asin) {
        if (!correct.includes(part.asin)) ((label.uncertain ?? []).includes(part.asin) ? s.chosenUncertain : s.wrong).push(row);
      } else if (correct.length > 0) s.missed.push(row);

      const from = new Map(part.candidates.map((c) => [c.asin, c.from]));
      const labelled = new Set([...part.candidates.map((c) => c.asin), ...correct, ...(label.uncertain ?? [])]);
      for (const asin of labelled) {
        const f = from.get(asin);
        const r = blindRows.get(asin);
        if (f !== 'saved listing' || !r || r.title === null) {
          // Grading a row rebuilt without its brand field could pass a pair the real row fails.
          s.notAdded.push({ bundle: b.model, model: part.model, asin, why: f === undefined ? 'not among the candidates' : `its row is not a saved listing (${f}), so its brand field is not known` });
          continue;
        }
        const pair: CorpusPair = {
          part: { brand: part.brand.trim().toUpperCase(), model: part.model.trim().toUpperCase(), isKit: part.isKit },
          listing: { asin, title: r.title, brand: r.brand, price: r.price, reviews: r.reviews },
          label: labelOf(label, asin), source, note: label.note,
        };
        const key = pairKey(pair);
        incoming.set(key, [...(incoming.get(key) ?? []), pair]);
      }
    }
  }
  for (const list of incoming.values()) {
    const kinds = [...new Set(list.map((p) => p.label))];
    if (kinds.length > 1) s.inconsistent.push({ model: list[0]!.part.model, asin: list[0]!.listing.asin, labels: kinds });
    else s.pairs.push(list[0]!);
  }
  return s;
}

const cell = (s: string): string => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

function partLine(r: Row, blindRows: Map<string, BlindCandidate>): string {
  const chosen = r.part.asin ? `[${r.part.asin}](${amazonLink(r.part.asin)}) ${cell(blindRows.get(r.part.asin)?.title ?? '(title not in the export)')}` : '-';
  const correct = r.label ? (r.label.correct === 'none' ? 'none' : r.label.correct.map((a) => `[${a}](${amazonLink(a)})`).join(' ') || '-') : '-';
  return `| [${r.bundle}](${homeDepotLink(r.itemId)}) | ${r.part.model} | ${r.part.grade ?? r.part.status} | ${chosen} | ${correct} | ${cell(r.label?.note ?? '')} |`;
}

/** failures.md: what the audit found, every listing linked to its source. */
export function failuresMarkdown(dir: string, blind: BlindFile, score: AuditScore, merge: Merge): string {
  const blindRows = new Map<string, BlindCandidate>();
  for (const b of blind.bundles) for (const p of b.parts) for (const c of p.candidates) blindRows.set(c.asin, c);
  const parts = blind.bundles.reduce((n, b) => n + b.parts.length, 0);
  const lines = [
    `# Audit ${basename(dir)}`,
    '',
    `${blind.bundles.length} bundles, ${parts} parts. Written by npm run audit -- score from tool.json and labels.json. Profit is not scored here.`,
    '',
    `- Wrong matches (the chosen listing is not among the correct ones): ${score.wrong.length}`,
    `- Chosen listings the checker could not settle: ${score.chosenUncertain.length}`,
    `- Missed listings (a correct listing exists, the tool left the part with none or in review): ${score.missed.length}`,
    `- Parts not looked up: ${score.notLookedUp.length}`,
    `- Parts with no label: ${score.unlabelled.length}`,
    `- Corpus: ${merge.added.length} pairs added (${merge.added.filter((p) => p.known).length} marked known), ${merge.settled.length} settled, ${merge.unchanged} unchanged, ${merge.conflicts.length} conflicts`,
  ];
  const table = (title: string, rows: Row[]) => {
    if (rows.length === 0) return;
    lines.push('', `## ${title}`, '', '| bundle | part | tool | chosen | correct | note |', '|---|---|---|---|---|---|');
    for (const r of rows) lines.push(partLine(r, blindRows));
  };
  table('Wrong matches', score.wrong);
  table('Chosen listings the checker could not settle', score.chosenUncertain);
  table('Missed listings', score.missed);
  table('Not looked up', score.notLookedUp);
  table('No label', score.unlabelled);
  const known = [...merge.added, ...merge.settled].filter((p) => p.known);
  if (known.length > 0) {
    lines.push('', '## Pairs the matcher grades against the label (added to the corpus marked known)', '', '| part | listing | label | why |', '|---|---|---|---|');
    for (const p of known) lines.push(`| ${p.part.model} | [${p.listing.asin}](${amazonLink(p.listing.asin)}) ${cell(p.listing.title)} | ${p.label} | ${cell(p.known!)} |`);
  }
  if (merge.conflicts.length > 0) {
    lines.push('', '## Label conflicts (the corpus keeps its label; a person decides)', '', '| part | listing | corpus | this audit |', '|---|---|---|---|');
    for (const c of merge.conflicts) lines.push(`| ${c.kept.part.model} | [${c.kept.listing.asin}](${amazonLink(c.kept.listing.asin)}) | ${c.kept.label} (${c.kept.source}) | ${c.incoming.label} |`);
  }
  if (score.inconsistent.length > 0) {
    lines.push('', '## The same listing labelled two ways in this audit (not added)', '');
    for (const i of score.inconsistent) lines.push(`- ${i.model} [${i.asin}](${amazonLink(i.asin)}): ${i.labels.join(', ')}`);
  }
  if (score.notAdded.length > 0) {
    lines.push('', '## Labelled listings the corpus cannot hold', '');
    for (const n of score.notAdded) lines.push(`- ${n.bundle} / ${n.model} [${n.asin}](${amazonLink(n.asin)}): ${n.why}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- the validation seed

const VALIDATION_SOURCE = `validation-${VALIDATION_DATE}`;

/**
 * The validation set's labelled pairs: for each part the labels cover, every recorded Amazon row whose
 * title names its model as a whole token (RYOBI: either form), the labels' listings, and the listing the
 * replayed run chose. The row is the first one the recorded responses hold for the ASIN (file order).
 * Whether a part is a kit comes from the replay's catalog, as the run's lookups asked.
 */
export async function validationPairs(dir: string): Promise<CorpusPair[]> {
  const files = validationFiles(dir);
  const labels = readLabels(files.labels);
  const rows = new Map<string, Candidate>();
  const amazon = join(files.responses, 'amazon');
  for (const f of readdirSync(amazon).filter((x) => x.endsWith('.json')).sort()) {
    const { data } = JSON.parse(readFileSync(join(amazon, f), 'utf8')) as { data: unknown };
    for (const c of parseAmazonSearch(data)) if (!rows.has(c.asin)) rows.set(c.asin, c);
  }
  const recorded = new ResponsesCache(files.responses);
  const run = await runValidationPipeline({
    inputs: loadInputs(dir), scanClient: new CacheOnlyClient(recorded), lookupClient: new CacheOnlyClient(recorded), continuePastMisses: true,
  });
  const results = await buildResults(run);
  const { catalog } = await knownModels(run.store);
  const pairs = new Map<string, CorpusPair>();
  for (const b of results.bundles) {
    for (const p of b.parts) {
      const label = labels[b.model]?.[p.model] as (PartLabel & { uncertain?: string[] }) | undefined;
      if (!label) continue;
      const brand = b.brand.trim().toUpperCase();
      const model = p.model.trim().toUpperCase();
      const asins = new Set<string>();
      for (const [asin, r] of rows) if (titleHasModel(brand, r.title, model)) asins.add(asin);
      for (const a of [...correctList(label), ...(label.uncertain ?? []), ...(p.asin ? [p.asin] : [])]) asins.add(a);
      for (const asin of asins) {
        const r = rows.get(asin);
        if (!r) throw new Error(`${b.model} / ${p.model}: ${asin} is in no recorded response`);
        const pair: CorpusPair = {
          part: { brand, model, isKit: wantedFor(brand, model, catalog).isKit === true },
          listing: { asin, title: r.title, brand: r.brand ?? null, price: r.price ?? null, reviews: r.reviews ?? null },
          label: labelOf(label, asin), source: VALIDATION_SOURCE, note: label.note,
        };
        const key = pairKey(pair);
        const seen = pairs.get(key);
        if (seen && seen.label !== pair.label) throw new Error(`${model} ${asin}: labelled ${seen.label} and ${pair.label} in different bundles`);
        if (!seen) pairs.set(key, pair);
      }
    }
  }
  return [...pairs.values()].sort(comparePairs);
}

// ---------------------------------------------------------------- the command

export interface AuditDeps {
  log: (line: string) => void;
  /** This checkout: audit/ and fixtures/ are under it. */
  root: string;
  /** fixtures/audit/corpus.json unless a test says otherwise. */
  corpusFile?: string;
}

const USAGE = [
  'Usage (no searches, no network):',
  '  npm run audit -- prepare <split-finder-audit-YYYY-MM-DD.json> [--out <dir>]   writes <dir>/blind.json and <dir>/tool.json (default audit/<date>)',
  '  npm run audit -- score <dir>                                                  reads <dir>/labels.json; writes <dir>/failures.md; adds the pairs to fixtures/audit/corpus.json',
  '  npm run audit -- seed-validation                                              adds the validation set\'s labelled pairs to the corpus',
];

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

function logMerge(log: (line: string) => void, file: string, merge: Merge): void {
  log(`Corpus ${file}: ${merge.corpus.pairs.length} pairs; added ${merge.added.length} (${merge.added.filter((p) => p.known).length} marked known), settled ${merge.settled.length}, unchanged ${merge.unchanged}, conflicts ${merge.conflicts.length}`);
  for (const p of [...merge.added, ...merge.settled].filter((x) => x.known)) log(`  known: ${p.part.model} ${p.listing.asin}: ${p.known}`);
  for (const c of merge.conflicts) log(`  conflict, kept: ${c.kept.part.model} ${c.kept.listing.asin} is ${c.kept.label} (${c.kept.source}); this audit says ${c.incoming.label}`);
}

export async function runAuditCli(args: string[], deps: AuditDeps): Promise<number> {
  const { log } = deps;
  const corpusFile = deps.corpusFile ?? join(deps.root, 'fixtures', 'audit', 'corpus.json');
  const [command, ...rest] = args;

  if (command === 'prepare' && (rest.length === 1 || (rest.length === 3 && rest[1] === '--out'))) {
    const file = rest[0]!;
    if (!existsSync(file)) {
      log(`No such file: ${file}`);
      return 1;
    }
    let exp: AuditExport;
    try {
      exp = readExport(readFileSync(file, 'utf8'));
    } catch (err) {
      if (!(err instanceof ExportRefused)) throw err;
      log(err.message);
      return 1;
    }
    const dir = rest.length === 3 ? rest[2]! : join(deps.root, 'audit', auditDate(file, exp.exportedAt));
    const { blind, tool } = prepareAudit(exp);
    const blindText = json(blind);
    const toolText = json(tool);
    for (const [name, text] of [['blind.json', blindText], ['tool.json', toolText]] as const) {
      const at = join(dir, name);
      if (existsSync(at) && readFileSync(at, 'utf8') !== text) {
        log(`${at} already holds another audit; nothing was written. Pass --out <dir> for this one.`);
        return 1;
      }
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'blind.json'), blindText);
    writeFileSync(join(dir, 'tool.json'), toolText);
    const parts = blind.bundles.reduce((n, b) => n + b.parts.length, 0);
    const candidates = blind.bundles.reduce((n, b) => n + b.parts.reduce((m, p) => m + p.candidates.length, 0), 0);
    log(`Audit ${dir}: ${blind.bundles.length} bundles, ${parts} parts, ${candidates} candidate listings.`);
    log(`Next: give a checker docs/audit-checker.md and ${join(dir, 'blind.json')} only; its labels go to ${join(dir, 'labels.json')}. Then npm run audit -- score ${dir}`);
    return 0;
  }

  if (command === 'score' && rest.length === 1) {
    const dir = rest[0]!;
    const files = { blind: join(dir, 'blind.json'), tool: join(dir, 'tool.json'), labels: join(dir, 'labels.json') };
    for (const f of [files.blind, files.tool]) {
      if (!existsSync(f)) {
        log(`No ${f}: run npm run audit -- prepare first.`);
        return 1;
      }
    }
    const labels = readLabels(files.labels);
    if (Object.keys(labels).length === 0) {
      log(`No labels in ${files.labels}: the checker writes them there (docs/audit-checker.md).`);
      return 1;
    }
    const blind = JSON.parse(readFileSync(files.blind, 'utf8')) as BlindFile;
    const tool = JSON.parse(readFileSync(files.tool, 'utf8')) as ToolFile;
    const score = scoreAudit(blind, tool, labels, `audit-${basename(dir)}`);
    const merge = mergePairs(readCorpus(corpusFile), score.pairs);
    writeCorpus(corpusFile, merge.corpus);
    writeFileSync(join(dir, 'failures.md'), failuresMarkdown(dir, blind, score, merge));
    log(`Wrong ${score.wrong.length}, chosen but uncertain ${score.chosenUncertain.length}, missed ${score.missed.length}, not looked up ${score.notLookedUp.length}, no label ${score.unlabelled.length}`);
    logMerge(log, corpusFile, merge);
    log(`Failures: ${join(dir, 'failures.md')}`);
    return 0;
  }

  if (command === 'seed-validation' && rest.length === 0) {
    const merge = mergePairs(readCorpus(corpusFile), await validationPairs(join(deps.root, 'fixtures', 'validation')));
    writeCorpus(corpusFile, merge.corpus);
    logMerge(log, corpusFile, merge);
    return 0;
  }

  for (const line of USAGE) log(line);
  return 1;
}
