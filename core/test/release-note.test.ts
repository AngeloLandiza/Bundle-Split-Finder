import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { compareSemver, isNewer, nextReleaseNote, parseReleaseNote, parseSemver, releaseMessage, safeDownloadLink, type ReleaseNote } from '../src/release/note';

const root = join(import.meta.dirname, '..', '..');
const GOOD = 'https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/download/v0.1.1/Split-Finder-0.1.1-setup.exe';
const file = (o: Record<string, unknown> = {}) => JSON.stringify({ version: '0.1.1', date: '2026-11-26', notes: ['Fixes the scan button.'], downloadUrl: GOOD, ...o });

describe('semver', () => {
  it('compares plain x.y.z versions as numbers', () => {
    expect(compareSemver('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareSemver('0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });
  it('refuses anything that is not x.y.z, such as the helper build id', () => {
    for (const v of ['0.1.0+3c92cc7', '1.0', '1.0.0-beta', 'v1.0.0', '01.0.0', '', '1.0.0.0', null, 3]) expect(parseSemver(v)).toBeNull();
    expect(compareSemver('0.1.0+3c92cc7', '0.1.0')).toBeNull();
  });
  it('isNewer: newer yes, equal and older no, an unknown running version no', () => {
    expect(isNewer({ version: '0.1.1' }, '0.1.0')).toBe(true);
    expect(isNewer({ version: '0.1.0' }, '0.1.0')).toBe(false);
    expect(isNewer({ version: '0.1.0' }, '0.2.0')).toBe(false);
    expect(isNewer({ version: '0.1.1' }, null)).toBe(false);
    expect(isNewer({ version: '0.1.1' }, '0.1.0+3c92cc7')).toBe(false);
  });
});

describe('safeDownloadLink', () => {
  it('accepts the three hosts, https, github only inside this project', () => {
    expect(safeDownloadLink(GOOD)).toBe(GOOD);
    expect(safeDownloadLink('https://drive.google.com/file/d/abc123/view?usp=sharing')).not.toBeNull();
    expect(safeDownloadLink('https://docs.google.com/document/d/abc/edit')).not.toBeNull();
  });
  it('drops every other kind of link', () => {
    const bad: unknown[] = [
      'http://drive.google.com/file/d/abc',
      'ftp://drive.google.com/x',
      'javascript:alert(1)',
      'https://evil.example/Split.exe',
      'https://drive.google.com.evil.example/x',
      'https://evildrive.google.com/x',
      'https://www.github.com/AngeloLandiza/Bundle-Split-Finder/x',
      'https://github.com/someone-else/Bundle-Split-Finder/releases',
      'https://github.com/AngeloLandiza/Bundle-Split-Finder-evil/x',
      'https://github.com/AngeloLandiza/Bundle-Split-Finder/../../evil/x',
      'https://user@drive.google.com/x',
      'https://user:pw@drive.google.com/x',
      'https://drive.google.com@evil.example/x',
      'https://drive.google.com:8443/x',
      'https://drive.google.com/x\ny',
      'https://drive.google.com/x\u0000',
      'https://drive.google.com/a b',
      'https://drive.google.com\\@evil.example/x',
      `https://drive.google.com/${'a'.repeat(300)}`,
      '',
      null,
      42,
      {},
    ];
    for (const b of bad) expect(safeDownloadLink(b), String(b)).toBeNull();
  });
});

describe('parseReleaseNote', () => {
  it('reads a good file', () => {
    const r = parseReleaseNote(file())!;
    expect(r.note).toEqual({ version: '0.1.1', date: '2026-11-26', notes: ['Fixes the scan button.'], downloadUrl: GOOD });
    expect(r.linkRefused).toBe(false);
  });
  it('reads the file in the repo', () => {
    const r = parseReleaseNote(readFileSync(join(root, 'docs', 'release.json'), 'utf8'));
    expect(r).not.toBeNull();
    expect(r!.note.downloadUrl).toBeNull();
  });
  it('ignores a bad file: wrong types, HTML, too big, not an object', () => {
    const bad: unknown[] = [
      '<!DOCTYPE html><html><body>404: Not Found</body></html>',
      '',
      '[]',
      'null',
      '"0.1.1"',
      file({ version: 11 }),
      file({ version: '0.1' }),
      file({ version: '0.1.1+abc' }),
      file({ date: '26 Nov' }),
      file({ date: '2026-02-31' }),
      file({ notes: 'Fixes it' }),
      file({ notes: [] }),
      file({ notes: [3] }),
      file({ notes: ['  '] }),
      file({ notes: ['x'.repeat(121)] }),
      file({ notes: ['a', 'b', 'c', 'd', 'e', 'f'] }),
      file({ notes: ['bad\u0007bell'] }),
      file({ downloadUrl: 12 }),
      file({ downloadUrl: ['https://drive.google.com/x'] }),
      file({ notes: ['x'.repeat(17_000)] }),
      undefined,
      12,
    ];
    for (const b of bad) expect(parseReleaseNote(b), String(b).slice(0, 40)).toBeNull();
  });
  it('keeps the note and drops a link that fails the rule', () => {
    const r = parseReleaseNote(file({ downloadUrl: 'https://evil.example/Split.exe' }))!;
    expect(r.note.downloadUrl).toBeNull();
    expect(r.linkRefused).toBe(true);
    expect(parseReleaseNote(file({ downloadUrl: null }))!.linkRefused).toBe(false);
  });
});

describe('releaseMessage', () => {
  const note: ReleaseNote = { version: '0.1.1', date: '2026-11-26', notes: ['Fixes the scan button', 'Faster Review.'], downloadUrl: GOOD };
  it('says the version, what changed and the link', () => {
    expect(releaseMessage(note)).toBe(`Split Finder 0.1.1 is ready. What changed: Fixes the scan button. Faster Review. Download: ${GOOD}`);
  });
  it('without a link says to ask the developer', () => {
    expect(releaseMessage({ ...note, downloadUrl: null })).toBe('Split Finder 0.1.1 is ready. What changed: Fixes the scan button. Faster Review. Ask the developer for the download link.');
  });
});

describe('nextReleaseNote (what npm run release:note writes)', () => {
  const input = { version: '0.1.1', url: GOOD, notes: ['One.', 'Two.'], date: '2026-11-26' };
  it('writes a greater version', () => {
    const r = nextReleaseNote({ version: '0.1.0' }, input);
    expect(r).toEqual({ ok: true, note: { version: '0.1.1', date: '2026-11-26', notes: ['One.', 'Two.'], downloadUrl: GOOD } });
  });
  it('refuses an equal or lower version, a bad version, too many or long notes, no note, a bad link, a bad date', () => {
    const cases: [string, Parameters<typeof nextReleaseNote>[1]][] = [
      ['greater', { ...input, version: '0.1.0' }],
      ['greater', { ...input, version: '0.0.9' }],
      ['x.y.z', { ...input, version: '0.2' }],
      ['--note', { ...input, notes: [] }],
      ['--note', { ...input, notes: ['1', '2', '3', '4', '5', '6'] }],
      ['--note', { ...input, notes: ['x'.repeat(121)] }],
      ['--url', { ...input, url: 'https://example.com/x' }],
      ['--url', { ...input, url: 'http://drive.google.com/x' }],
      ['date', { ...input, date: 'today' }],
    ];
    for (const [word, bad] of cases) {
      const r = nextReleaseNote({ version: '0.1.0' }, bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem).toContain(word);
    }
  });
  it('accepts any version when there is no file', () => {
    expect(nextReleaseNote(null, input).ok).toBe(true);
  });
  it('a file it wrote is read back by the app', () => {
    const r = nextReleaseNote({ version: '0.1.0' }, input);
    if (!r.ok) throw new Error(r.problem);
    expect(parseReleaseNote(JSON.stringify(r.note, null, 2))!.note).toEqual(r.note);
  });
});
