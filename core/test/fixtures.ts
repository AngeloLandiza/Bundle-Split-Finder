// Real data captured on 2026-11-09. Each block says where it came from.
// Nothing here was fetched by this code: the values were read from live pages
// and typed in. SerpApi-shaped samples at the bottom follow SerpApi's docs and
// must be replaced by recorded responses (see docs/search-budget.md).

import type { Catalog, CatalogModel } from '../src/decompose';
import type { Candidate } from '../src/match';

// --- Home Depot bundle page, read in a real browser (JSON-LD + embedded page state).
// https://www.homedepot.com/p/.../328814689
export const HD_BUNDLE = {
  productID: '328814689',
  model: 'PBLRC2501SB',
  sku: '1010927962',
  gtin13: '0033287232581',
  upc: '033287232581',
  brand: 'RYOBI',
  price: 189.0,
  strikethroughPrice: 338.0,
  title: 'RYOBI ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only)',
  // Item ids attached to the reviews shown on the bundle page.
  reviewProductIds: ['316631066', '316631068', '328814689'],
};

// Home Depot item id -> model. 316631066 is printed on Home Depot's own page for
// PBLRC01B. 316631068 is inferred: it is the only other component id on the bundle
// page, and a Q&A entry there is attributed to PBLRC25B.
export const HD_ITEM_MODEL: Record<string, string> = { '316631066': 'PBLRC01B', '316631068': 'PBLRC25B' };

// An older Home Depot listing of the same pair, model number spelled out.
export const HD_OLD_BUNDLE_MODEL = 'PBLRC01B-PBLRC25B';

// The schema.org Product block from the same page, as the browser returned it.
export const HD_JSONLD = {
  '@type': 'Product',
  name: 'RYOBI ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only) PBLRC2501SB',
  sku: '1010927962',
  gtin13: '0033287232581',
  model: 'PBLRC2501SB',
  productID: '328814689',
  brand: { '@type': 'Brand', name: 'RYOBI' },
  offers: {
    '@type': 'Offer',
    priceCurrency: 'USD',
    price: 189,
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      priceType: 'https://schema.org/StrikethroughPrice',
      price: 338,
      priceCurrency: 'USD',
    },
  },
};

// Shape of the review data inside the page source (escaped JSON inside a script tag).
export const HD_REVIEW_SNIPPET =
  String.raw`{\"ProductId\":\"316631066\",\"SubmissionTime\":\"2023-09-30\"},` +
  String.raw`{\"ProductId\":\"316631068\",\"Title\":null},` +
  String.raw`{\"ProductId\":\"328814689\",\"Title\":null},` +
  String.raw`{\"ProductId\":\"316631066\",\"Title\":\"Surprisingly powerful, easy to use.\"}`;

// --- Amazon listings, as shown on Amazon's own pages (detail-page data).
export const ASIN_3_8: Candidate = {
  asin: 'B0B3JWF5ZV',
  title: 'RYOBI ONE+ HP 18V Brushless Cordless 3/8 in. Extended Reach Ratchet (Tool Only) - PBLRC25B',
  brand: 'RYOBI',
  partNumber: 'PBLRC25B',
  packageQty: 1,
};
export const ASIN_1_4: Candidate = {
  asin: 'B0B6Z2ZGVK',
  title: 'RYOBI ONE+ HP 18V Brushless Cordless 1/4 in. Extended Reach Ratchet (Tool Only) - PBLRC01B',
  brand: 'RYOBI',
  partNumber: 'PBLRC01B',
  upcs: ['033287193714'],
  packageQty: 1,
};
// The same listing as an Amazon *search result* shows it: title only, no brand or part number.
// Title is the real amazon.com title.
export const ASIN_3_8_SEARCH_RESULT: Candidate = {
  asin: 'B0B3JWF5ZV',
  title: 'RYOBI ONEAND HP 18V BRUSHLESS Cordless 3/8 in. Extended Reach Ratchet Tool ONLY PBLRC25B',
  reviews: 181,
};

