import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildResults, CacheOnlyClient, loadInputs, readLabels, ResponsesCache, runValidationPipeline, scoreCriterion6, scoreLines, validationFiles,
} from '../../scripts/validate-cli';

// Acceptance criterion 6 (docs/v1-plan.md) on the validation set, with no network: the tool's own
// pipeline replays the responses the paid run recorded (fixtures/validation/responses/) and is scored
// against a checker's labels. Run `npm run validate -- --replay` to see the same score and the table.

const DIR = 'fixtures/validation';
const files = validationFiles(DIR);
const recorded = existsSync(files.responses);
const labels = readLabels(files.labels);
const labelled = Object.keys(labels).length > 0;

async function replay() {
  const cache = new ResponsesCache(files.responses);
  const run = await runValidationPipeline({
    inputs: loadInputs(DIR), scanClient: new CacheOnlyClient(cache), lookupClient: new CacheOnlyClient(cache), continuePastMisses: true,
  });
  return buildResults(run);
}

afterEach(() => vi.restoreAllMocks());

describe('acceptance criterion 6, on the validation set', () => {
  const why = !recorded ? 'no recorded responses yet: the paid run (npm run validate -- --max N) writes them' : 'labels-2026-11-18.json has no labels yet';

  it.skipIf(!recorded || !labelled)(
    recorded && labelled
      ? 'no wrong exact or strong match, at least 95% of probable matches right, every unresolved bundle in the review queue'
      : `skipped: ${why}`,
    async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in the default tests'));
      const score = scoreCriterion6(await replay(), labels);
      expect(fetchSpy).not.toHaveBeenCalled();
      if (!score.pass) console.log(scoreLines(score).join('\n'));
      expect(score.confident.wrong).toEqual([]);
      expect(score.probable.total === 0 || score.probable.correct / score.probable.total >= 0.95).toBe(true);
      expect(score.unresolvedNotQueued).toEqual([]);
      expect(score.unlabelled).toEqual([]);
      expect(score.notLookedUp).toEqual([]);
    },
  );

  it.skipIf(!recorded || !existsSync(files.results))(
    recorded ? 'the committed results are what the pipeline gives now (else: npm run validate -- --replay, and label again)' : `skipped: ${why}`,
    async () => {
      expect(JSON.parse(JSON.stringify(await replay()))).toEqual(JSON.parse(readFileSync(files.results, 'utf8')));
    },
  );
});
