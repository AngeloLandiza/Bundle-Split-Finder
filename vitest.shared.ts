// Settings both default suites share. They exist so the suite stays green when the machine is busy (other builds, other
// agents) without hiding a test that is really slow.
export const stable = {
  // A replayed scan is about 2 s of CPU on an idle machine and 15 s or more when other jobs hold every core, and the
  // default 5 s test / 10 s hook limits fail it then (and fail the afterEach that waits for it). A test that truly hangs
  // still fails, at 60 s; one that is merely slow is listed (slowTestThreshold) instead of failing. Files that need
  // longer (building the extension) keep their own, longer limits.
  testTimeout: 60_000,
  hookTimeout: 60_000,
  slowTestThreshold: 3_000,
};