// Real Amazon titles seen next to the listings above; ASINs not captured, so ids are placeholders.
export const DECOY_RENEWED: Candidate = {
  asin: 'DECOY-RENEWED',
  title: "RYOBI 18V ONE+ HP Brushless 3/8'' Extended Reach Ratchet Green (Renewed)",
  brand: 'RYOBI',
};
export const DECOY_OTHER_MODEL: Candidate = {
  asin: 'DECOY-PCL280B',
  title: 'RYOBI ONE+ 18V Cordless Multi Size Ratchet (Tool Only) PCL280B',
  brand: 'RYOBI',
  partNumber: 'PCL280B',
};
// Invented decoys, to exercise each rejection rule.
export const DECOY_KIT: Candidate = { asin: 'DECOY-KIT', title: 'RYOBI PBLRC25B 3/8 in. Ratchet Kit with Battery and Charger', brand: 'RYOBI' };
export const DECOY_2PACK: Candidate = { asin: 'DECOY-2PACK', title: 'RYOBI 3/8 in. Extended Reach Ratchet PBLRC25B (2-Pack)', brand: 'RYOBI', partNumber: 'PBLRC25B' };
export const DECOY_BRAND: Candidate = { asin: 'DECOY-BRAND', title: 'Replacement for RYOBI PBLRC25B ratchet', brand: 'Generic', partNumber: 'PBLRC25B' };
export const DECOY_AFTERMARKET: Candidate = { asin: 'DECOY-AFTERMARKET', title: 'Battery adapter compatible with RYOBI PBLRC25B' };
export const DECOY_NO_BRAND_IN_TITLE: Candidate = { asin: 'DECOY-NOBRAND', title: 'ONE+ HP 18V 3/8 in. Extended Reach Ratchet PBLRC25B' };
export const DECOY_BULK: Candidate = {
  asin: 'DECOY-BULK',
  title: 'RYOBI 3/8 in. Extended Reach Ratchet PBLRC25B (Bulk Packaged, Non-Retail Packaging)',
  brand: 'RYOBI',
  partNumber: 'PBLRC25B',
};

const catalogOf = (models: CatalogModel[]): Catalog => new Map(models.map((m) => [m.model, m]));

export const RYOBI_CATALOG = catalogOf([
  { model: 'PBLRC01B', brand: 'RYOBI', kinds: ['ratchet'] },
  { model: 'PBLRC25B', brand: 'RYOBI', kinds: ['ratchet'] },
  { model: 'PCL280B', brand: 'RYOBI', kinds: ['ratchet'] },
]);

// --- DEWALT. Model numbers are real; "kinds" are the words Home Depot titles use.
const tool = (model: string, ...kinds: string[]): CatalogModel => ({ model, brand: 'DEWALT', kinds });
const kit = (model: string): CatalogModel => ({ model, brand: 'DEWALT', kinds: [], isKit: true });

export const DEWALT_CATALOG = catalogOf([
  tool('DCF891B', 'impact wrench'),
  tool('DCF921B', 'impact wrench'),
  tool('DCS356B', 'oscillating'),
  tool('DCS354B', 'oscillating'),
  tool('DCB205', 'battery', 'batteries'),
  tool('DCB205-2', 'battery', 'batteries'),
  tool('DCB240', 'battery', 'batteries'),
  tool('DCB240-2', 'battery', 'batteries'),
  tool('DCB606', 'battery', 'batteries'),
  tool('DCD805B', 'hammer drill'),
  tool('DCS369B', 'reciprocating saw'),
  tool('DCS380B', 'reciprocating saw'),
  tool('DCV517B', 'vac'),
  tool('DCS334B', 'jigsaw', 'jig saw'),
  tool('DCS331B', 'jigsaw', 'jig saw'),
  tool('DCW600B', 'router'),
  tool('DCF513B', 'ratchet'),
  tool('DCS565B', 'circular saw'),
  tool('DCBL722B', 'blower'),
  ...[
    'DCK940D2', 'DCK420D2', 'DCK283D2', 'DCK226D2', 'DCKTS681D1P1', 'DCK2100', 'DCK694P2',
    'DCK2050M2', 'DCK661D1M1', 'DCK2051D2', 'DCK350T2', 'DCK411Q2', 'DCKTS650D1P1',
  ].map(kit),
]);

