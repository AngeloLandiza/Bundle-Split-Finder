// Nov 25: a new app version brings the Chrome helper along. The agent unpacks the shipped helper into the folder Chrome loaded
// the connected helper from (when that folder is Split Finder's own), then queues the reload; once per shipped build; never a
// loop; and when it cannot, the one button is "Install the helper again". A real temp folder stands for the helper folder and a
// fake unpack for the zip. No network.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentState } from '../../core/src/api/contract';
import { createAgent, type Agent } from '../app';
import { extensionIdForPath, fileTried, folderForExtension, HelperUpdate, isHelperFolder, RELOAD_GRACE_MS, UPDATED_LINE, updateHelperFolder } from '../helperUpdate';

const SHIPPED = '0.1.0+new0001';
const OLD = '0.1.0+old0001';

const manifestOf = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ manifest_version: 3, name: 'Split Finder', version: '0.1.0', version_name: OLD, permissions: ['storage'], host_permissions: ['https://www.homedepot.com/*'], ...over });

/** A helper folder as Chrome loads it. */
function helperFolder(over: Record<string, unknown> = {}, background = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'sf-helperdir-'));
  writeFileSync(join(dir, 'manifest.json'), manifestOf(over));
  if (background) writeFileSync(join(dir, 'background.js'), '// old');
  writeFileSync(join(dir, 'stale.js'), '// a file the new build no longer has');
  return dir;
}

/** The fake unzip: the shipped helper's files. */
const unpackShipped = (_zip: string, dest: string): void => {
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'manifest.json'), manifestOf({ version_name: SHIPPED }));
  writeFileSync(join(dest, 'background.js'), '// new');
};

describe('the extension id of an unpacked folder', () => {
  it("is Chrome's: sha256 of the path, first 16 bytes, each nibble a letter from a (checked against a real Chrome profile)", () => {
    expect(extensionIdForPath('/Users/angelolandiza/Developer/GitHub/Bundle-Split-Finder/.output/chrome-mv3', 'darwin')).toBe('pncffneifndbhhaenincconbldjlbjga');
    expect(extensionIdForPath('/a', 'linux')).toMatch(/^[a-p]{32}$/);
    // Windows hashes the UTF-16 path, so the same text gives another id there.
    expect(extensionIdForPath('C:\\Users\\a\\Documents\\split-finder', 'win32')).not.toBe(extensionIdForPath('C:\\Users\\a\\Documents\\split-finder', 'linux'));
  });

  it('finds the one folder that hashes to the helper id, and none for another id', () => {
    const dir = helperFolder();
    const other = helperFolder();
    const id = extensionIdForPath(dir);
    expect(folderForExtension(id, [other, dir])).toBe(dir);
    expect(folderForExtension(id, [other])).toBeNull();
    expect(folderForExtension('a'.repeat(32), [dir, other])).toBeNull();
    // A link to the folder: Chrome may have been given either spelling.
    expect(folderForExtension(extensionIdForPath(realpathSync.native(dir)), [dir])).toBe(dir);
  });
});

describe("is this Split Finder's helper folder", () => {
  it('a right manifest with its files is; another extension, no manifest, no background.js and a broken manifest are not', () => {
    expect(isHelperFolder(helperFolder()).ok).toBe(true);
    expect(isHelperFolder(helperFolder({ name: 'Split Finder Helper' })).ok).toBe(true);
    expect(isHelperFolder(helperFolder({ name: 'Some Other Extension' })).ok).toBe(false);
    expect(isHelperFolder(helperFolder({ host_permissions: ['https://example.com/*'] })).ok).toBe(false);
    expect(isHelperFolder(helperFolder({}, false)).ok).toBe(false);
    expect(isHelperFolder(mkdtempSync(join(tmpdir(), 'sf-empty-'))).ok).toBe(false);
    const broken = mkdtempSync(join(tmpdir(), 'sf-broken-'));
    writeFileSync(join(broken, 'manifest.json'), '{ not json');
    expect(isHelperFolder(broken).ok).toBe(false);
  });
});

