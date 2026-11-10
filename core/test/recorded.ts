import { readFileSync } from 'node:fs';

/** The SerpApi responses recorded into fixtures/recorded/ (committed). */
export const RECORDED_NAMES = [
  'hd-search-ryobi-combo-p1',
  'hd-search-dewalt-combo-p1',
  'hd-search-ryobi-ratchet',
  'hd-product-328814689',
  'amazon-search-PBLRC25B',
  'amazon-search-PBLRC01B',
  'amazon-search-DCF891B',
  'amazon-product-B0B6Z2ZGVK',
  'amazon-product-B0B3JWF5ZV',
  'hd-bundles-ryobi-p1',
  'hd-bundles-dewalt-p1',
  'amazon-brand-ryobi-p1',
  'amazon-brand-dewalt-p1',
] as const;

export type RecordedName = (typeof RECORDED_NAMES)[number];

export function recorded(name: RecordedName): unknown {
  return JSON.parse(readFileSync(new URL(`../../fixtures/recorded/${name}.json`, import.meta.url), 'utf8'));
}
