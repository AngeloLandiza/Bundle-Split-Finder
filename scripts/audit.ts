// npm run audit. All logic is in audit-cli.ts. No searches: an audit works only from files.

import { ROOT } from './node-store';
import { runAuditCli } from './audit-cli';

process.exitCode = await runAuditCli(process.argv.slice(2), { log: console.log, root: ROOT });
