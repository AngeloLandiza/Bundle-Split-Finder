import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { BriefModel } from '../src/brief/pipeline';
import { runBriefEval } from '../../scripts/brief-eval-cli';

// scripts/brief-eval-cli.ts on the owner's real suggestions (fixtures/e2e-2026-11-23): the dry run reads no key and calls nothing; a
// run with a fake model prints each brief with the verdict on its sentences and the total cost, and never the key.

const dir = join(import.meta.dirname, '..', '..', 'fixtures');

async function run(args: string[], over: { env?: (n: string) => string | undefined; makeModel?: (m: string, k: string) => BriefModel } = {}) {
  const lines: string[] = [];
  const code = await runBriefEval(args, { log: (l) => lines.push(l), dir, env: over.env ?? (() => undefined), sleep: async () => {}, ...(over.makeModel ? { makeModel: over.makeModel } : {}) });
  return { code, text: lines.join('\n') };
}

describe('brief:eval --dry-run', () => {
  it('prints the prompts and the estimate for the questions that have a suggestion with found quotes, and calls nothing', async () => {
    const { code, text } = await run(['--dry-run']);
    expect(code).toBe(0);
    expect(text).toContain('Questions: 10. With a suggestion and at least one quote the code found: 5');
    expect(text).toContain('--- system prompt');
    expect(text).toContain('--- user message: split:homedepot:328690510 ---');
    expect(text).toMatch(/Estimated cost: \$0\.0\d+/);
    expect(text).toContain('split:homedepot:335724135  no suggestion  (no call)');
  });

  it('measures the second scan’s 15 questions as well, and refuses a model with no price', async () => {
    expect((await run(['--dry-run', '--data', 'scan2'])).text).toContain('With a suggestion and at least one quote the code found: 15');
    expect(await run(['--dry-run', '--model', 'house-model'])).toMatchObject({ code: 1, text: expect.stringContaining('No price is known for house-model') });
  });
});

describe('brief:eval, a run', () => {
  it('needs the key and says so without calling', async () => {
    let made = false;
    const r = await run([], { makeModel: () => { made = true; throw new Error('no'); } });
    expect(r).toMatchObject({ code: 1, text: expect.stringContaining('ANTHROPIC_API_KEY must be set') });
    expect(made).toBe(false);
  });

  it('prints each brief, each sentence’s verdict, and the total cost; the key is never printed', async () => {
    const asked: string[] = [];
    const model: BriefModel = {
      provider: 'fake', model: 'claude-opus-5-5',
      async ask(request) {
        asked.push(request.user);
        const good = { suggestion: null, reasons: [{ text: 'The page lists what the bundle holds.', quoteIndex: 1 }, { text: 'It costs $99.', quoteIndex: 1 }], check: null };
        return { ok: true, answer: JSON.stringify(good), usage: { inputTokens: 1000, outputTokens: 200 } };
      },
    };
    const { code, text } = await run([], { env: (n) => (n === 'ANTHROPIC_API_KEY' ? 'sk-ant-secret-key' : undefined), makeModel: () => model });
    expect(code).toBe(0);
    expect(asked).toHaveLength(5);
    expect(text).toContain('kept    reason: The page lists what the bundle holds.');
    expect(text).toMatch(/dropped reason: It costs \$99\.   <- It says 99, which is in neither the quote, the question nor the answer\./);
    expect(text).toContain('Calls: 5. Model briefs that passed the checks: 5 of 5. Sentences written: 10, dropped by the checks: 5.');
    expect(text).toContain('Total cost: $0.0400 (claude-opus-5-5).');
    expect(text).not.toContain('sk-ant-secret-key');
  });

  it('stops asking once --max-cost is reached', async () => {
    let n = 0;
    const model: BriefModel = { provider: 'fake', model: 'claude-opus-5-5', async ask() { n += 1; return { ok: true, answer: '{"suggestion":null,"reasons":[],"check":null}', usage: { inputTokens: 1_000_000, outputTokens: 0 } }; } };
    const { text } = await run(['--max-cost', '0.05'], { env: () => 'k', makeModel: () => model });
    expect(n).toBe(1);
    expect(text).toContain('not asked: the calls made cost');
  });
});
