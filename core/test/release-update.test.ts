import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CHECK_EVERY_MS, checkFailedSentence, cleanNotes, cleanWhy, FIRST_CHECK_AFTER_MS, installDecision, OVERDUE_GRACE_MS,
  parseCheckReport, parsePendingReport, QUIET_BEFORE_SCAN_MS, readyMessage, type InstallInput,
} from '../src/release/update';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const base: InstallInput = { running: '0.2.0', candidate: '0.2.1', now: NOW, looking: true, automatic: true, requested: false, working: null, nextScanAt: null };
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('installDecision', () => {
  it('installs a newer version when automatic, idle and no scan is near', () => {
    expect(installDecision(base)).toEqual({ install: true });
    expect(installDecision({ ...base, nextScanAt: at(QUIET_BEFORE_SCAN_MS + 60_000) })).toEqual({ install: true });
  });

  it('never installs a version that is not newer: no downgrade, no reinstall, nothing when the running version is unknown', () => {
    for (const candidate of ['0.2.0', '0.1.9', '0.1.10']) {
      expect(installDecision({ ...base, candidate, requested: true })).toMatchObject({ install: false, wait: 'never' });
    }
    expect(installDecision({ ...base, running: null })).toMatchObject({ install: false, wait: 'never' });
    expect(installDecision({ ...base, running: '0.2.0+3c92cc7' })).toMatchObject({ install: false, wait: 'never' });
    expect(installDecision({ ...base, candidate: 'v0.3.0' })).toMatchObject({ install: false, wait: 'never' });
    // Numbers, not text: 0.2.10 is newer than 0.2.9.
    expect(installDecision({ ...base, running: '0.2.9', candidate: '0.2.10' })).toEqual({ install: true });
  });

  it('installs nothing while looking for new versions is off, even after Install now', () => {
    expect(installDecision({ ...base, looking: false, requested: true })).toMatchObject({ install: false, wait: 'never' });
  });

  it('with automatic installs off, waits for Install now, then installs when idle', () => {
    expect(installDecision({ ...base, automatic: false })).toEqual({ install: false, wait: 'owner', why: 'Waiting for you to press Install now.' });
    expect(installDecision({ ...base, automatic: false, requested: true })).toEqual({ install: true });
  });

  it('waits while anything runs, Install now included', () => {
    for (const working of ['scan', 'ask', 'paid', 'other'] as const) {
      const d = installDecision({ ...base, requested: true, working });
      expect(d).toMatchObject({ install: false, wait: 'work' });
    }
    expect(installDecision({ ...base, working: 'scan' })).toMatchObject({ why: 'It installs when nothing is running; a scan is running.' });
  });

  it('waits in the quiet window before a scheduled scan and just after its time, not otherwise', () => {
    const scan = (ms: number) => installDecision({ ...base, nextScanAt: at(ms) });
    expect(scan(QUIET_BEFORE_SCAN_MS)).toMatchObject({ install: false, wait: 'scan' });
    expect(scan(60_000)).toMatchObject({ install: false, wait: 'scan' });
    expect(scan(0)).toMatchObject({ install: false, wait: 'scan' });
    expect(scan(-OVERDUE_GRACE_MS)).toMatchObject({ install: false, wait: 'scan' });
    // Long overdue and not started: it waits for something else (Chrome, a pause), not for this install.
    expect(scan(-OVERDUE_GRACE_MS - 1)).toEqual({ install: true });
    expect(scan(QUIET_BEFORE_SCAN_MS + 1)).toEqual({ install: true });
    expect(installDecision({ ...base, nextScanAt: 'not a time' })).toEqual({ install: true });
  });
});

describe('the shell reports', () => {
  it('cleans release notes from the network: lines, no markup, no control characters, capped', () => {
    expect(cleanNotes('Fixes the scan button.\n- Reads prices faster.\n\n')).toEqual(['Fixes the scan button.', 'Reads prices faster.']);
    expect(cleanNotes('<b>Bold</b> <script>alert(1)</script>text\u0007 here <a href="x">link')).toEqual(['Bold alert(1)text here link']);
    expect(cleanNotes('a\nb\nc\nd\ne\nf\ng')).toHaveLength(5);
    const long = cleanNotes('x'.repeat(500))[0]!;
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('…')).toBe(true);
    for (const bad of [null, undefined, 42, {}, ['a']]) expect(cleanNotes(bad)).toEqual([]);
  });

  it('cleans a reason to one short line', () => {
    expect(cleanWhy('error sending request\n  for url (https://github.com/x)\u0000 <tag>')).toBe('error sending request for url (https://github.com/x) tag');
    expect(cleanWhy('y'.repeat(400)).length).toBeLessThanOrEqual(200);
    expect(cleanWhy(5)).toBe('');
  });

  it('accepts a pending report only for a plain x.y.z version', () => {
    expect(parsePendingReport({ version: '0.2.1', notes: 'One.\nTwo.' })).toEqual({ version: '0.2.1', notes: ['One.', 'Two.'] });
    for (const bad of [null, 'x', { version: 'v0.2.1' }, { version: '0.2.1-beta' }, { version: 3 }]) expect(parsePendingReport(bad)).toBeNull();
  });

  it('accepts a check report of current or failed', () => {
    expect(parseCheckReport({ outcome: 'current' })).toEqual({ outcome: 'current', why: '' });
    expect(parseCheckReport({ outcome: 'failed', why: 'offline' })).toEqual({ outcome: 'failed', why: 'offline' });
    expect(parseCheckReport({ outcome: 'failed' })).toEqual({ outcome: 'failed', why: 'no reason was given' });
    expect(parseCheckReport({ outcome: 'installed' })).toBeNull();
  });

  it('says a failure in one sentence and a ready version with what to do', () => {
    expect(checkFailedSentence('The signature verification failed.')).toBe(
      'Split Finder could not get its new version: The signature verification failed. It keeps running this version and looks again in 6 hours.',
    );
    expect(readyMessage('0.2.1', ['Fixes the scan button'])).toBe(
      'Split Finder 0.2.1 is ready. What changed: Fixes the scan button. Open Split Finder and press Install now when you like.',
    );
  });
});

describe('the shell holds the same numbers', () => {
  const rust = readFileSync(join(import.meta.dirname, '..', '..', 'src-tauri', 'src', 'updater.rs'), 'utf8');
  it('a minute after launch, then every 6 hours, at the fixed GitHub address', () => {
    expect(rust).toContain(`FIRST_CHECK_AFTER: Duration = Duration::from_secs(${FIRST_CHECK_AFTER_MS / 1000});`);
    expect(rust).toContain(`CHECK_EVERY: Duration = Duration::from_secs(${CHECK_EVERY_MS / 1000});`);
    const conf = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'src-tauri', 'tauri.conf.json'), 'utf8')) as { plugins: { updater: { endpoints: string[]; requireSignedVersion: boolean; allowDowngrades: boolean } } };
    const endpoint = 'https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/latest/download/latest.json';
    expect(conf.plugins.updater.endpoints).toEqual([endpoint]);
    expect(rust).toContain(`ENDPOINT: &str = "${endpoint}";`);
    expect(conf.plugins.updater.requireSignedVersion).toBe(true);
    expect(conf.plugins.updater.allowDowngrades).toBe(false);
  });
});
