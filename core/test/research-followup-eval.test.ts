// Step 16: `research:eval --follow-up` (scripts/research-followup-eval.ts). The dry run is free and reads no key; a run with
// a fake model and a fake Chrome writes its file into a temp folder, and a replay of it scores the same. No network.

import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ResearchModel, ResearchTurn } from '../src/research/types';
import type { ChromeReader } from '../../scripts/research-chrome';
import { runResearchEval } from '../../scripts/research-eval-cli';
import type { FollowUpRunsFile } from '../../scripts/research-followup-eval';

const quiet = () => {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
};

const cannotTell: ResearchTurn = {
  ok: true, stopReason: 'tool_use', usage: { inputTokens: 3000, outputTokens: 200, webSearchRequests: 0 },
  content: [{ type: 'tool_use', id: 'toolu_s', name: 'submit_answer', input: { quotes: [], parts: [], reason: 'r', decision: 'cannot_tell', choiceIndex: null } }],
};

function tempWithFirstAsks(): string {
  const out = mkdtempSync(join(tmpdir(), 'followup-eval-'));
  copyFileSync('fixtures/research/runs-claude-opus-5-5.json', join(out, 'runs-claude-opus-5-5.json'));
  return out;
}

describe('npm run research:eval -- --follow-up', () => {
  it('a dry run reads no key: the scores before and after the free part of the loop, what it read, and the estimate', async () => {
    const { log, lines } = quiet();
    const env = vi.fn(() => undefined);
    expect(await runResearchEval(['--model', 'claude-opus-5-5', '--follow-up', '--dry-run'], { log, dir: 'fixtures', env })).toBe(0);
    expect(env).not.toHaveBeenCalled();
    expect(lines).toContain('Before the loop: verified right 7, verified wrong 0, unverified 8, cannot tell 4 (of 19).');
    // 328690510 (PCL500B + PCL525B; the key agrees) verifies by the code's check alone once PCL525B's row is read.
    expect(lines).toContain('After the loop:  verified right 8, verified wrong 0, unverified 7, cannot tell 4 (of 19).');
    expect(lines).toContain('  split:homedepot:328690510  first unverified → verified_correct (parts PCL500B, PCL525B), by the code\'s check alone');
    expect(lines.some((l) => l.startsWith('Would ask again: 3 questions'))).toBe(true);
  });

  it('a run with a fake model and a fake Chrome writes its file and records the Chrome reads; a replay scores the same, free', async () => {
    const outDir = tempWithFirstAsks();
    const sent: number[] = [];
    const model: ResearchModel = { provider: 'claude', model: 'claude-opus-5-5', send: async () => { sent.push(1); return cannotTell; } };
    const chrome: ChromeReader = {
      search: async (query) => ({ sourceId: `hd-search:${query.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, label: 'Home Depot search', url: `https://www.homedepot.com/s/${encodeURIComponent(query)}`, results: [] }),
      page: async () => ({ error: 'Home Depot refused the page (HTTP 403).' }),
    };
    const run = quiet();
    expect(await runResearchEval(['--model', 'claude-opus-5-5', '--follow-up', '--fresh-tools', '--run', '--max-cost', '1'], {
      log: run.log, dir: 'fixtures', outDir, env: (n) => (n === 'ANTHROPIC_API_KEY' ? 'sk-ant-test' : undefined), makeModel: () => model, chrome,
      now: () => new Date('2026-11-23T12:00:00Z'),
    })).toBe(0);
    expect(run.lines.find((l) => l.startsWith('After the loop'))).toMatch(/verified wrong 0/);
    // Reads the recordings already hold (fixtures/research/tools/followup-chrome.json, the main session's run) are not made again;
    // any other goes to Chrome and is recorded beside the temp folder's runs, never in fixtures/.
    const made = Number(/Reads made in Chrome: (\d+)/.exec(run.lines.join('\n'))?.[1] ?? 'NaN');
    expect(made).toBeGreaterThanOrEqual(0);
    expect(existsSync(join(outDir, 'tools', 'followup-chrome.json'))).toBe(made > 0);
    expect(sent.length).toBeGreaterThan(0);
    const doc = JSON.parse(readFileSync(join(outDir, 'followup-claude-opus-5-5.json'), 'utf8')) as FollowUpRunsFile;
    expect(doc.promptVersion).toMatch(/\+followup\.1$/);
    expect(doc.results.some((r) => r.asks.length > 0)).toBe(true);
    const replay = quiet();
    expect(await runResearchEval(['--model', 'claude-opus-5-5', '--follow-up', '--replay'], { log: replay.log, dir: 'fixtures', outDir, env: () => undefined })).toBe(0);
    expect(replay.lines.find((l) => l.startsWith('After the loop'))).toBe(run.lines.find((l) => l.startsWith('After the loop')));
  });
});
