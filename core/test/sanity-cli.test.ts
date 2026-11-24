// npm run audit:sanity (scripts/sanity-cli.ts) on a data folder and on the desktop app's audit export. Files only.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runSanityCli } from '../../scripts/sanity-cli';
import { AFTER_SCAN3, AFTER_SCAN5, dealsOf, FIXTURES, storeWithWrongListing, WRONG_SET } from './sanity-world';

const run = (...args: string[]) => {
  const out: string[] = [];
  const code = runSanityCli(args, { log: (s) => out.push(s) });
  return { code, text: out.join('\n') };
};

describe('npm run audit:sanity', () => {
  it('after-scan5: three holds on the PCL702B deal, exit 1, with the Home Depot and Amazon links', () => {
    const { code, text } = run(AFTER_SCAN5);
    expect(code).toBe(1);
    expect(text).toContain('Checked ');
    expect(text).toContain('258 deals');
    expect(text).toMatch(/hold\s+title_extra_model\s+HD 344284497\s+PCL702B\s+B0FD253MKS/);
    expect(text).toContain('3 findings: 3 holds on 1 deal, 0 notes.');
    expect(text).toContain('Amazon listing: https://www.amazon.com/dp/B0FD253MKS');
    expect(text).toContain('Home Depot PCL702B sold alone: https://www.homedepot.com/p/319962861');
  });

  it('after-scan3: nothing to look at, exit 0', () => {
    expect(run(AFTER_SCAN3)).toEqual({ code: 0, text: expect.stringContaining('Nothing to look at.') });
  });

  it("the desktop app's audit export (GET /api/export/audit): the real wrong listing is held; what he marked right is left out unless --all", async () => {
    const bundles = await dealsOf(await storeWithWrongListing());
    const dir = mkdtempSync(join(tmpdir(), 'sf-sanity-'));
    const file = join(dir, 'split-finder-audit-2026-11-24.json');
    writeFileSync(file, JSON.stringify({ kind: 'split-finder-audit', exportedAt: '2026-11-24T12:00:00.000Z', deals: { at: null, bundles }, tracking: { sanityCleared: ['listing|RYOBI:PCL702B|B0FD253MKS'] } }));
    const { code, text } = run(file);
    expect(code).toBe(1);
    expect(text).toContain('1 marked right by the owner left out');
    expect(text).toMatch(/hold\s+title_other_model\s+HD 339422000\s+DWST08017\s+B0DGLWKS9S/);
    expect(text).not.toContain('PCL702B');
    expect(text).toContain(`- ${WRONG_SET} DWST08017: Home Depot bundle:`);
    expect(run(file, '--all').text).toContain('PCL702B');
  });

  it("refuses the extension's export (no deals) and a missing path, exit 2", () => {
    const ext = run(join(FIXTURES, 'audit', 'split-finder-audit-2026-11-18.json'));
    expect(ext).toEqual({ code: 2, text: expect.stringContaining("is the extension's audit export: it holds no deals") });
    expect(run().code).toBe(2);
    expect(run(join(FIXTURES, 'no-such-folder')).code).toBe(2);
  });
});
