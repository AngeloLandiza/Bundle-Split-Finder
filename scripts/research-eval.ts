// npm run research:eval. All logic is in research-eval-cli.ts.

import { join } from 'node:path';

import { runResearchEval } from './research-eval-cli';
import { loadEnv, ROOT } from './node-store';

// The key is read only for --run; a dry run or a replay reads no .env.
if (process.argv.includes('--run')) loadEnv();

process.exitCode = await runResearchEval(process.argv.slice(2), {
  log: console.log,
  dir: join(ROOT, 'fixtures'),
  env: (n) => process.env[n],
});
