import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

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

/**
 * The app's Content-Security-Policy, the same as src-tauri/tauri.conf.json's app.security.csp: change
 * both together.
 */
export const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://m.media-amazon.com https://images.thdstatic.com; font-src 'self' data:; connect-src 'self' http://127.0.0.1:8790 ipc: http://ipc.localhost; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

function uiHeaders(res: ServerResponse, type: string): void {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Security-Policy', UI_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function safePath(urlPath: string): string | null {
  const clean = urlPath.replace(/\0/g, '');
  if (clean.includes('..')) return null;
  const rel = clean.replace(/^\/ui\/?/, '') || 'index.html';
  const file = join(agentUiDir(), rel);
  const root = agentUiDir();
  if (file !== root && !file.startsWith(root + sep)) return null;
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
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    const fallback = join(agentUiDir(), 'index.html');
    if (existsSync(fallback)) {
      uiHeaders(res, 'text/html; charset=utf-8');
      res.end(readFileSync(fallback));
      return true;
    }
    res.statusCode = 404;
    res.end('not found');
    return true;
  }
  const ext = file.slice(file.lastIndexOf('.'));
  uiHeaders(res, MIME[ext] ?? 'application/octet-stream');
  res.end(readFileSync(file));
  return true;
}