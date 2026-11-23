// npm run listing-judge:eval -- --model <id> --dry-run | --run [--max-cost <usd>] | --replay [--all]
// All logic is in listing-judge-eval-cli.ts. Only --run reads ANTHROPIC_API_KEY and spends money.

import { runListingJudgeEval } from './listing-judge-eval-cli';
import { loadEnv, ROOT } from './node-store';

// The key is read only for --run; a dry run or a replay reads no .env.
if (process.argv.includes('--run')) loadEnv();

process.exitCode = await runListingJudgeEval(process.argv.slice(2), { log: console.log, root: ROOT, env: (n) => process.env[n] });
