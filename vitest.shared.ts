import { availableParallelism } from 'node:os';

// Settings both default suites share. They exist so the suite stays green when the machine is busy (other builds, other
// agents) without hiding a test that is really slow.
export const stable = {
  // Many CPU-heavy files at once on a loaded machine starve each other's timers; a few fewer workers finish sooner.
  maxWorkers: Math.max(2, Math.min(6, availableParallelism() - 2)),
  // The default 5 s test / 10 s hook limits sit right at what a replayed scan takes when two other jobs share the cores.
  // A test that really hangs still fails, at 30 s; one that is merely slow is listed (slowTestThreshold) instead of failing.
  testTimeout: 30_000,
  hookTimeout: 30_000,
  slowTestThreshold: 3_000,
};
