import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AuditExport, auditDate, type CorpusPair, ExportRefused, mergePairs, pairKey, pairProblem, prepareAudit, readCorpus, readExport, runAuditCli,
  scoreAudit, validationPairs,
} from '../../scripts/audit-cli';
import { titleHasModel } from '../src/match';
import { readLabels } from '../../scripts/validate-cli';

// The audit loop on a hand-made export (fixtures/audit/split-finder-audit-2026-11-18.json): the
// contract filled from the validation run's replay, with the validation set's blind labels. No network.

const EXPORT = 'fixtures/audit/split-finder-audit-2026-11-18.json';
const LABELS = 'fixtures/validation/labels-2026-11-18.json';
const CORPUS = 'fixtures/audit/corpus.json';
const exportText = readFileSync(EXPORT, 'utf8');
const exp = readExport(exportText);

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in the default tests'));
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

const tmp = () => mkdtempSync(join(tmpdir(), 'audit-'));
const quiet = () => {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
};

describe('reading an export', () => {
  const base = JSON.parse(exportText) as Record<string, unknown>;
  const refused = (v: unknown) => () => readExport(typeof v === 'string' ? v : JSON.stringify(v));

  it('reads the contract', () => {
    expect(exp.bundles).toHaveLength(31);
    expect(exp.listings.length).toBeGreaterThan(0);
    expect(auditDate(EXPORT, exp.exportedAt)).toBe('2026-11-18');
    expect(auditDate('/x/export.json', Date.UTC(2026, 11, 2, 9))).toBe('2026-12-02');
  });

  it('refuses an export that carries the key or the settings, or is not the contract', () => {
    expect(refused({ ...base, settings: { fees: 1 } })).toThrow(ExportRefused);
    expect(refused({ ...base, serpApiKey: 'x' })).toThrow(/serpApiKey/);
    expect(refused({ ...base, bundles: [{ ...(base.bundles as object[])[0], apiKey: 'x' }] })).toThrow(/apiKey/);
    expect(refused(exportText.replace('"kind"', '"api_key": "x", "kind"'))).toThrow(/api_key/);
    expect(refused({ ...base, kind: 'other' })).toThrow(/kind/);
    expect(refused({ ...base, version: 2 })).toThrow(/version 2/);
    expect(refused({ ...base, listings: undefined })).toThrow(/listings/);
    expect(refused('not json')).toThrow(/not JSON/);
  });
});

