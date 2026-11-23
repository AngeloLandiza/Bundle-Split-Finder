// `research:eval --follow-up --fresh-tools`: Home Depot reads a follow-up needs that no recording holds, made through the
// owner's own Chrome as the app makes them (the running desktop agent's worker jobs: POST /api/worker/jobs with kind
// `search` or `researchPage`, then GET /api/worker/jobs/:id until it is done), and recorded on first use into
// fixtures/research/tools/followup-chrome.json, so the next run (and --replay) reads the file and not Chrome.
//
// Free: Home Depot pages, no SerpApi, no Keepa, no AI. Only 127.0.0.1. The app's token is read from its data folder
// (<data>/agent-token, owner-only) and sent only to the agent; it is never printed or written anywhere.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { AGENT_PORT } from '../core/src/api/contract';
import type { HomeDepotPage, HomeDepotSearch, ResearchTools, ToolError } from '../core/src/research/types';
import type { RecordedSources, ResearchToolsFile, ToolCallLog } from './research-tools';

export const FRESH_FILE = 'followup-chrome.json';

/** The installed app's bundle identifier: Tauri's app_data_dir is the platform's data folder joined with it (desktop/dev-agent.mjs). */
const IDENTIFIER = 'com.bundlesplitfinder.desktop';

/** Tauri 2's app_data_dir for the installed app, where its agent keeps agent-token. */
export function installedAppDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', IDENTIFIER);
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), IDENTIFIER);
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), IDENTIFIER);
}

/**
 * The data folder whose agent-token reaches the running agent: SPLIT_FINDER_DATA_DIR when set; else the development agent's
 * (./output, agent/paths.ts) when it has a token; else the installed app's (the main session's first run failed every read
 * with "No agent token in ./output" while the installed app was the one running).
 */
export function agentTokenDir(opts: { env?: NodeJS.ProcessEnv; devDir: string; installedDir?: string; exists?: (p: string) => boolean }): string {
  const env = opts.env ?? process.env;
  if (env.SPLIT_FINDER_DATA_DIR) return env.SPLIT_FINDER_DATA_DIR;
  const exists = opts.exists ?? existsSync;
  if (exists(join(opts.devDir, 'agent-token'))) return opts.devDir;
  return opts.installedDir ?? installedAppDataDir();
}
const POLL_MS = 1_000;
const WAIT_MS = 120_000;