describe('updating the folder', () => {
  it("replaces the helper's files with the shipped ones, and leaves nothing of the old build", () => {
    const dir = helperFolder();
    expect(updateHelperFolder('x.zip', dir, SHIPPED, unpackShipped)).toEqual({ ok: true });
    expect(readFileSync(join(dir, 'background.js'), 'utf8')).toBe('// new');
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).version_name).toBe(SHIPPED);
    expect(existsSync(join(dir, 'stale.js'))).toBe(false);
  });

  it("never writes into a folder that is not the helper's, and never makes one", () => {
    const foreign = helperFolder({ name: 'Notes' });
    const out = updateHelperFolder('x.zip', foreign, SHIPPED, unpackShipped);
    expect(out.ok).toBe(false);
    expect(readFileSync(join(foreign, 'background.js'), 'utf8')).toBe('// old');
    expect(existsSync(join(foreign, 'stale.js'))).toBe(true);
    const missing = join(tmpdir(), `sf-missing-${Date.now()}`);
    expect(updateHelperFolder('x.zip', missing, SHIPPED, unpackShipped).ok).toBe(false);
    expect(existsSync(missing)).toBe(false);
  });

  it('a zip that cannot be unpacked, or is not the build it should be, leaves the folder as it was', () => {
    const dir = helperFolder();
    expect(updateHelperFolder('x.zip', dir, SHIPPED, () => { throw new Error('unzip failed'); })).toMatchObject({ ok: false, why: 'unzip failed' });
    expect(updateHelperFolder('x.zip', dir, '0.1.0+other', unpackShipped).ok).toBe(false);
    expect(readFileSync(join(dir, 'background.js'), 'utf8')).toBe('// old');
    expect(existsSync(join(dir, 'stale.js'))).toBe(true);
  });
});

describe('the rule: once per shipped build, and never a loop', () => {
  function rig(over: { zip?: string | null; candidates?: string[] } = {}) {
    const clock = { at: 1_000_000 };
    const said: string[] = [];
    const reloads = { n: 0 };
    const triedMap = new Map<string, number>();
    const make = () =>
      new HelperUpdate({
        shipped: SHIPPED, zip: () => (over.zip === undefined ? 'x.zip' : over.zip), candidates: () => over.candidates ?? [], now: () => clock.at,
        tried: { get: (b) => triedMap.get(b), add: (b, at) => void triedMap.set(b, at) },
        queueReload: () => void reloads.n++, say: (t) => void said.push(t), unpack: unpackShipped,
      });
    return { clock, said, reloads, triedMap, make, update: make() };
  }

  it('updates the helper folder, says so in Activity, queues one reload, and shows "updating" until the new build reports', () => {
    const dir = helperFolder();
    const r = rig({ candidates: [dir] });
    r.update.contact(extensionIdForPath(dir), OLD);
    expect(r.said).toEqual([UPDATED_LINE]);
    expect(r.reloads.n).toBe(1);
    expect(r.update.state()).toEqual({ state: 'updating' });
    // The helper reports again, still old, inside the time it needs: no second update, no second reload.
    r.clock.at += 5_000;
    r.update.contact(extensionIdForPath(dir), OLD);
    expect(r.reloads.n).toBe(1);
    expect(r.said).toHaveLength(1);
    // The new build reports: nothing to show.
    r.update.contact(extensionIdForPath(dir), SHIPPED);
    expect(r.update.state()).toBeNull();
  });

  it('after the update and reload the helper still reports the old build: it stops, and the button is Install the helper again', () => {
    const dir = helperFolder();
    const r = rig({ candidates: [dir] });
    r.update.contact(extensionIdForPath(dir), OLD);
    r.clock.at += RELOAD_GRACE_MS + 1;
    expect(r.update.state()).toMatchObject({ state: 'install' });
    // It keeps reporting the old build: nothing more is written, queued or said.
    r.update.contact(extensionIdForPath(dir), OLD);
    r.update.contact(extensionIdForPath(dir), OLD);
    expect(r.reloads.n).toBe(1);
    expect(r.said).toHaveLength(1);
    expect(r.update.state()).toMatchObject({ state: 'install' });
  });

  it('a restart does not try the same build again: it shows the failure after the time, the wait before it', () => {
    const dir = helperFolder();
    const r = rig({ candidates: [dir] });
    r.update.contact(extensionIdForPath(dir), OLD);
    const restarted = r.make();
    r.clock.at += 10_000;
    restarted.contact(extensionIdForPath(dir), OLD);
    expect(restarted.state()).toEqual({ state: 'updating' });
    const later = r.make();
    r.clock.at += RELOAD_GRACE_MS;
    later.contact(extensionIdForPath(dir), OLD);
    expect(later.state()).toMatchObject({ state: 'install' });
    expect(r.reloads.n).toBe(1);
    expect(r.said).toHaveLength(1);
  });

  it('a folder the app does not know, one that is not the helper, and a missing zip each say so and write nothing', () => {
    const known = helperFolder();
    const foreign = helperFolder({ name: 'Notes' });
    const unknown = rig({ candidates: [known] });
    unknown.update.contact('a'.repeat(32), OLD);
    expect(unknown.update.state()).toMatchObject({ state: 'install', why: expect.stringContaining('which folder') });
    const notHelper = rig({ candidates: [foreign] });
    notHelper.update.contact(extensionIdForPath(foreign), OLD);
    expect(notHelper.update.state()).toMatchObject({ state: 'install', why: expect.stringContaining('not Split Finder') });
    expect(readFileSync(join(foreign, 'background.js'), 'utf8')).toBe('// old');
    const noZip = rig({ candidates: [known], zip: null });
    noZip.update.contact(extensionIdForPath(known), OLD);
    expect(noZip.update.state()).toMatchObject({ state: 'install' });
    expect(readFileSync(join(known, 'background.js'), 'utf8')).toBe('// old');
    for (const r of [unknown, notHelper, noZip]) {
      expect(r.reloads.n).toBe(0);
      expect(r.said).toEqual([]);
    }
  });

  it('a new shipped build is tried afresh (the record is per build), and the record is a file that survives a restart', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sf-tried-')), 'helper-update.json');
    const a = fileTried(file);
    expect(a.get('b1')).toBeUndefined();
    a.add('b1', 5);
    expect(fileTried(file).get('b1')).toBe(5);
    expect(fileTried(file).get('b2')).toBeUndefined();
    writeFileSync(file, 'junk');
    expect(fileTried(file).get('b1')).toBeUndefined();
  });
});

