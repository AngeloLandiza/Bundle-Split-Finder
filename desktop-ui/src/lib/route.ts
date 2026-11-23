// Screens are addressed by hash, so the shell can open one: `#/today`, `#/deals`, `#/review`,
// `#/activity`, `#/settings`. A deal opens in the inspector as `#/deals/<id>`, a question as `#/review/<id>`.
// A saved Deals view from the sidebar rides along as `?view=`: `#/deals?view=confirmed`,
// `#/deals/<id>?view=losing`. The shell also fires `split-finder:navigate` with `detail.route` (W3);
// both arrive here.

import { SCREENS, type Screen } from './keys';
import { BOUGHT_VIEW, DEAL_VIEWS, type ListView } from './views';

export interface Route {
  screen: Screen;
  /** The open deal or question. */
  id: string | null;
  /** The Deals view the sidebar selected; 'all' when none is named. Only Deals reads it. 'bought' is the list of his purchases, not a view of the rows. */
  view?: ListView;
}

export const DEFAULT_ROUTE: Route = { screen: 'today', id: null };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#?\/?/, '');
  const q = raw.indexOf('?');
  const path = q >= 0 ? raw.slice(0, q) : raw;
  const query = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '');
  const [head, ...rest] = path.split('/');
  const screen = SCREENS.find((s) => s === head);
  if (!screen) return DEFAULT_ROUTE;
  const id = rest.length ? decodeURIComponent(rest.join('/')) : null;
  const route: Route = { screen, id: id || null };
  if (screen === 'deals') {
    const view = ([...DEAL_VIEWS, BOUGHT_VIEW] as ListView[]).find((v) => v === query.get('view'));
    if (view && view !== 'all') route.view = view;
  }
  return route;
}

export function hashOf(route: Route): string {
  const view = route.screen === 'deals' && route.view && route.view !== 'all' ? `?view=${route.view}` : '';
  return `#/${route.screen}${route.id ? `/${encodeURIComponent(route.id)}` : ''}${view}`;
}
