import { describe, expect, it } from 'vitest';

import { csvLine } from '../src/scan/csv';

// Security review, Nov 23: a Home Depot title is text from another site, and the export is opened in a spreadsheet.
// A cell that a spreadsheet would read as a formula is made inert with a leading quote; nothing else changes.

describe('CSV export cells from untrusted text', () => {
  it('makes a formula inert, however it starts', () => {
    expect(csvLine(["=cmd|' /C calc'!A0"])).toBe("'=cmd|' /C calc'!A0");
    expect(csvLine(['=HYPERLINK("https://evil.example","Click")'])).toBe(`"'=HYPERLINK(""https://evil.example"",""Click"")"`);
    expect(csvLine(['+1+1'])).toBe("'+1+1");
    expect(csvLine(['-2+3'])).toBe("'-2+3");
    expect(csvLine(['@SUM(A1:A2)'])).toBe("'@SUM(A1:A2)");
    // A tab or carriage return before the formula: spreadsheets skip it and read the formula.
    expect(csvLine(['\t=1+1'])).toBe("'\t=1+1");
    expect(csvLine(['\r=1+1'])).toBe(`"'\r=1+1"`);
  });

  it('leaves ordinary titles and numbers as they are', () => {
    expect(csvLine(['RYOBI ONE+ 18V Cordless 2-Tool Combo Kit', 199, null])).toBe('RYOBI ONE+ 18V Cordless 2-Tool Combo Kit,199,');
    expect(csvLine([-12.5])).toBe('-12.5');
    expect(csvLine(['a, b'])).toBe('"a, b"');
  });
});
