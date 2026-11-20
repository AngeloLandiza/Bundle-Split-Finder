// npm run assist:eval. All logic is in assist-eval-cli.ts.

import { join } from 'node:path';

import { runAssistEval } from './assist-eval-cli';
import { loadEnv, ROOT } from './node-store';

// The key is read only for --run; a dry run or a replay reads no .env.
if (process.argv.includes('--run')) loadEnv();

process.exitCode = await runAssistEval(process.argv.slice(2), {
  log: console.log,
  dir: join(ROOT, 'fixtures'),
  env: (n) => process.env[n],
});
