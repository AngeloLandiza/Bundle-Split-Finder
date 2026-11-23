import { join } from 'node:path';

/** Dev default: ./output when started from repo root. Packaged app sets SPLIT_FINDER_DATA_DIR. */
export function agentDataDir(): string {
  return process.env.SPLIT_FINDER_DATA_DIR ?? join(process.cwd(), 'output');
}

/** Built React app (desktop-ui). Packaged app sets SPLIT_FINDER_UI_DIR. */
export function agentUiDir(): string {
  return process.env.SPLIT_FINDER_UI_DIR ?? join(process.cwd(), 'desktop', 'dist', 'ui');
}