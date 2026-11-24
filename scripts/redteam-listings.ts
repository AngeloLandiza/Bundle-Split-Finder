// npm run redteam:listings -- <dir or export.json> [--spend]. All logic is in redteam-listings-cli.ts. Spends money only
// with --spend, and prints the estimated cost first; the main session decides whether to run it.

import { runRedteam } from './redteam-listings-cli';

process.exitCode = await runRedteam(process.argv.slice(2), { log: console.log, env: (name) => process.env[name] });
