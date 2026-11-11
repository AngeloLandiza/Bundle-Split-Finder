import type { AppState } from '../../lib/messages';

// Stub: the first-run body comes in a later task. It is the body only; the shell draws the header.
export function FirstRun(_props: { state: AppState }) {
  return <p className="stub">Add your SerpApi key in settings to begin.</p>;
}