// ------------------------------------------------------------ through the agent

describe('through the agent', () => {
  let server: Server;
  let agent: Agent;
  let base: string;
  let dir: string;
  let id: string;
  let token: string;
  const was = { dir: process.env.SPLIT_FINDER_EXTENSION_DIR, zip: process.env.SPLIT_FINDER_EXTENSION_ZIP };

  beforeEach(async () => {
    dir = helperFolder();
    id = extensionIdForPath(dir);
    const zip = join(mkdtempSync(join(tmpdir(), 'sf-zip-')), 'split-finder-0.1.0-chrome.zip');
    writeFileSync(zip, 'zip');
    process.env.SPLIT_FINDER_EXTENSION_DIR = dir;
    process.env.SPLIT_FINDER_EXTENSION_ZIP = zip;
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
    agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-helper-agent-')), port, timers: false, shippedHelperVersion: SHIPPED, helperUnpack: unpackShipped });
    server.on('request', agent.handle);
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { Origin: `chrome-extension://${id}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const { requestId, claimSecret } = (await (await post('/api/pair/request', { extensionId: id })).json()) as { requestId: string; claimSecret: string };
    await post('/api/pair/claim', { requestId, claimSecret });
    await fetch(`${base}/api/pair/approve`, { method: 'POST', headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }) });
    token = ((await (await post('/api/pair/claim', { requestId, claimSecret })).json()) as { token: string }).token;
  });

  afterEach(async () => {
    agent.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [k, v] of [['SPLIT_FINDER_EXTENSION_DIR', was.dir], ['SPLIT_FINDER_EXTENSION_ZIP', was.zip]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const beat = (version: string) => fetch(`${base}/api/worker/heartbeat`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: `chrome-extension://${id}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version }) });
  const helperState = async () => ((await (await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${agent.auth.uiToken}` } })).json()) as AgentState).helper;
  const reloads = () => agent.store.get('jobs').filter((j) => j.kind === 'reload');

  it('an old helper loaded from the install folder is updated there, with one reload and one Activity line', async () => {
    await beat(OLD);
    expect(readFileSync(join(dir, 'background.js'), 'utf8')).toBe('// new');
    expect(reloads()).toHaveLength(1);
    expect(await helperState()).toMatchObject({ outdated: true, version: OLD, update: { state: 'updating' } });
    expect(agent.store.get('activity').runs.filter((r) => r.summary === UPDATED_LINE)).toHaveLength(1);
    // The same old build again (the heartbeat repeats): nothing more happens.
    await beat(OLD);
    expect(reloads()).toHaveLength(1);
    expect(agent.store.get('activity').runs.filter((r) => r.summary === UPDATED_LINE)).toHaveLength(1);
    // Reloaded: the new build reports and the notice goes.
    await beat(SHIPPED);
    const h = await helperState();
    expect(h).not.toHaveProperty('outdated');
    expect(h).not.toHaveProperty('update');
  });

  it('an old helper from another folder than the install folder is not written to: the state says to install it again', async () => {
    process.env.SPLIT_FINDER_EXTENSION_DIR = helperFolder();
    await beat(OLD);
    expect(readFileSync(join(dir, 'background.js'), 'utf8')).toBe('// old');
    expect(reloads()).toHaveLength(0);
    expect(await helperState()).toMatchObject({ outdated: true, update: { state: 'install' } });
  });
});
