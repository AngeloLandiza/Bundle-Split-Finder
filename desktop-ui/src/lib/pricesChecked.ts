// Keeping deals current (Nov 25): how old a watched deal's prices are, in the owner's words. Shown beside the verdict on
// the row and in the inspector, never in its place.

import type { PricesChecked } from '../api/types';
import { when } from './format';

/** "Prices checked 5:10 PM" (both sources at once), "Home Depot price checked 5:10 PM · Amazon prices 3:02 PM", or the stale line. */
export function checkedWords(pc: PricesChecked, now: number = Date.now()): string {
  if (pc.staleSince) return `Prices not checked since ${when(pc.staleSince, now)}`;
  const hd = when(pc.homeDepotAt, now);
  if (!pc.amazonAt) return `Home Depot price checked ${hd}`;
  const amazon = when(pc.amazonAt, now);
  return hd === amazon ? `Prices checked ${hd}` : `Home Depot price checked ${hd} · Amazon prices ${amazon}`;
}

/** The hover of a stale line: why, and what the app does about it. */
export function staleWhy(pc: PricesChecked, now: number = Date.now()): string {
  return `Home Depot's price was last checked ${when(pc.homeDepotAt, now)}${pc.amazonAt ? ` and the oldest Amazon price ${when(pc.amazonAt, now)}` : ''}. The app could not check them since (Home Depot paused reading, Chrome closed, or no Keepa tokens), so this deal is not announced until they are checked again. Check the prices yourself before you buy.`;
}
