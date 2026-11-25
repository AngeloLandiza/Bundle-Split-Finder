// The flush to disk behind every durable write of the agent (store.ts writeFileAtomic and its directory flush). It is
// always the real fsyncSync, except in the default test suite: agent/test/setup.ts swaps in a no-op there, because on
// macOS each flush is a full one (about 5 to 20 ms) and the suite writes tens of thousands of files it then throws away.
// Nothing else may call setSyncForTests (agent/test/fsync.test.ts checks it).

import { fsyncSync } from 'node:fs';

let impl: (fd: number) => void = fsyncSync;

export const syncFd = (fd: number): void => impl(fd);

/** Test setup only. */
export function setSyncForTests(fn: (fd: number) => void): void {
  impl = fn;
}
