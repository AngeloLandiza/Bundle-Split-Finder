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
  'amazon-search-PCL1201K2',
  'amazon-search-PCL1600K2',
  'amazon-search-P553',
  'amazon-search-PCL206',
  'amazon-search-PCL235',
  'amazon-search-PCL500',
  'amazon-search-PCL515',
  'amazon-search-PCL430',
  'amazon-search-PCL660',
  'amazon-search-PBP002',
] as const;

export type RecordedName = (typeof RECORDED_NAMES)[number];

export function recorded(name: RecordedName): unknown {
  return JSON.parse(readFileSync(new URL(`../../fixtures/recorded/${name}.json`, import.meta.url), 'utf8'));
}
