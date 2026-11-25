// npm run costs -- <data folder>. All logic is in costs-cli.ts. Files only: no network, nothing spent.

import { runCostsCli } from './costs-cli';

process.exitCode = runCostsCli(process.argv.slice(2), { log: console.log });
