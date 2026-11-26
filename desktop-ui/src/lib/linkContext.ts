// Which deal a link on screen belongs to, so the viewer can offer that deal's other source pages. A screen marks the
// part of the page about one deal with `data-link-context="<key>"` and registers the deal's pages under that key
// (useLinkContext); a click on any link inside it (lib/actions.ts routeLinkClicks) opens the viewer with them.

import { useEffect } from 'react';
import type { ViewerContext } from './viewer';

const contexts = new Map<string, ViewerContext>();

export function setLinkContext(key: string, ctx: ViewerContext | null): void {
  if (ctx && ctx.pages.length > 0) contexts.set(key, ctx);
  else contexts.delete(key);
}

/** The context of the nearest marked element around `el`, if any. */
export function linkContextOf(el: Element | null): ViewerContext | undefined {
  const key = el?.closest<HTMLElement>('[data-link-context]')?.dataset.linkContext;
  return key ? contexts.get(key) : undefined;
}

export function useLinkContext(key: string, ctx: ViewerContext | null): void {
  useEffect(() => {
    setLinkContext(key, ctx);
    return () => setLinkContext(key, null);
  }, [key, ctx]);
}
