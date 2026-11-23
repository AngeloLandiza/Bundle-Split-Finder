import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plainNote, plainReason } from './questionWords';

const dewalt = { brand: 'DEWALT', model: 'DCK240C2DCS380B' };
const ryobi = { brand: 'RYOBI', model: 'PCL1600K2-P553' };

describe('plain words for why a question is asked', () => {
  it('says a model number tail Amazon’s list does not know', () => {
    expect(plainNote("'DCS380B' matches nothing in the catalog", dewalt)).toBe('The model number ends in DCS380B, which is not on Amazon’s list of DEWALT tools yet.');
  });

  it('names the two items a hyphenated model number reads as', () => {
    expect(plainNote('hyphen split, but a part is not in the catalog', ryobi)).toBe('The model number reads as two items (PCL1600K2 + P553), but one of them is not on Amazon’s list of RYOBI tools yet.');
  });

  it('does not invent the two items when the model number has no clean hyphen split', () => {
    expect(plainNote('hyphen split, but a part is not in the catalog', { brand: 'RYOBI', model: 'PCL1-A-B' })).toBe('The model number reads as two items, but one of them is not on Amazon’s list of RYOBI tools yet.');
  });

  it('says contains, not ends in, when the tail is not at the end', () => {
    expect(plainNote("'DCS380B' matches nothing in the catalog", { brand: 'DEWALT', model: 'DCS380BKIT' })).toMatch(/contains DCS380B/);
  });

  it('says what a page that names no models means, and an unknown bundle pattern', () => {
    expect(plainNote('page names no models', ryobi)).toBe('Home Depot’s page does not list the model numbers of what is inside.');
    expect(plainNote('no known RYOBI bundle pattern', ryobi)).toBe('This model number does not follow a pattern Split Finder knows.');
  });

  it('joins several notes and keeps the agent’s note as the technical detail', () => {
    const r = plainReason("'DCS380B' matches nothing in the catalog; page names no models", dewalt);
    expect(r.text).toBe('The model number ends in DCS380B, which is not on Amazon’s list of DEWALT tools yet. Home Depot’s page does not list the model numbers of what is inside.');
    expect(r.technical).toBe("'DCS380B' matches nothing in the catalog; page names no models");
  });

  it('passes an unknown note through unchanged and shows no technical detail when nothing was reworded', () => {
    expect(plainReason('The listing says “New (other)” and shows no box.', dewalt)).toEqual({ text: 'The listing says “New (other)” and shows no box.', technical: null });
  });

  it('rewords the notes it knows and leaves one it does not know as written', () => {
    const r = plainReason('page names no models; something new the agent says', dewalt);
    expect(r.text).toBe('Home Depot’s page does not list the model numbers of what is inside. something new the agent says');
    expect(r.technical).toBe('page names no models; something new the agent says');
  });

  it('knows every note in the recorded review questions', () => {
    const rec = JSON.parse(readFileSync(new URL('../../../fixtures/e2e-2026-11-23/store/review.json', import.meta.url), 'utf8')) as { questions: { brand: string; model: string; reason: string }[] };
    expect(rec.questions.length).toBeGreaterThan(10);
    const kinds = new Set<string>();
    for (const q of rec.questions) {
      for (const note of q.reason.split(';').map((n) => n.trim())) {
        kinds.add(note.replace(/'[^']+'/, "'X'"));
        expect(plainNote(note, { brand: q.brand, model: q.model }), `${q.model}: ${note}`).not.toBeNull();
      }
      const r = plainReason(q.reason, { brand: q.brand, model: q.model });
      expect(r.technical).toBe(q.reason);
      expect(r.text).not.toMatch(/catalog|matches nothing|hyphen split/);
    }
    // Four distinct notes are recorded; guards the test against a fixture that quietly lost its variety.
    expect(kinds.size).toBe(4);
  });
});
