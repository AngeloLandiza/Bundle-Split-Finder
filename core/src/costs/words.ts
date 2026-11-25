// How an amount of a service's unit is said (step 18). Pure.

import type { CostUnit } from './types';

const NOUNS: Record<Exclude<CostUnit, 'usd'>, [string, string]> = {
  searches: ['search', 'searches'],
  tokens: ['token', 'tokens'],
  calls: ['call', 'calls'],
  messages: ['message', 'messages'],
};

export const usd = (n: number): string => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

/** A count as a figure: whole, with thousands separated. */
export const figure = (n: number): string => Math.round(n).toLocaleString('en-US');

/** "17 searches", "1 token", "$0.45". */
export function amount(n: number, unit: CostUnit): string {
  if (unit === 'usd') return usd(n);
  const [one, many] = NOUNS[unit];
  return `${figure(n)} ${Math.round(n) === 1 ? one : many}`;
}

/** "0 to 17 searches", "$0.00 to $0.45"; one figure when they are equal. */
export function range(lo: number, hi: number, unit: CostUnit): string {
  if (unit === 'usd') return Math.round(lo * 100) === Math.round(hi * 100) ? usd(lo) : `${usd(lo)} to ${usd(hi)}`;
  return Math.round(lo) === Math.round(hi) ? amount(hi, unit) : `${figure(lo)} to ${amount(hi, unit)}`;
}

export const plural = (n: number, one: string, many: string): string => `${figure(n)} ${Math.round(n) === 1 ? one : many}`;
