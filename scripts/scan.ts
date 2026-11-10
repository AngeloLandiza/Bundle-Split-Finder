// npm run scan. All logic is in scan-cli.ts.

import { join } from 'node:path';

import { openDevClient } from './dev-client';
import { ROOT } from './node-store';
import { runScanCli } from './scan-cli';

process.exitCode = await runScanCli(process.argv.slice(2), {
  log: console.log,
  outDir: join(ROOT, 'output'),
  now: Date.now,
  openClient: openDevClient,
});
