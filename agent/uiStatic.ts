import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ServerResponse } from 'node:http';

import { agentUiDir } from './paths';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

function safePath(urlPath: string): string | null {
  const clean = urlPath.replace(/\0/g, '');
  if (clean.includes('..')) return null;
  const rel = clean.replace(/^\/ui\/?/, '') || 'index.html';
  const file = join(agentUiDir(), rel);
  const root = agentUiDir();
  if (!file.startsWith(root)) return null;
  return file;
}

export function uiIndexExists(): boolean {
  return existsSync(join(agentUiDir(), 'index.html'));
}

/** Serves built desktop-ui under /ui/*. Returns true when handled. */
export function tryServeUi(url: string | undefined, res: ServerResponse): boolean {
  if (!url?.startsWith('/ui')) return false;
  if (!uiIndexExists()) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('UI not built. Run npm run desktop:build-ui.');
    return true;
  }
  const file = safePath(url);
  if (!file || !existsSync(file)) {
    const fallback = join(agentUiDir(), 'index.html');
    if (existsSync(fallback)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(readFileSync(fallback));
      return true;
    }
    res.statusCode = 404;
    res.end('not found');
    return true;
  }
  const ext = file.slice(file.lastIndexOf('.'));
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  res.end(readFileSync(file));
  return true;
}