export interface ChromeReader {
  search(query: string): Promise<HomeDepotSearch | ToolError>;
  page(itemId: string): Promise<HomeDepotPage | ToolError>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The owner's Chrome through the running agent. `dataDir` holds agent-token. */
export function agentChrome(opts: { dataDir: string; base?: string; fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void> }): ChromeReader {
  const base = opts.base ?? `http://127.0.0.1:${process.env.AGENT_PORT ?? AGENT_PORT}`;
  if (!/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(base)) throw new Error('The agent is reached on 127.0.0.1 only.');
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tokenFile = join(opts.dataDir, 'agent-token');
  const token = (): string => {
    if (!existsSync(tokenFile)) throw new Error(`No agent token in ${opts.dataDir}: start the app first.`);
    return readFileSync(tokenFile, 'utf8').trim();
  };
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetchFn(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new Error(`The agent answered ${res.status}.`);
    return res.json();
  };
  const job = async (kind: 'search' | 'researchPage', input: unknown): Promise<unknown> => {
    const queued = await call('POST', '/api/worker/jobs', { kind, input });
    const id = isRecord(queued) && typeof queued.id === 'string' ? queued.id : null;
    if (!id) throw new Error('The agent did not queue the job.');
    for (let waited = 0; waited < WAIT_MS; waited += POLL_MS) {
      await sleep(POLL_MS);
      const j = await call('GET', `/api/worker/jobs/${encodeURIComponent(id)}`);
      if (isRecord(j) && j.status === 'done') return j.result;
      if (isRecord(j) && j.status === 'failed') return { error: typeof j.error === 'string' ? j.error : 'Chrome could not read it.' };
    }
    return { error: 'Chrome did not answer in time.' };
  };
  const asError = (e: unknown): ToolError => ({ error: e instanceof Error ? e.message : 'Chrome could not read it.' });
  return {
    search: async (query) => {
      try {
        const r = await job('search', { query, page: 1 });
        return isRecord(r) && (Array.isArray(r.results) || typeof r.error === 'string') ? (r as unknown as HomeDepotSearch | ToolError) : { error: 'The search came back in a form that could not be read.' };
      } catch (e) {
        return asError(e);
      }
    },
    page: async (itemId) => {
      try {
        const r = await job('researchPage', { itemId });
        return isRecord(r) && (isRecord(r.sections) || typeof r.error === 'string') ? (r as unknown as HomeDepotPage | ToolError) : { error: 'The page came back in a form that could not be read.' };
      } catch (e) {
        return asError(e);
      }
    },
  };
}

const queryKey = (q: string): string => q.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The recorded tools, with what they do not hold read through Chrome and recorded: a page with no recording, and a search not
 * recorded word for word (the recorded index answers neither: a follow-up wants Home Depot's own answer). A read that failed
 * is not recorded. `file` is fixtures/research/tools/followup-chrome.json; `sources` gets each new read at once.
 */
export function freshTools(recorded: ResearchTools, sources: RecordedSources, chrome: ChromeReader, file: string, log: ToolCallLog[], fresh: { reads: number }): ResearchTools {
  const load = (): ResearchToolsFile => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as ResearchToolsFile : {
    about: "Home Depot pages and searches a follow-up needed (research:eval --follow-up --fresh-tools), read in the owner's Chrome through the agent's worker jobs, recorded on first use.",
    pages: {}, searches: {},
  });
  const save = (doc: ResearchToolsFile) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
  };
  return {
    ...recorded,
    async readHomeDepotPage(input, signal) {
      const id = input.itemId ?? /\/(\d{6,12})(?:[/?#]|$)/.exec(input.url ?? '')?.[1];
      if (!id || sources.pages.has(id)) return recorded.readHomeDepotPage(input, signal);
      const r = await chrome.page(id);
      fresh.reads += 1;
      log.push({ tool: 'readHomeDepotPage', input, recorded: false, source: 'not recorded', result: r });
      if (!('error' in r)) {
        sources.pages.set(id, r);
        const doc = load();
        save({ ...doc, pages: { ...(doc.pages ?? {}), [id]: r } });
      }
      return r;
    },
    async searchHomeDepot(input, signal) {
      if (sources.searches.has(queryKey(input.query))) return recorded.searchHomeDepot(input, signal);
      const r = await chrome.search(input.query);
      fresh.reads += 1;
      log.push({ tool: 'searchHomeDepot', input, recorded: false, source: 'not recorded', result: r });
      if (!('error' in r)) {
        sources.searches.set(queryKey(input.query), r);
        for (const row of r.results) if (!sources.products.some((p) => p.itemId === row.itemId)) sources.products.push(row);
        const doc = load();
        save({ ...doc, searches: { ...(doc.searches ?? {}), [input.query]: r } });
      }
      return r;
    },
  };
}

/** Tools for a dry run of --fresh-tools: what is not recorded answers "would be read in Chrome", and is counted. */
export function plannedTools(recorded: ResearchTools, sources: RecordedSources, planned: string[]): ResearchTools {
  return {
    ...recorded,
    async readHomeDepotPage(input, signal) {
      const id = input.itemId ?? /\/(\d{6,12})(?:[/?#]|$)/.exec(input.url ?? '')?.[1];
      if (!id || sources.pages.has(id)) return recorded.readHomeDepotPage(input, signal);
      planned.push(`page ${id}`);
      return { error: 'would be read in Chrome (dry run)' };
    },
    async searchHomeDepot(input, signal) {
      if (sources.searches.has(queryKey(input.query))) return recorded.searchHomeDepot(input, signal);
      planned.push(`search "${input.query}"`);
      return { error: 'would be read in Chrome (dry run)' };
    },
  };
}