// [Home Depot model number, Home Depot title, expected parts]. Model numbers and
// titles are from Home Depot search listings; expected parts are read from the title.
export const HD_DEWALT_BUNDLES: [string, string, string[]][] = [
  ['DCK940D2WCF891B', '20V MAX Cordless 9 Tool Combo Kit and 20V MAX XR Cordless 1/2 in. Impact Wrench with (2) 20V 2.0Ah Batteries and Charger', ['DCK940D2', 'DCF891B']],
  ['DCK420D2W356', '20V MAX Cordless 4 Tool Combo Kit, Brushless Oscillating Tool, and (2) 20V 2.0Ah Batteries', ['DCK420D2', 'DCS356B']],
  ['DCK283D2W205', '20V MAX Cordless Brushless Drill/Impact 2 Tool Combo Kit and (2) 20V 2.0Ah and (1) 5.0Ah Batteries', ['DCK283D2', 'DCB205']],
  ['DCK283D2W517B', '20V MAX XR Cordless Brushless Drill/Impact 2 Tool Combo Kit, 20V MAX 1/2 Gal Wet/Dry Vac, and (2) 20V 2.0Ah Batteries', ['DCK283D2', 'DCV517B']],
  ['DCK226D2WCS369B', '20V MAX Lithium-Ion Cordless Combo Kit (2-Tool) and ATOMIC 20V MAX Cordless Brushless Compact Reciprocating Saw', ['DCK226D2', 'DCS369B']],
  ['DCKTS681D1P1W34', '20V MAX ToughSystem Lithium-Ion 6-Tool Cordless Combo Kit and 20V MAX XR Cordless Brushless Jigsaw', ['DCKTS681D1P1', 'DCS334B']],
  ['DCKTS681D1P1W05', '20V MAX ToughSystem Lithium-Ion 6-Tool Cordless Combo Kit with 20V MAX Premium Lithium-Ion 5.0 Ah Battery-Pack', ['DCKTS681D1P1', 'DCB205']],
  ['DCK2100W354606', '20V Cordless Brushless Hammer Drill/Driver Combo Kit, 20V Oscillating Tool, and (1) FLEXVOLT 6.0Ah Battery', ['DCK2100', 'DCS354B', 'DCB606']],
  ['DCK694P2W2052', '20V MAX Lithium-Ion Brushless Cordless 6-Tool Combo Kit with (4) 20V Premium 5.0Ah Batteries and Charger', ['DCK694P2', 'DCB205-2']],
  ['DCK283D2W380B', '20V MAX XR Cordless Brushless Drill/Impact 2 Tool Combo Kit, 20V MAX Reciprocating Saw, and (2) 20V 2.0Ah Batteries', ['DCK283D2', 'DCS380B']],
  ['DCK2050M2WCW600', '20V MAX XR Hammer Drill and ATOMIC Impact Driver Cordless Combo Kit (2-Tool) and Compact Router with (2) 4Ah Batteries', ['DCK2050M2', 'DCW600B']],
  ['DCK2050M2WCF513', '20V MAX XR Hammer Drill and ATOMIC Impact Driver Cordless Combo Kit (2-Tool) and 3/8 in. Ratchet w/(2) 4Ah Batteries', ['DCK2050M2', 'DCF513B']],
  ['DCK940D2W240-2', '20V MAX Cordless 9 Tool Combo Kit, (2) 20V 2.0Ah Batteries, (2) 20V MAX Compact Lithium-Ion 4.0Ah Batteries, Charger', ['DCK940D2', 'DCB240-2']],
  ['DCK661D1M1W331', '20V MAX Cordless 6 Tool Combo Kit, 20V MAX Cordless Jig Saw, and (1) 20V 4.0Ah and (1) 20V 2.0Ah Batteries', ['DCK661D1M1', 'DCS331B']],
  ['DCK2051D2WS356B', '20-Volt MAX Drill/Driver & ATOMIC Impact Driver Combo Kit (2-Tool) with (2) 2.0 Ah Batteries, Charger and Bag', ['DCK2051D2', 'DCS356B']],
  ['DCK350T2WCS565B', '20V MAX Lithium-Ion Cordless 3-Tool Combo Kit and 6-1/2 in. Circular Saw with (2) Flexvolt 6.0 Ah Batteries and Charger', ['DCK350T2', 'DCS565B']],
  ['DCK411Q2WBL722B', '20V Max Lithium-Ion Cordless 4-Tool Combo Kit and Brushless Cordless Handheld Blower with (2) 4 Ah Batteries and Charger', ['DCK411Q2', 'DCBL722B']],
];

