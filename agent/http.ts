// A small router for the agent (step 13): routes by method and path pattern, each with the caller
// it needs; JSON bodies read with a size limit; every error answered in the contract's shape.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { API_ERROR_STATUS, MAX_BODY_BYTES, type ApiErrorBody, type ApiErrorCode } from '../core/src/api/contract';
import type { Principal } from './auth';

export class HttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Who may call a route: nobody needs a token ('none'), the app only, a paired extension only, or either. */
export type RouteAuth = 'none' | 'ui' | 'extension' | 'any';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  principal: Principal | null;
  origin: string | undefined;
  /** Aborted when the caller goes away. */
  signal: AbortSignal;
  /** The JSON body, or {} when there is none. Throws HttpError for bad JSON or a body over the limit. */
  body<T = Record<string, unknown>>(): Promise<T>;
}

/** A handler's answer: a JSON value (200), `reply(status, body)`, or HANDLED when it wrote the response itself. */
export const HANDLED = Symbol('handled');
export interface Reply {
  readonly [HANDLED_REPLY]: true;
  status: number;
  body: unknown;
}
const HANDLED_REPLY = Symbol('reply');

export function reply(status: number, body?: unknown): Reply {
  return { [HANDLED_REPLY]: true, status, body };
}

function isReply(v: unknown): v is Reply {
  return typeof v === 'object' && v !== null && HANDLED_REPLY in v;
}

export type Handler = (ctx: Ctx) => unknown;

interface Route {
  method: string;
  parts: string[];
  auth: RouteAuth;
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, auth: RouteAuth, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), auth, handler });
    return this;
  }

  get(p: string, auth: RouteAuth, h: Handler) {
    return this.add('GET', p, auth, h);
  }
  post(p: string, auth: RouteAuth, h: Handler) {
    return this.add('POST', p, auth, h);
  }
  put(p: string, auth: RouteAuth, h: Handler) {
    return this.add('PUT', p, auth, h);
  }
  patch(p: string, auth: RouteAuth, h: Handler) {
    return this.add('PATCH', p, auth, h);
  }
  delete(p: string, auth: RouteAuth, h: Handler) {
    return this.add('DELETE', p, auth, h);
  }

  /** The route for a request, 'method' when the path exists for another method, or null. */
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | 'method' | null {
    const segs = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchParts(route.parts, segs);
      if (!params) continue;
      if (route.method === method) return { route, params };
      pathMatched = true;
    }
    return pathMatched ? 'method' : null;
  }

  /** The methods a path answers to (for a CORS preflight). */
  methodsFor(pathname: string): string[] {
    const segs = pathname.split('/').filter(Boolean);
    return [...new Set(this.routes.filter((r) => matchParts(r.parts, segs)).map((r) => r.method))];
  }

  authFor(method: string, pathname: string): RouteAuth | null {
    const m = this.match(method, pathname);
    return m && m !== 'method' ? m.route.auth : null;
  }
}

function matchParts(parts: string[], segs: string[]): Record<string, string> | null {
  if (parts.length !== segs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const s = segs[i]!;
    if (p.startsWith(':')) {
      try {
        params[p.slice(1)] = decodeURIComponent(s);
      } catch {
        return null;
      }
    } else if (p !== s) return null;
  }
  return params;
}

/** Reads a JSON body up to `limit` bytes. An empty body reads as {}. */
export function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError('payload_too_large', `The body is over ${limit} bytes.`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(new HttpError('payload_too_large', `The body is over ${limit} bytes.`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        reject(new HttpError('bad_request', 'The body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, code: ApiErrorCode, message: string): void {
  const body: ApiErrorBody = { error: { code, message } };
  if (code === 'payload_too_large') res.setHeader('Connection', 'close');
  sendJson(res, API_ERROR_STATUS[code], body);
}

/** Runs a matched handler and writes its answer. */
export async function runHandler(handler: Handler, ctx: Ctx): Promise<void> {
  try {
    const out = await handler(ctx);
    if (out === HANDLED) return;
    if (isReply(out)) sendJson(ctx.res, out.status, out.body);
    else sendJson(ctx.res, 200, out ?? {});
  } catch (err) {
    if (err instanceof HttpError) sendError(ctx.res, err.code, err.message);
    else {
      // Never echo an exception: it could hold a request body.
      console.error(`[agent] ${ctx.req.method} ${ctx.url.pathname} failed: ${err instanceof Error ? err.name : 'error'}`);
      sendError(ctx.res, 'internal', 'Something went wrong in the agent.');
    }
  }
}
