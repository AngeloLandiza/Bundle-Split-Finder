import type { AppState } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';

// Stub: notices (limit, error, stale data) come in a later task.
export function Notice(_props: { state: AppState; api: WorkerApi; error: string | null }) {
  return null;
}
