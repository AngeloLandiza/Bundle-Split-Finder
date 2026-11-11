import type { AppState } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';

// Stub: the first-run body comes in a later task. It is the body only; the shell draws the header.
export function FirstRun(_props: { state: AppState; api: WorkerApi; openSettings: () => void }) {
  return <p className="stub">Add your SerpApi key in settings to begin.</p>;
}