describe('prepare', () => {
  const { blind, tool } = prepareAudit(exp);

  it('shows the checker the candidates and nothing of the tool\'s choice', () => {
    const text = JSON.stringify(blind);
    for (const field of ['"grade"', '"source"', '"status"', '"chosen"', '"from"']) expect(text).not.toContain(field);
    expect(blind.bundles.map((b) => b.itemId)).toEqual(tool.bundles.map((b) => b.itemId));
    for (const b of blind.bundles) {
      expect(b.link).toBe(`https://www.homedepot.com/p/${b.itemId}`);
      for (const p of b.parts) {
        const asins = p.candidates.map((c) => c.asin);
        expect(asins).toEqual([...asins].sort());
      }
    }
  });

  it('lists every saved listing that names the part, the B twin allowed, and the chosen listing', () => {
    for (const b of exp.bundles) {
      const blindParts = blind.bundles.find((x) => x.itemId === b.itemId)!.parts;
      b.parts.forEach((p, i) => {
        const asins = blindParts[i]!.candidates.map((c) => c.asin);
        const naming = exp.listings.filter((l) => titleHasModel(p.brand, l.title, p.model)).map((l) => l.asin);
        expect(asins).toEqual(expect.arrayContaining(naming));
        if (p.asin) expect(asins).toContain(p.asin);
      });
    }
    const pcl430 = blind.bundles.flatMap((b) => b.parts).find((p) => p.model === 'PCL430B')!;
    expect(pcl430.candidates.some((c) => /\bPCL430\b/.test(c.title ?? ''))).toBe(true);
  });

  it('keeps the tool\'s choices in tool.json, with where each candidate row came from', () => {
    const parts = tool.bundles.flatMap((b) => b.parts);
    expect(parts.filter((p) => p.status === 'matched').every((p) => p.asin !== null)).toBe(true);
    expect(parts.find((p) => p.model === 'PCL265B')!.status).toBe('none');
    expect(parts.find((p) => p.model === 'PBP004')!.status).toBe('review');
    expect(parts.every((p) => p.isKit === null)).toBe(true);
    expect(new Set(parts.flatMap((p) => p.candidates.map((c) => c.from)))).toEqual(new Set(['saved listing']));
  });

  it('writes audit/<date>, and refuses to overwrite another audit there', async () => {
    const out = join(tmp(), 'a');
    const one = quiet();
    expect(await runAuditCli(['prepare', EXPORT, '--out', out], { log: one.log, root: tmp() })).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'blind.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(blind)));
    expect(JSON.parse(readFileSync(join(out, 'tool.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(tool)));
    expect(await runAuditCli(['prepare', EXPORT, '--out', out], { log: one.log, root: tmp() })).toBe(0);

    const other = join(tmp(), 'other.json');
    writeFileSync(other, JSON.stringify({ ...JSON.parse(exportText), bundles: exp.bundles.slice(1) }));
    const two = quiet();
    expect(await runAuditCli(['prepare', other, '--out', out], { log: two.log, root: tmp() })).toBe(1);
    expect(two.lines.join('\n')).toMatch(/already holds another audit; nothing was written/);

    const root = tmp();
    expect(await runAuditCli(['prepare', EXPORT], { log: quiet().log, root })).toBe(0);
    expect(readFileSync(join(root, 'audit', '2026-11-18', 'blind.json'), 'utf8')).toContain('"DCK420D2DCS391B"');
  });

  it('refuses a keyed export and bad arguments, writing nothing', async () => {
    const keyed = join(tmp(), 'k.json');
    writeFileSync(keyed, exportText.replace('"kind"', '"settings": {}, "kind"'));
    const root = tmp();
    const q = quiet();
    expect(await runAuditCli(['prepare', keyed], { log: q.log, root })).toBe(1);
    expect(q.lines.join('\n')).toMatch(/never carries the key or the settings/);
    expect(await runAuditCli(['prepare'], { log: q.log, root })).toBe(1);
    expect(await runAuditCli(['score'], { log: q.log, root })).toBe(1);
    expect(await runAuditCli(['spend'], { log: q.log, root })).toBe(1);
  });
});

describe('score', () => {
  async function scored(corpusFrom: string | null) {
    const root = tmp();
    const dir = join(root, 'audit', '2026-11-18');
    await runAuditCli(['prepare', EXPORT, '--out', dir], { log: quiet().log, root });
    copyFileSync(LABELS, join(dir, 'labels.json'));
    const corpusFile = join(root, 'corpus.json');
    if (corpusFrom) copyFileSync(corpusFrom, corpusFile);
    const q = quiet();
    const code = await runAuditCli(['score', dir], { log: q.log, root, corpusFile });
    return { code, lines: q.lines, failures: readFileSync(join(dir, 'failures.md'), 'utf8'), corpus: readCorpus(corpusFile) };
  }

  it('finds the validation run\'s missed listings, with their sources linked, and no wrong match', async () => {
    const { code, failures } = await scored(CORPUS);
    expect(code).toBe(0);
    expect(failures).toContain('- Wrong matches (the chosen listing is not among the correct ones): 0');
    const missed = failures.split('## Missed listings')[1]!.split('\n## ')[0]!;
    for (const [model, asin] of [['A986501', 'B09KHGD84Q'], ['PBP2003', 'B0BG5SPWVL'], ['PBP004', 'B09HDZ5MPV'], ['PCL265B', 'B0BL8BC8MF']]) {
      expect(missed).toContain(`| ${model} |`);
      expect(missed).toContain(`[${asin}](https://www.amazon.com/dp/${asin})`);
    }
    expect(missed).toContain('(https://www.homedepot.com/p/344285193)');
  });

  it('adds nothing new to the committed corpus: the seed already holds every pair this export can give', async () => {
    const { corpus } = await scored(CORPUS);
    expect(corpus).toEqual(readCorpus(CORPUS));
  });

  it('adds every labelled pair to an empty corpus, marking known those the matcher fails today', async () => {
    const { corpus, lines } = await scored(null);
    expect(corpus.pairs.length).toBeGreaterThan(0);
    expect(corpus.pairs.every((p) => p.source === 'audit-2026-11-18')).toBe(true);
    const known = corpus.pairs.filter((p) => p.known);
    // DCK240C2 bundled with a saw or a bit set was probable for the kit, the last pair the sample failed; it is
    // review since the kit-extras rule (core/test/kit-extras.recorded.test.ts), so none is marked known.
    expect(known).toEqual([]);
    for (const p of corpus.pairs) expect(pairProblem(p) !== null, pairKey(p)).toBe(p.known !== undefined);
    expect(known.every((p) => p.known!.startsWith('audit-2026-11-18: labelled'))).toBe(true);
    expect(lines.join('\n')).toContain(`(${known.length} marked known)`);
  });

  it('refuses to score without labels', async () => {
    const root = tmp();
    const dir = join(root, 'a');
    await runAuditCli(['prepare', EXPORT, '--out', dir], { log: quiet().log, root });
    const q = quiet();
    expect(await runAuditCli(['score', dir], { log: q.log, root, corpusFile: join(root, 'c.json') })).toBe(1);
    expect(q.lines.join('\n')).toMatch(/No labels/);
  });
});

describe('the corpus rules', () => {
  const pcl430 = (label: CorpusPair['label'], source = 'audit-x'): CorpusPair => ({
    part: { brand: 'RYOBI', model: 'PCL430B', isKit: false },
    listing: { asin: 'B0B11CJ52Y', title: 'ONE+ 18V Cordless Oscillating Multi-Tool (Tool Only)', brand: 'RYOBI', price: 79, reviews: 100 },
    label, source, note: 'n',
  });

  it('settles an uncertain pair with a certain label, keeps a certain one, and lists a conflict without applying it', () => {
    const start = { about: '', pairs: [pcl430('uncertain', 'validation-2026-11-18')] };
    const settled = mergePairs(start, [pcl430('not-part')]);
    expect(settled.settled).toHaveLength(1);
    expect(settled.corpus.pairs[0]!.label).toBe('not-part');

    const again = mergePairs(settled.corpus, [pcl430('uncertain'), pcl430('not-part')]);
    expect(again.unchanged).toBe(2);
    expect(again.corpus.pairs).toEqual(settled.corpus.pairs);

    const conflict = mergePairs(settled.corpus, [pcl430('part', 'audit-y')]);
    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.corpus.pairs).toEqual(settled.corpus.pairs);
  });

  it('marks a new pair the matcher fails today as known, with the reason', () => {
    // B0BL8BC8MF (validation set): "Ryobi PCL265 ... (Tool ONLY- Battery and Charger NOT Included)", brand field empty.
    const pair = readCorpus(CORPUS).pairs.find((p) => p.part.model === 'PCL265B' && p.listing.asin === 'B0BL8BC8MF')!;
    const { known: _known, ...plain } = pair;
    const merged = mergePairs({ about: '', pairs: [] }, [{ ...plain, source: 'audit-z' }]);
    if (pairProblem(plain) === null) expect(merged.added[0]!.known).toBeUndefined();
    else expect(merged.added[0]!.known).toMatch(/^audit-z: labelled the part, graded reject/);
    // No recorded pair fails today, so a label is flipped by hand: B00IJ0ALYS, the DCK240C2 kit itself
    // (probable), labelled not the part here only. It must be added marked known, with the reason.
    const kit = readCorpus(CORPUS).pairs.find((p) => p.part.model === 'DCK240C2' && p.listing.asin === 'B00IJ0ALYS')!;
    const flipped = mergePairs({ about: '', pairs: [] }, [{ ...kit, label: 'not-part', source: 'audit-z' }]);
    expect(flipped.added[0]!.known).toMatch(/^audit-z: labelled not the part, graded probable/);
  });

  it('never adds a labelled listing whose row is not a saved search row', () => {
    const e: AuditExport = {
      kind: 'split-finder-audit', version: 1, exportedAt: 0, listings: [],
      matches: [{ key: 'RYOBI:PBP004', brand: 'RYOBI', model: 'PBP004', status: 'review', asin: null, grade: null, alternatives: [], decidedBy: 'auto', updatedAt: 0, waitingSince: null }],
      bundles: [{ key: 'homedepot:1', itemId: '1', brand: 'RYOBI', model: 'PSK1212SB', title: 't', section: 'missing_listing', split: ['PBP004'], parts: [{ brand: 'RYOBI', model: 'PBP004', qty: 1, asin: null, grade: null, source: null, isKit: false }] }],
      answers: [{
        id: 'match:RYOBI:PBP004', kind: 'match', subject: 'RYOBI:PBP004', brand: 'RYOBI', model: 'PBP004', title: null, reason: '', choices: [], openedAt: 0, answer: 'none', answeredAt: 1,
        candidates: [{ asin: 'B09HDZ5MPV', title: 'TTI Ryobi PBP004 ONE+ High Performance 18 Volts Lithium-Ion 4.0 Ah Battery', price: 99, reviews: 10, reasons: [], seenAt: 0 }],
      }],
    };
    const { blind, tool } = prepareAudit(e);
    expect(blind.bundles[0]!.parts[0]!.candidates.map((c) => [c.asin, c.brand])).toEqual([['B09HDZ5MPV', null]]);
    expect(tool.bundles[0]!.parts[0]!.candidates).toEqual([{ asin: 'B09HDZ5MPV', from: 'match question' }]);
    expect(tool.bundles[0]!.parts[0]!.isKit).toBe(false);
    const score = scoreAudit(blind, tool, { PSK1212SB: { PBP004: { correct: ['B09HDZ5MPV'], note: 'n' } } }, 'audit-q');
    expect(score.pairs).toEqual([]);
    expect(score.notAdded).toEqual([{ bundle: 'PSK1212SB', model: 'PBP004', asin: 'B09HDZ5MPV', why: expect.stringMatching(/brand field is not known/) }]);
    expect(score.missed).toHaveLength(1);
  });
});

describe('open questions in the export', () => {
  const part = { brand: 'RYOBI', model: 'PCL265B', qty: 1, asin: null, grade: null, source: null, isKit: false };
  const base: AuditExport = {
    kind: 'split-finder-audit', version: 1, exportedAt: 0, listings: [], matches: [], answers: [],
    bundles: [{ key: 'homedepot:1', itemId: '1', brand: 'RYOBI', model: 'PCL-X', title: 't', section: 'waiting', split: ['PCL265B'], parts: [part] }],
  };
  const open = {
    id: 'match:RYOBI:PCL265B', kind: 'match' as const, subject: 'RYOBI:PCL265B', brand: 'RYOBI', model: 'PCL265B', title: null, reason: 'two listings', choices: [],
    openedAt: 0, answer: null, answeredAt: null,
    candidates: [{ asin: 'B0BL8BC8MF', title: 'Ryobi PCL265 18V Tool ONLY', price: 20, reviews: 3, reasons: ['brand field empty'], seenAt: 0 }],
  };

  it('shows the candidates of an open match question to the checker, with no grade or choice', () => {
    const { blind, tool } = prepareAudit({ ...base, questions: [open] });
    expect(blind.bundles[0]!.parts[0]!.candidates.map((c) => c.asin)).toEqual(['B0BL8BC8MF']);
    expect(JSON.stringify(blind.bundles)).not.toMatch(/reasons|grade|brand field empty/);
    expect(tool.bundles[0]!.parts[0]!.candidates).toEqual([{ asin: 'B0BL8BC8MF', from: 'match question' }]);
  });

  it('still reads a version 1 file with no questions field', () => {
    const { blind } = prepareAudit(base);
    expect(blind.bundles[0]!.parts[0]!.candidates).toEqual([]);
    expect(readExport(JSON.stringify(base)).questions).toBeUndefined();
  });
});

describe('the validation seed', () => {
  it('the committed corpus holds every validation pair, labelled as the labels say', async () => {
    const corpus = new Map(readCorpus(CORPUS).pairs.map((p) => [pairKey(p), p]));
    const seed = await validationPairs('fixtures/validation');
    expect(seed.length).toBeGreaterThan(0);
    for (const p of seed) {
      const kept = corpus.get(pairKey(p));
      expect(kept, pairKey(p)).toBeDefined();
      expect({ label: kept!.label, listing: kept!.listing, isKit: kept!.part.isKit }).toEqual({ label: p.label, listing: p.listing, isKit: p.part.isKit });
    }
    // Every part the labels cover has at least one pair or a "none" label.
    const labels = readLabels(LABELS);
    const models = new Set(seed.map((p) => p.part.model));
    for (const parts of Object.values(labels)) {
      for (const [model, l] of Object.entries(parts)) if (l.correct !== 'none' && l.correct.length > 0) expect(models).toContain(model);
    }
  });
});
