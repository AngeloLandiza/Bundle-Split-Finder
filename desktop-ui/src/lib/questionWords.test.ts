import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plainNote, plainReason } from './questionWords';

const dewalt = { brand: 'DEWALT', model: 'DCK240C2DCS380B' };
const ryobi = { brand: 'RYOBI', model: 'PCL1600K2-P553' };

describe('plain words for why a question is asked', () => {
  it('Nov 23: words every note of the third real scan\'s open questions, with the real examples', () => {
    const dcf = { brand: 'DEWALT', model: 'DCK540D1WCF860B' };
    expect(plainNote('1 listing(s) show the model number, but the brand is not confirmed', dcf)).toBe('One Amazon listing shows the model number, but it does not say it is DEWALT.');
    expect(plainReason('2 listing(s) show the model number, but the brand is not confirmed; title says Replacement or OEM, which often marks a spare part', { brand: 'DEWALT', model: 'DCK540D1WCH172B' }).text).toBe(
      '2 Amazon listings show the model number, but none says it is DEWALT. A listing’s title says Replacement or OEM, which often means a spare part, not the tool.',
    );
    expect(plainNote('title says kit, and a RYOBI model number does not say whether the part is itself a kit', ryobi)).toBe('A listing’s title says kit, and the model number alone does not say whether this part is a kit.');
    expect(plainNote('page names PBP003, which none of the parts explains', { brand: 'RYOBI', model: 'PCL1600K2-PBP2003' })).toBe('Home Depot’s page also names PBP003, which is not one of the parts the model number gives.');
    expect(plainNote("Home Depot's search found no A986501 sold by itself", { brand: 'RYOBI', model: 'PCL1600K2-A986501' })).toBe('Home Depot does not sell A986501 on its own, so its page cannot confirm what is inside.');
    expect(plainNote('3 more listing(s) not shown', dcf)).toBe('3 more Amazon listings are not shown.');
    expect(plainNote('model number in the title, brand not confirmed', dcf)).toBe('The listing’s title has the model number, but it does not say it is DEWALT.');
  });

  it('Nov 23: every note in the real scans\' review files is worded; none reaches the owner as the agent wrote it', () => {
    for (const file of ['after-scan3/store/review.json', 'store/review.json']) {
      const review = JSON.parse(readFileSync(new URL(`../../../fixtures/e2e-2026-11-23/${file}`, import.meta.url), 'utf8')) as { questions: { reason: string; brand: string; model: string }[] };
      for (const q of review.questions) {
        for (const note of q.reason.split(';').map((n) => n.trim()).filter(Boolean)) expect(plainNote(note, q), note).not.toBeNull();
      }
    }
  });

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
