// npm run crosscheck:eval -- --dry-run | --run --max-cost <usd> | --replay. See crosscheck-eval-cli.ts. Only --run reads
// the environment's ANTHROPIC_API_KEY (never printed) and spends money; the main session runs it after the owner's yes.

import { join } from 'node:path';

import { runCrosscheckEval } from './crosscheck-eval-cli';
import { loadEnv, ROOT } from './node-store';

if (process.argv.includes('--run')) loadEnv();
process.exitCode = await runCrosscheckEval(process.argv.slice(2), { log: (l) => console.log(l), dir: join(ROOT, 'fixtures'), env: (n) => process.env[n] });
