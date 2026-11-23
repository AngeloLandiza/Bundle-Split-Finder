// Screens are addressed by hash, so the shell can open one: `#/today`, `#/deals`, `#/review`,
// `#/activity`, `#/settings`. A deal opens in the pane as `#/deals/<id>`, a question as `#/review/<id>`.
// The shell also fires `split-finder:navigate` with `detail.route` (W3); both arrive here.

import { SCREENS, type Screen } from './keys';

export interface Route {
  screen: Screen;
  /** The open deal or question. */
  id: string | null;
}

export const DEFAULT_ROUTE: Route = { screen: 'today', id: null };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#?\/?/, '');
  const [head, ...rest] = path.split('/');
  const screen = SCREENS.find((s) => s === head);
  if (!screen) return DEFAULT_ROUTE;
  const id = rest.length ? decodeURIComponent(rest.join('/')) : null;
  return { screen, id: id || null };
}

export function hashOf(route: Route): string {
  return `#/${route.screen}${route.id ? `/${encodeURIComponent(route.id)}` : ''}`;
}
