// npm run audit:sanity -- <dir or export.json>. All logic is in sanity-cli.ts. Files only: no network, no search.

import { runSanityCli } from './sanity-cli';

process.exitCode = runSanityCli(process.argv.slice(2), { log: console.log });
