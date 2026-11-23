// npm run brief:eval. All logic is in brief-eval-cli.ts.

import { join } from 'node:path';

import { runBriefEval } from './brief-eval-cli';
import { loadEnv, ROOT } from './node-store';

// The key is read only for a real run; a dry run reads no .env.
if (!process.argv.includes('--dry-run')) loadEnv();

process.exitCode = await runBriefEval(process.argv.slice(2), {
  log: console.log,
  dir: join(ROOT, 'fixtures'),
  env: (n) => process.env[n],
});
