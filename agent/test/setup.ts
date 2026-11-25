// Setup for the default suite (vitest.config.ts setupFiles). The agent's writes skip the flush to disk here: every test
// writes to a temp folder it throws away, and a real flush costs 5 to 20 ms on macOS. Writes still go to a temp file
// and are renamed into place exactly as in the agent. agent/test/fsync.test.ts runs the real flush.

import { setSyncForTests } from '../fsync';

setSyncForTests(() => {});
