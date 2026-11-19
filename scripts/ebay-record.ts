// npm run ebay:record. All logic is in ebay-record-cli.ts.

import { join } from 'node:path';

import { runEbayRecord } from './ebay-record-cli';
import { loadEnv, ROOT } from './node-store';

// Keys are read only for --run; a dry run reads no .env.
if (process.argv.includes('--run')) loadEnv();

process.exitCode = await runEbayRecord(process.argv.slice(2), {
  log: console.log,
  dir: join(ROOT, 'fixtures'),
  env: (n) => process.env[n],
});
