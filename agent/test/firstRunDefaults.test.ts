// What a NEW install starts with so the agent can work by itself (Welcome's "Let it run by itself"): messages on for deals
// worth buying and for questions that need an answer, a digest after each run, the computer kept awake during a scan.
// An install that already has settings keeps every choice the owner made.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Store } from '../store';

const open: Store[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});
const openStore = (dir: string): Store => {
  const s = Store.open(dir);
  open.push(s);
  return s;
};

describe('first-run defaults of a new install', () => {
  it('deals worth buying and open questions notify, one digest after each run, keep awake on, schedule manual until Welcome turns it on', () => {
    const s = openStore(mkdtempSync(join(tmpdir(), 'sf-first-'))).get('settings');
    expect(s.alerts).toMatchObject({ enabled: true, reviewDigest: true });
    expect(s.notifications.kinds).toMatchObject({ deal: true, review: true });
    expect(s.notifications.digest).toBe('each-run');
    expect(s.shell.keepAwakeDuringScan).toBe(true);
    // Nothing spends searches until the owner says so (Welcome, or Settings).
    expect(s.settings.schedule).toEqual({ mode: 'manual' });
    expect(s.shell.launchAtLogin).toBe(false);
  });

  it('a store that already has choices keeps them, and one from before keepAwakeDuringScan gets only that new default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-first-'));
    const first = openStore(dir);
    first.update('settings', (cur) => ({
      ...cur,
      alerts: { ...cur.alerts, enabled: false, reviewDigest: false },
      notifications: { ...cur.notifications, digest: 'morning', kinds: { ...cur.notifications.kinds, deal: false, review: false } },
      settings: { ...cur.settings, schedule: { mode: 'interval', hours: 12 } },
    }));
    first.close();
    // The file as an earlier version wrote it: a shell block without the new switch.
    const file = join(dir, 'store', 'settings.json');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { data?: Record<string, unknown> } & Record<string, unknown>;
    const body = (raw.data ?? raw) as { shell?: Record<string, unknown> };
    body.shell = { menuBarIcon: false, dockIcon: true, launchAtLogin: true };
    writeFileSync(file, JSON.stringify(raw));
    const s = openStore(dir).get('settings');
    expect(s.alerts).toMatchObject({ enabled: false, reviewDigest: false });
    expect(s.notifications).toMatchObject({ digest: 'morning', kinds: { deal: false, review: false } });
    expect(s.settings.schedule).toEqual({ mode: 'interval', hours: 12 });
    expect(s.shell).toEqual({ menuBarIcon: false, dockIcon: true, launchAtLogin: true, keepAwakeDuringScan: true });
  });
});
