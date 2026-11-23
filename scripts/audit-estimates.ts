// npx tsx scripts/audit-estimates.ts [data folder]. Free, no network, writes nothing.
// Rebuilds the report from a data folder's scan store (default: fixtures/e2e-2026-11-23/after-scan3) with today's code,
// then prints every complete estimate with each part's model, matched ASIN, Amazon title, price and grade, so a wrong
// match can be found by eye: a part matched to a listing that is plainly another product, a multi-pack, a kit matched to
// a bare tool, or the reverse. The marks after a part ("?") are only prompts for that look (lookFor below), never a
// verdict: nothing here changes a match (rule 4). Then the incomplete ones, with what is unpriced and the break-even.

import { join } from 'node:path';

import { buildReport } from '../core/src/scan/report';
import { DEFAULT_SCAN_SETTINGS, type BundleRow, type PartRow } from '../core/src/scan/types';
import { loadScanFolder } from './data-folder';
import { ROOT } from './node-store';

const usd = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
const pct = (r: number): string => `${(r * 100).toFixed(1)}%`;

const KIT_MODEL = /^(DCK|PCL\d+K|P\d+K|PSK|PBLCK)/;
const BARE = /\b(tool only|bare tool|battery not included|no battery)\b/i;
const KIT_WORDS = /\b(combo kit|\d+-tool|kit with|batter(y|ies) and charger|with (\(\d\) )?(\d\.\d )?ah battery)\b/i;
const MULTI = /\b(\d+-pack|\d+ pack|\(\d\) pack|2pk|two-pack|set of \d|\d+-pk)\b/i;

/** Prompts for a look by eye; each says what to check, none decides anything. */
export function lookFor(p: Pick<PartRow, 'model' | 'title'>): string[] {
  const t = p.title ?? '';
  if (!t) return ['no saved title'];
  const out: string[] = [];
  const bare = p.model.replace(/B$/, '');
  if (!t.toUpperCase().includes(bare.toUpperCase())) out.push('title does not name the model');
  if (KIT_MODEL.test(p.model) && BARE.test(t)) out.push('a kit matched to a bare tool?');
  if (!KIT_MODEL.test(p.model) && /B$/.test(p.model) && KIT_WORDS.test(t)) out.push('a bare tool matched to a kit?');
  if (MULTI.test(t)) out.push('a multi-pack?');
  return out;
}

function partLine(p: PartRow): string {
  const marks = lookFor(p);
  const price = p.price === null ? 'no price' : usd(p.price);
  return `    ${p.model}${p.qty > 1 ? ` x${p.qty}` : ''}  ${p.asin ?? '-'}  ${p.grade ?? p.status}  ${price}  "${p.title ?? ''}"${marks.length ? `  ? ${marks.join('; ')}` : ''}`;
}

export function auditLines(rows: BundleRow[]): string[] {
  const priced = rows.filter((b) => b.price !== null && b.parts.length > 0);
  const complete = priced.filter((b) => b.estimate !== null);
  const incomplete = priced.filter((b) => b.estimate === null && b.incomplete);
  const lines: string[] = [];
  lines.push(`${rows.length} bundles; ${priced.length} with a price and a split; ${complete.length} complete estimates; ${incomplete.length} incomplete.`);
  lines.push(`Complete and above zero: ${complete.filter((b) => b.estimate!.profit > 0).length}. Estimates from the default fee settings, not real fees.`);
  lines.push('', '== Complete estimates (every model part has a counted price), best first');
  for (const b of [...complete].sort((x, y) => y.estimate!.profit - x.estimate!.profit)) {
    const e = b.estimate!;
    const way = b.options[0]?.label ? `  [${b.options[0].label}]` : '';
    lines.push(`  ${b.brand} ${b.model}  ${usd(b.price!)}  est. ${usd(e.profit)} (${pct(e.roi)})${way}  ${b.link ?? ''}`);
    for (const p of b.parts) lines.push(partLine(p));
    if (b.uncovered.length) lines.push(`    not counted (no model number): ${b.uncovered.join(', ')}`);
  }
  lines.push('', '== Incomplete (some model part has no counted price), smallest break-even first');
  for (const b of [...incomplete].sort((x, y) => x.incomplete!.breakEvenNet - y.incomplete!.breakEvenNet)) {
    const i = b.incomplete!;
    const why = i.unpriced.map((u) => `${u.model} ${u.state}`).join(', ');
    const one = i.breakEvenPrice !== null ? ` (${i.unpriced[0]!.model} at about ${usd(i.breakEvenPrice)} on Amazon)` : '';
    lines.push(`  ${b.brand} ${b.model}  ${usd(b.price!)}  ${i.priced} of ${i.total} parts priced, they bring ${usd(i.pricedNet)}; break-even needs ${usd(i.breakEvenNet)} after fees${one}; unpriced: ${why}`);
  }
  // The matched parts the incomplete ones already price, once each: their estimates rest on these when they complete.
  const seen = new Set(complete.flatMap((b) => b.parts.map((p) => p.model)));
  const others = incomplete.flatMap((b) => b.parts).filter((p) => p.asin !== null && !seen.has(p.model) && (seen.add(p.model), true));
  lines.push('', '== Other matched parts (in bundles missing a price), once each');
  for (const p of others) lines.push(partLine(p));
  return lines;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dir = process.argv[2] ?? join(ROOT, 'fixtures', 'e2e-2026-11-23', 'after-scan3');
  const store = await loadScanFolder(dir);
  const report = await buildReport(store, DEFAULT_SCAN_SETTINGS);
  for (const line of auditLines(report.bundles)) console.log(line);
}