// A real Home Depot bundle whose short code is too short to resolve safely.
export const HD_DEWALT_AMBIGUOUS: [string, string] = [
  'DCKTS650D1P1W1B',
  '20V Lithium-Ion Cordless 6-Tool Combo Kit and 1/2 in. Impact Wrench w/ 5 Ah & 2 Ah Batteries Charger & Rolling Toolbox',
];

// ---------------------------------------------------------------- SerpApi-shaped samples (from docs, NOT recorded)

export const SERPAPI_ACCOUNT_FREE = {
  account_status: 'Active',
  plan_id: 'free',
  plan_name: 'Free Plan',
  plan_monthly_price: 0,
  plan_renewal_date: null,
  searches_per_month: 250,
  plan_searches_left: 250,
  extra_credits: 0,
  total_searches_left: 250,
  this_month_usage: 0,
  this_hour_searches: 0,
  last_hour_searches: 0,
  account_rate_limit_per_hour: 50,
};

export const SERPAPI_HD_SEARCH = {
  search_metadata: { status: 'Success' },
  products: [
    {
      position: 1,
      product_id: '328814689',
      title: 'RYOBI ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only)',
      link: 'https://www.homedepot.com/p/328814689',
      model_number: 'PBLRC2501SB',
      brand: 'RYOBI',
      price: 189.0,
      price_was: 338.0,
      price_saving: 149.0,
      percentage_off: 44.0,
      price_badge: 'Special-Buy',
    },
    { position: 2, product_id: '316631066', title: 'ONE+ HP 18V Brushless Cordless 1/4 in. Extended Reach Ratchet (Tool Only)', model_number: 'PBLRC01B', brand: 'RYOBI', price: 179.0 },
    { position: 3, title: 'A row with no product id is skipped' },
  ],
  serpapi_pagination: { next: 'https://serpapi.com/search.json?engine=home_depot&page=2' },
};

export const SERPAPI_AMAZON_SEARCH = {
  search_metadata: { status: 'Success' },
  organic_results: [
    { position: 1, asin: 'B0B3JWF5ZV', title: ASIN_3_8_SEARCH_RESULT.title, price: '$169.00', extracted_price: 169.0, rating: 4.4, reviews: 181 },
    { position: 2, asin: 'B0SPONSORED', sponsored: true, title: 'RYOBI PBLRC25B Ratchet Kit with Battery and Charger', extracted_price: 229.0, reviews: 12 },
    { position: 3, title: 'A row with no ASIN is skipped' },
  ],
};

export const SERPAPI_AMAZON_PRODUCT = {
  search_metadata: { status: 'Success' },
  product_results: { asin: 'B0B6Z2ZGVK', title: ASIN_1_4.title, brand: 'Visit the RYOBI Store', extracted_price: 179.0, reviews: 206 },
  product_details: { upc: '033287193714', item_model_number: '#PBLRC01B', manufacturer: 'RYOBI' },
};
