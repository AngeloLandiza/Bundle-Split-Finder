// Mock data for `VITE_MOCK=1`. Every bundle title, model, Home Depot item id and price is from
// fixtures/recorded/hd-bundles-*-p1.json. The RYOBI parts' ASINs, listing titles and Amazon prices,
// and the DCF891B/PBLRC25B listings, are from fixtures/recorded/amazon-search-*.json. The DEWALT
// parts' ASINs and prices (DCD771B, DCF885B, DCB207, DCD708B, DCF809B, DCB203) and PCL525B's are
// placeholders: no fixture records them. Part lists and questions are written to match the titles. Estimates are computed here with the
// same fee rule as core/src/money.ts, so the table, the pane and Today agree to the cent.

import { unnamedPartOf } from './map';
import type {
  ActivityView,
  AppSettings,
  AppState,
  DealDetail,
  DealPart,
  DealRow,
  DealSection,
  ConfirmState,
  Grade,
  PriceLine,
  ReviewQuestion,
  Run,
  Source,
} from './types';

export const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ahead = (min: number) => new Date(NOW + min * 60_000).toISOString();

export const SETTINGS: AppSettings = {
  autopilot: false,
  appearance: { theme: 'system', accent: 'system', density: 'regular' },
  notifications: {
    kinds: { review: true, deal: true, autopilot: true, scan: true, error: true },
    sound: false,
    quietHours: { enabled: false, from: '22:00', to: '07:00' },
    digest: 'each-run',
    morningAt: '08:00',
  },
  shell: { menuBarIcon: true, dockIcon: true, launchAtLogin: false },
  ebaySettings: { judgeModel: 'claude-haiku-4-5', listingsJudgedPerScan: 20 },
  settings: {
    schedule: { mode: 'daily', at: '06:00' },
    searchesPerScan: 5,
    reserve: 20,
    keepaTokensPerScan: 60,
    keepaReserve: 100,
    fees: { referralRate: 0.15, fulfillmentFee: 5.5, minReferral: 0.3, salesTaxRate: 0, inboundCost: 0 },
    brands: ['DEWALT', 'RYOBI'],
    pagesPerBrand: 2,
    discoveryMode: 'auto',
    keepaDiscoveryShare: 0.5,
    trackingDepth: 'price_only',
    amazonRefreshViaKeepa: true,
  },
  alerts: { enabled: true, minProfit: 40, minRoiPercent: 25, reviewDigest: true, minMonthlySold: 50, marginDownDigest: false },
  ai: {
    judge: { provider: 'anthropic', model: 'claude-haiku-4-5', apiKeyRef: 'anthropic', trusted: true },
    assist: { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKeyRef: 'anthropic', trusted: true },
    research: { provider: 'openai-compatible', model: 'deepseek-chat', apiKeyRef: 'openai', baseUrl: 'https://api.deepseek.com', trusted: false },
    monthlyCapUsd: 20,
  },
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const fees = SETTINGS.settings.fees;
export const net = (p: number) => r2(p - Math.max(p * fees.referralRate, fees.minReferral) - fees.fulfillmentFee);
const basis = '15% referral (at least $0.30), $5.50 fulfillment, 0% tax, $0.00 inbound. An estimate from your fee settings, not your real Amazon fees.';

const hd = (itemId: string, slug: string): string => `https://www.homedepot.com/p/${slug}/${itemId}`;
const amazon = (asin: string): string => `https://www.amazon.com/dp/${asin}`;
const src = (label: string, url: string | null): Source => ({ label, url });

interface PartSeed {
  model: string;
  qty?: number;
  title: string;
  asin: string | null;
  price: number | null;
  grade: Grade;
  listPrice?: number;
  ebay?: { low: number; high: number; listings: number; sold: number };
  /** The stored eBay listings, each with its own price: what the owner may choose to confirm. */
  ebayLinks?: { url: string; price: number }[];
}

function part(s: PartSeed): DealPart {
  const qty = s.qty ?? 1;
  const counted = s.price !== null && (s.grade === 'verified' || s.grade === 'title_match');
  const prices: PriceLine[] = [];
  if (s.price !== null && s.asin) {
    prices.push({ label: 'Amazon · New', amount: s.price, range: null, counted, note: null, seenAt: ago(47), sources: [src('Amazon listing', amazon(s.asin))] });
  }
  if (s.listPrice) {
    prices.push({ label: 'List price', amount: s.listPrice, range: null, counted: false, note: 'not counted', seenAt: ago(47), sources: s.asin ? [src('Amazon listing', amazon(s.asin))] : [] });
  }
  if (s.ebay) {
    prices.push({
      label: 'eBay · New',
      amount: null,
      range: { low: s.ebay.low, high: s.ebay.high },
      counted: false,
      note: `${s.ebay.listings} listings, ${s.ebay.sold} sold`,
      seenAt: ago(300),
      sources: s.ebayLinks
        ? s.ebayLinks.map((l, i) => src(`${i + 1}`, l.url))
        : Array.from({ length: Math.min(3, s.ebay.listings) }, (_, i) => src(`${i + 1}`, `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(s.model)}`)),
    });
  }
  const state: ConfirmState = s.grade === 'needs_answer' ? 'answer-first' : s.grade === 'not_looked_up' ? 'look-up-first' : counted ? 'amazon-counts' : 'open';
  return {
    model: s.model,
    qty,
    title: s.title,
    grade: s.grade,
    asin: s.asin,
    price: counted ? s.price : null,
    net: counted && s.price !== null ? net(s.price) : null,
    prices,
    verifySearches: s.grade === 'title_match' ? 1 : null,
    unnamed: false,
    confirm: { state, ebay: s.ebayLinks ?? [], confirmed: null, inactive: s.grade === 'inactive' },
  };
}

type SeedMatch = 'verified' | 'title_match' | 'needs_answer' | 'waiting' | 'missing' | 'inactive' | 'contents_unknown';
/** The agent's own sentence for each, as core's matchState words it. */
const MATCH_WORDS: Record<SeedMatch, string | null> = {
  verified: 'All parts matched',
  title_match: '2 title matches',
  needs_answer: null,
  waiting: '2 parts to look up',
  missing: '1 part with no listing',
  inactive: '1 listing inactive',
  contents_unknown: null,
};

interface DealSeed {
  itemId: string;
  slug: string;
  brand: 'DEWALT' | 'RYOBI';
  model: string;
  title: string;
  price: number;
  was: number | null;
  section: DealSection;
  matchState: SeedMatch;
  parts: PartSeed[];
  updatedMin: number;
  questionId?: string;
  noEstimate?: string;
  lookup?: number;
  range?: { low: number; high: number };
  leaves?: string[];
  secondWay?: { label: string; leaves: string[]; profitDelta: number };
  /** Kit items with no model number: never looked up, priced only by a price he confirms. */
  unnamed?: string[];
}

function build(seed: DealSeed): { row: DealRow; detail: DealDetail } {
  const parts = [...seed.parts.map(part), ...(seed.unnamed ?? []).map((name) => unnamedPartOf({ model: `~${name.toUpperCase()}`, name, qty: 1, price: null, link: null }))];
  const cost = r2(seed.price * (1 + fees.salesTaxRate) + fees.inboundCost);
  const countedParts = parts.filter((p) => p.price !== null);
  const countedAtZero = parts.filter((p) => p.price === null).map((p) => (p.unnamed ? (p.title ?? p.model) : p.model));
  const partsSellFor = r2(countedParts.reduce((s, p) => s + (p.price ?? 0) * p.qty, 0));
  const afterFees = r2(countedParts.reduce((s, p) => s + (p.net ?? 0) * p.qty, 0));
  const hasEstimate = !seed.noEstimate && countedParts.length > 0;
  const profit = r2(afterFees - cost);
  const roi = Math.round((profit / cost) * 10000) / 10000;
  const id = `hd-${seed.itemId}`;
  const link = hd(seed.itemId, seed.slug);
  const off = seed.was ? Math.round((1 - seed.price / seed.was) * 100) : null;
  const ways = hasEstimate
    ? [
        { id: 'w1', label: 'Sell every part on Amazon', primary: true, profit, roi, roiRange: seed.range ?? null, leaves: seed.leaves ?? [] },
        ...(seed.secondWay
          ? [{
              id: 'w2',
              label: seed.secondWay.label,
              primary: false,
              profit: r2(profit + seed.secondWay.profitDelta),
              roi: Math.round(((profit + seed.secondWay.profitDelta) / cost) * 100) / 100,
              roiRange: null,
              leaves: seed.secondWay.leaves,
            }]
          : []),
      ]
    : [];
  const detail: DealDetail = {
    id,
    title: seed.title,
    brand: seed.brand,
    model: seed.model,
    section: seed.section,
    price: seed.price,
    off,
    seenAt: ago(seed.updatedMin),
    link,
    estimate: hasEstimate ? { profit, roi, roiRange: seed.range ?? null, cost, partsSellFor, afterFees, basis, countedAtZero } : null,
    noEstimate: hasEstimate ? null : (seed.noEstimate ?? 'No estimate yet.'),
    ways,
    parts,
    questionId: seed.questionId ?? null,
    asins: parts.map((p) => p.asin).filter((a): a is string => a !== null),
    lookup: seed.lookup ? { searches: seed.lookup } : null,
  };
  const row: DealRow = {
    id,
    title: seed.title,
    brand: seed.brand,
    model: seed.model,
    itemId: seed.itemId,
    link,
    section: seed.section,
    price: seed.price,
    off,
    matchState: MATCH_WORDS[seed.matchState],
    profit: hasEstimate ? profit : null,
    roi: hasEstimate ? roi : null,
    roiRange: hasEstimate ? (seed.range ?? null) : null,
    needsAnswer: Boolean(seed.questionId),
    updatedAt: ago(seed.updatedMin),
    lookup: seed.lookup ? { searches: seed.lookup } : null,
  };
  return { row, detail };
}

const RYOBI_DRILL: PartSeed = { model: 'PCL206B', title: 'ONE+ 18V Cordless 1/2 in. Drill/Driver (Tool Only)', asin: 'B0BVYFSHXX', price: 56.99, grade: 'verified', ebay: { low: 38.5, high: 54.99, listings: 3, sold: 41 } };
const RYOBI_IMPACT: PartSeed = { model: 'PCL235B', title: 'ONE+ 18V Cordless 1/4 in. Impact Driver, Tool Only', asin: 'B0BGYFTPGK', price: 52.99, grade: 'verified' };
const RYOBI_CIRC: PartSeed = { model: 'PCL500B', title: 'ONE+ 18V Cordless 5-1/2 in. Circular Saw (Tool Only)', asin: 'B0B1F877F3', price: 45, grade: 'title_match' };
const RYOBI_RECIP: PartSeed = { model: 'PCL515B', title: 'ONE+ 18V Cordless Reciprocating Saw, Tool Only', asin: 'B0B88R7HWB', price: 57.99, grade: 'verified', listPrice: 65 };
const RYOBI_MULTI: PartSeed = { model: 'PCL430B', title: 'ONE+ 18V Cordless Oscillating Multi-Tool (Tool Only)', asin: 'B0B11CJ52Y', price: 53.73, grade: 'verified', listPrice: 57.08 };
const RYOBI_LIGHT: PartSeed = { model: 'PCL660B', title: 'ONE+ 18V Cordless LED Flash Light (Tool Only)', asin: 'B0B1GKJXNB', price: 21.99, grade: 'needs_answer' };
const RYOBI_15: PartSeed = { model: 'PBP002', title: 'ONE+ HP 18V 1.5 Ah Lithium-Ion Battery', asin: 'B08L339D94', price: 36.94, grade: 'verified' };

const SEEDS: DealSeed[] = [
  {
    itemId: '317987591', slug: 'RYOBI-ONE-18V-Cordless-6-Tool-Combo-Kit-with-Compact-Battery-4-0-Ah-Battery-and-Charger-PCL1600K2',
    brand: 'RYOBI', model: 'PCL1600K2', title: 'ONE+ 18V Cordless 6-Tool Combo Kit with Compact Battery, 4.0 Ah Battery, and Charger',
    price: 199, was: 299, section: 'confirmed', matchState: 'needs_answer', updatedMin: 47, questionId: 'q-pcl660',
    parts: [RYOBI_DRILL, RYOBI_IMPACT, RYOBI_CIRC, RYOBI_RECIP, RYOBI_MULTI, RYOBI_LIGHT, RYOBI_15],
    range: { low: 0.21, high: 0.44 }, leaves: ['4.0 Ah Battery', '18V Charger'],
    secondWay: { label: 'Sell the tools, keep the batteries and charger', leaves: ['PBP002', '4.0 Ah Battery', '18V Charger'], profitDelta: -31.4 },
  },
  {
    itemId: '317987595', slug: 'RYOBI-ONE-18V-Cordless-2-Tool-Combo-Kit-with-Drill-Driver-Impact-Driver-2-Compact-Batteries-and-Charger-PCL1200K2',
    brand: 'RYOBI', model: 'PCL1200K2', title: 'ONE+ 18V Cordless 2-Tool Combo Kit with Drill/Driver, Impact Driver, (2) Compact Batteries, and Charger',
    price: 99, was: 149, section: 'confirmed', matchState: 'verified', updatedMin: 47,
    parts: [RYOBI_DRILL, RYOBI_IMPACT, { ...RYOBI_15, qty: 2 }],
    unnamed: ['18V Charger'],
    leaves: ['18V Charger'],
  },
  {
    itemId: '345178210', slug: 'RYOBI-ONE-18V-Cordless-6-Tool-Combo-Kit-w-2-Batteries-Charger-300-Piece-Drill-Driving-Kit-PCL1600K2-A983002',
    brand: 'RYOBI', model: 'PCL1600K2-A983002', title: 'ONE+ 18V Cordless 6-Tool Combo Kit w/ (2) Batteries, Charger & 300-Piece Drill & Driving Kit',
    price: 258.97, was: 368, section: 'confirmed', matchState: 'title_match', updatedMin: 47,
    parts: [RYOBI_DRILL, RYOBI_IMPACT, RYOBI_CIRC, RYOBI_RECIP, RYOBI_MULTI, { ...RYOBI_LIGHT, grade: 'title_match' }, RYOBI_15],
    range: { low: 0.12, high: 0.27 }, leaves: ['4.0 Ah Battery', '18V Charger', '300-Piece Drill and Drive Kit'],
  },
  {
    itemId: '204373168', slug: 'DEWALT-20V-MAX-Cordless-Drill-Impact-2-Tool-Combo-Kit-with-2-20V-1-3Ah-Batteries-Charger-and-Bag-DCK240C2',
    brand: 'DEWALT', model: 'DCK240C2', title: '20V MAX Cordless Drill/Impact 2 Tool Combo Kit with (2) 20V 1.3Ah Batteries, Charger, and Bag',
    price: 149, was: 239, section: 'confirmed', matchState: 'verified', updatedMin: 47,
    parts: [
      { model: 'DCD771B', title: '20V MAX Cordless 1/2 in. Drill/Driver (Tool Only)', asin: 'B00ET5VMTU', price: 79, grade: 'verified' },
      { model: 'DCF885B', title: '20V MAX 1/4 in. Cordless Impact Driver (Tool Only)', asin: 'B00DL7QDBW', price: 89, grade: 'verified' },
      { model: 'DCB207', qty: 2, title: '20V MAX 1.3 Ah Compact Battery', asin: 'B00UXDJG9M', price: 39, grade: 'title_match' },
    ],
    range: { low: 0.19, high: 0.31 }, leaves: ['DCB107 charger', 'Contractor bag'],
  },
  {
    itemId: '322138483', slug: 'DEWALT-ATOMIC-20-Volt-MAX-Lithium-Ion-Cordless-Combo-Kit-2-Tool-with-2-2-0Ah-Batteries-Charger-and-Bag-DCK225D2',
    brand: 'DEWALT', model: 'DCK225D2', title: 'ATOMIC 20-Volt MAX Lithium-Ion Cordless Combo Kit (2-Tool) with (2) 2.0Ah Batteries, Charger and Bag',
    price: 169, was: 249, section: 'confirmed', matchState: 'title_match', updatedMin: 47,
    parts: [
      { model: 'DCD708B', title: 'ATOMIC 20V MAX Brushless 1/2 in. Drill/Driver (Tool Only)', asin: 'B07D4VB6MQ', price: 79, grade: 'verified' },
      { model: 'DCF809B', title: 'ATOMIC 20V MAX 1/4 in. Impact Driver (Tool Only)', asin: 'B07VK3DWGB', price: 89, grade: 'title_match' },
      { model: 'DCB203', qty: 2, title: '20V MAX 2.0 Ah Compact Battery', asin: 'B00BOHW0LM', price: 39, grade: 'verified' },
    ],
    range: { low: 0.08, high: 0.29 }, leaves: ['DCB112 charger', 'Kit bag'],
  },
  {
    itemId: '328690510', slug: 'RYOBI-ONE-18V-Cordless-2-Tool-Combo-Kit-with-5-1-2-in-Circular-Saw-and-Jig-Saw-Tools-Only-PCL500525SB',
    brand: 'RYOBI', model: 'PCL500525SB', title: 'ONE+ 18V Cordless 2-Tool Combo Kit with 5-1/2 in. Circular Saw and Jig Saw (Tools Only)',
    price: 79.88, was: 138, section: 'confirmed', matchState: 'needs_answer', updatedMin: 47, questionId: 'q-pcl500',
    parts: [
      { ...RYOBI_CIRC, grade: 'needs_answer' },
      { model: 'PCL525B', title: 'ONE+ 18V Cordless Jig Saw (Tool Only)', asin: 'B0B1G5NSBH', price: 49, grade: 'verified' },
    ],
    noEstimate: 'No estimate yet: PCL500B needs your answer before its price counts.',
  },
  {
    itemId: '337440459', slug: 'DEWALT-ATOMIC-20-Volt-Lithium-Ion-Cordless-2-Tool-Combo-Kit-Brushless-1-2-in-Impact-Wrench-w-5-Ah-2-Ah-Batteries-Charger-DCK200D1P1W921B',
    brand: 'DEWALT', model: 'DCK200D1P1W921B', title: 'ATOMIC 20-Volt Lithium-Ion Cordless 2-Tool Combo Kit, Brushless 1/2 in. Impact Wrench w/ 5 Ah, 2 Ah Batteries, Charger',
    price: 299, was: 538, section: 'split', matchState: 'contents_unknown', updatedMin: 47, questionId: 'q-dck200',
    parts: [], noEstimate: 'No estimate yet: which impact wrench comes with this kit needs your answer.',
  },
  {
    itemId: '324869940', slug: 'DEWALT-20-Volt-MAX-ToughSystem-Lithium-Ion-6-Tool-Cordless-Combo-Kit-DCKTS681D1P1',
    brand: 'DEWALT', model: 'DCKTS681D1P1', title: '20-Volt MAX ToughSystem Lithium-Ion 6-Tool Cordless Combo Kit',
    price: 529, was: 899, section: 'split', matchState: 'contents_unknown', updatedMin: 47, questionId: 'q-dckts',
    parts: [], noEstimate: 'No estimate yet: the six tools in this kit need your answer.',
  },
  {
    itemId: '320243741', slug: 'RYOBI-ONE-18V-Cordless-6-Tool-Combo-Kit-with-1-5-Ah-and-4-0-Ah-Batteries-Charger-and-Miter-Saw-PCL1600K2-P553',
    brand: 'RYOBI', model: 'PCL1600K2-P553', title: 'ONE+ 18V Cordless 6-Tool Combo Kit with 1.5 Ah and 4.0 Ah Batteries, Charger, and Miter Saw',
    price: 388, was: 488, section: 'waiting', matchState: 'waiting', updatedMin: 47, lookup: 2,
    parts: [RYOBI_DRILL, RYOBI_IMPACT, { model: 'P553', title: 'ONE+ 18V Cordless 7-1/4 in. Compound Miter Saw (Tool Only)', asin: null, price: null, grade: 'not_looked_up' }],
    noEstimate: 'No estimate yet: 2 parts still need an Amazon lookup.',
  },
  {
    itemId: '339379349', slug: 'RYOBI-ONE-18V-Cordless-12-Tool-Combo-Kit-with-3-Batteries-and-Charger-PCL2200K3N',
    brand: 'RYOBI', model: 'PCL2200K3N', title: 'ONE+18V Cordless 12-Tool Combo Kit with (3) Batteries and Charger',
    price: 679, was: 829, section: 'inactive_listing', matchState: 'inactive', updatedMin: 1460,
    parts: [RYOBI_DRILL, RYOBI_IMPACT, RYOBI_CIRC, RYOBI_RECIP, RYOBI_MULTI, { ...RYOBI_LIGHT, grade: 'verified' }, { ...RYOBI_15, qty: 3 },
      { model: 'PBLRC25B', title: 'ONE+ HP 18V Brushless 3/8 in. Extended Reach Ratchet', asin: 'B0B3JWF5ZV', price: 169, grade: 'verified' },
      { model: 'PCL900B', title: 'ONE+ 18V Cordless Hand Vacuum (Tool Only)', asin: null, price: null, grade: 'inactive', ebay: { low: 31, high: 44, listings: 2, sold: 9 }, ebayLinks: [{ url: 'https://www.ebay.com/itm/235482930111', price: 44 }, { url: 'https://www.ebay.com/itm/235482930222', price: 31 }] }],
    range: { low: -0.09, high: 0.08 },
  },
  {
    itemId: '339379205', slug: 'RYOBI-ONE-18V-Cordless-10-Tool-Combo-Kit-with-3-Batteries-and-Charger-PCL2001K3N',
    brand: 'RYOBI', model: 'PCL2001K3N', title: 'ONE+18V Cordless 10-Tool Combo Kit with (3) Batteries and Charger',
    price: 549, was: 679, section: 'missing_listing', matchState: 'missing', updatedMin: 47, questionId: 'q-pcl2001',
    parts: [], noEstimate: 'No estimate yet: the kit’s ten tools need your answer.',
  },
];

const BUILT = SEEDS.map(build);
export const DEALS: DealRow[] = BUILT.map((b) => b.row);
export const DETAILS: Record<string, DealDetail> = Object.fromEntries(BUILT.map((b) => [b.detail.id, b.detail]));

const bundleRef = (id: string) => {
  const d = DETAILS[id]!;
  return { id: d.id, title: d.title, brand: d.brand, model: d.model, link: d.link };
};

const RAW_QUESTIONS: Omit<ReviewQuestion, 'seen'>[] = [
  {
    id: 'q-dck200', kind: 'split', bundle: bundleRef('hd-337440459'), subject: 'DCK200D1P1W921B',
    prompt: 'Which impact wrench comes with this kit?',
    reason: 'The title names a 1/2 in. impact wrench; two DEWALT ATOMIC wrenches fit that name.',
    evidence: [
      { text: 'ATOMIC 20-Volt Lithium-Ion Cordless 2-Tool Combo Kit, Brushless 1/2 in. Impact Wrench w/ 5 Ah, 2 Ah Batteries, Charger', source: src('Home Depot page', DETAILS['hd-337440459']!.link) },
    ],
    choices: [
      { id: 'c1', label: 'DCF891B, DCD708B, DCB205, DCB203', models: ['DCF891B', 'DCD708B', 'DCB205', 'DCB203'], asin: null, source: null },
      { id: 'c2', label: 'DCF921B, DCD708B, DCB205, DCB203', models: ['DCF921B', 'DCD708B', 'DCB205', 'DCB203'], asin: null, source: null },
    ],
    allowNone: true, allowTyped: true,
    suggestion: {
      status: 'verified', choiceId: 'c2', answer: 'DCF921B + DCD708B + DCB205 + DCB203', reason: null, costUsd: 0.09,
      quotes: [
        { text: 'Includes: (1) DCF921B ATOMIC 20V MAX 1/2 in. Impact Wrench with Hog Ring Anvil', source: src('Home Depot page', DETAILS['hd-337440459']!.link) },
        { text: 'DCK200D1P1W921B: DCD708 drill/driver, DCF921 impact wrench, DCB205 5Ah and DCB203 2Ah batteries', source: src('dewalt.com', 'https://www.dewalt.com/search?q=DCK200D1P1W921B') },
      ],
    },
    askCostUsd: 0.1, openedAt: ago(52),
  },
  {
    id: 'q-pcl660', kind: 'match', bundle: bundleRef('hd-317987591'), subject: 'PCL660B',
    prompt: 'Which Amazon listing is the RYOBI PCL660B flashlight?',
    reason: 'Two listings name PCL660; one is a bulk two-pack.',
    evidence: [{ text: 'Includes: (1) PCL660B ONE+ 18V LED Flashlight', source: src('Home Depot page', DETAILS['hd-317987591']!.link) }],
    choices: [
      { id: 'B0B1GKJXNB', label: 'PCL660B ONE+ 18V Cordless LED Flash Light (Tool Only)', models: ['B0B1GKJXNB'], asin: 'B0B1GKJXNB', source: src('Amazon listing', amazon('B0B1GKJXNB')) },
      { id: 'B0CRSVC28P', label: '18V LED Light, PCL660 2Pk - Bulk Packaged, Handheld, Green', models: ['B0CRSVC28P'], asin: 'B0CRSVC28P', source: src('Amazon listing', amazon('B0CRSVC28P')) },
    ],
    allowNone: true, allowTyped: false,
    suggestion: {
      status: 'verified', choiceId: 'B0B1GKJXNB', answer: 'PCL660B ONE+ 18V Cordless LED Flash Light (Tool Only) · B0B1GKJXNB', reason: null, costUsd: 0.02,
      quotes: [{ text: 'PCL660B ONE+ 18V Cordless LED Flash Light (Tool Only)', source: src('Amazon listing', amazon('B0B1GKJXNB')) }],
    },
    askCostUsd: 0.02, openedAt: ago(52),
  },
  {
    id: 'q-dckts', kind: 'split', bundle: bundleRef('hd-324869940'), subject: 'DCKTS681D1P1',
    prompt: 'Which six tools come with this kit?',
    reason: 'The Home Depot page lists the tools by name only; no model numbers.',
    evidence: [{ text: '20-Volt MAX ToughSystem Lithium-Ion 6-Tool Cordless Combo Kit', source: src('Home Depot page', DETAILS['hd-324869940']!.link) }],
    choices: [], allowNone: true, allowTyped: true,
    suggestion: {
      status: 'verified', choiceId: null, answer: 'DCD771B + DCF885B + DCS381B + DCS391B + DCG412B + DCL040', reason: null, costUsd: 0.11,
      quotes: [
        { text: 'DCKTS681D1P1 includes DCD771 drill, DCF885 impact driver, DCS381 reciprocating saw, DCS391 circular saw, DCG412 grinder, DCL040 light', source: src('dewalt.com', 'https://www.dewalt.com/search?q=DCKTS681D1P1') },
      ],
    },
    askCostUsd: 0.1, openedAt: ago(52),
  },
  {
    id: 'q-pcl500', kind: 'match', bundle: bundleRef('hd-328690510'), subject: 'PCL500B',
    prompt: 'Which Amazon listing is the RYOBI PCL500B circular saw?',
    reason: 'The closest listing does not name PCL500B in its title.',
    evidence: [{ text: 'Includes: 18V ONE+ 5-1/2 in. Circular Saw and 18V ONE+ Jig Saw', source: src('Home Depot page', DETAILS['hd-328690510']!.link) }],
    choices: [
      { id: 'B0B1F877F3', label: 'ONEAND 18V Cordless 5 1/2 in. Circular Saw Tool ONLY', models: ['B0B1F877F3'], asin: 'B0B1F877F3', source: src('Amazon listing', amazon('B0B1F877F3')) },
      { id: 'B0CHSZLJ43', label: '18 V Volt ONE+ Cut-Out Tool Cordless Tool Only', models: ['B0CHSZLJ43'], asin: 'B0CHSZLJ43', source: src('Amazon listing', amazon('B0CHSZLJ43')) },
    ],
    allowNone: true, allowTyped: false,
    suggestion: {
      status: 'unverified', choiceId: null, answer: 'ONEAND 18V Cordless 5 1/2 in. Circular Saw Tool ONLY · B0B1F877F3',
      reason: 'The listing’s title does not name PCL500B, and its page was not read.', costUsd: 0.02,
      quotes: [{ text: 'ONEAND 18V Cordless 5 1/2 in. Circular Saw Tool ONLY', source: src('Amazon listing', amazon('B0B1F877F3')) }],
    },
    askCostUsd: 0.02, openedAt: ago(1440),
  },
  {
    id: 'q-ebay-921', kind: 'ebay', bundle: bundleRef('hd-337440459'), subject: 'DCF921B',
    prompt: 'Is this eBay listing exactly DCF921B, New, with the same contents?',
    reason: 'The listing says “New (other)” and shows no box.',
    evidence: [{ text: 'DEWALT DCF921B ATOMIC 20V 1/2" Impact Wrench Hog Ring - Tool Only. $139.00 · 12 sold', source: src('eBay listing', 'https://www.ebay.com/sch/i.html?_nkw=DCF921B') }],
    choices: [
      { id: 'yes', label: 'Yes', models: [], asin: null, source: null },
      { id: 'no', label: 'No', models: [], asin: null, source: null },
    ],
    allowNone: false, allowTyped: false, suggestion: null, askCostUsd: null, openedAt: ago(300),
  },
  {
    id: 'q-pcl2001', kind: 'split', bundle: bundleRef('hd-339379205'), subject: 'PCL2001K3N',
    prompt: 'Which ten tools come with this kit?',
    reason: 'Two Home Depot listings share PCL2001K3N with different tool lists.',
    evidence: [
      { text: 'ONE+18V Cordless 10-Tool Combo Kit with (3) Batteries and Charger', source: src('Home Depot page', DETAILS['hd-339379205']!.link) },
      { text: 'ONE+ 18V Cordless 10-Tool Combo Kit with (1) Compact Battery and (2) 4.0 Ah Batteries and Charger', source: src('Home Depot page, older listing', hd('320511074', 'RYOBI-ONE-18V-Cordless-10-Tool-Combo-Kit-with-1-Compact-Battery-and-2-4-0-Ah-Batteries-and-Charger-PCL2001K3N')) },
    ],
    choices: [], allowNone: true, allowTyped: true,
    suggestion: { status: 'cannot_tell', choiceId: null, answer: '', reason: 'The two Home Depot pages list different tools under the same model.', costUsd: 0.1, quotes: [] },
    askCostUsd: 0.1, openedAt: ago(1500),
  },
];

/** Each question's signature, as the agent would send it. */
export const QUESTIONS: ReviewQuestion[] = RAW_QUESTIONS.map((q) => ({ ...q, seen: `sig:${q.id}` }));

export const STATE: AppState = {
  agent: {
    status: 'idle', pipeline: null, step: null, nextScanAt: ahead(133),
    lastScan: { at: ago(47), result: 'finished', newDeals: 3, searches: 5, message: null },
  },
  helper: { paired: true, connected: true, lastSeenAt: ago(1), jobsWaiting: 0 },
  budget: { serpLeft: 187, serpMonthly: 250, serpReserve: 20, serpPerScan: 5, keepaTokens: 1180, aiSpentUsd: 4.12, aiCapUsd: 20 },
  counts: { review: QUESTIONS.length, autopilotApplied: 3, newDeals: 3 },
  keys: { serpapi: true, keepa: true, anthropic: true, openai: false, ebay: true, telegram: false },
  firstRun: false,
};

const run = (r: Omit<Run, 'error' | 'steps'> & { error?: string }): Run => ({ error: null, steps: [], ...r });

export const ACTIVITY: ActivityView = {
  runs: [
    run({ id: 'r6', kind: 'scan', byYou: false, startedAt: ago(52), finishedAt: ago(47), searches: 5, keepaTokens: 40, aiUsd: 0.34, result: 'finished', summary: '11 bundles, 3 with an estimate. Autopilot applied 3.' }),
    run({ id: 'r5', kind: 'lookup', byYou: true, startedAt: ago(190), finishedAt: ago(189), searches: 2, keepaTokens: 0, aiUsd: 0, result: 'finished', summary: 'Look up: 2 searches.' }),
    run({ id: 'r4', kind: 'scan', byYou: false, startedAt: ago(412), finishedAt: ago(406), searches: 5, keepaTokens: 38, aiUsd: 0.21, result: 'failed', summary: 'Scan failed.', error: 'SerpApi did not answer after the second page.' }),
    run({ id: 'r3', kind: 'ask', byYou: true, startedAt: ago(780), finishedAt: ago(771), searches: 0, keepaTokens: 0, aiUsd: 0.52, result: 'finished', summary: 'AI asked about 6, 4 verified.' }),
    run({ id: 'r2', kind: 'scan', byYou: false, startedAt: ago(772), finishedAt: ago(766), searches: 5, keepaTokens: 41, aiUsd: 0.18, result: 'limit', summary: 'Scan stopped at the limit.', error: 'Stopped at the hourly limit of 50 searches.' }),
    run({ id: 'r1', kind: 'scan', byYou: true, startedAt: ago(1500), finishedAt: ago(1493), searches: 5, keepaTokens: 44, aiUsd: 0.4, result: 'finished', summary: '9 bundles, 1 with an estimate.' }),
  ],
  autopilot: [
    { id: 'a3', at: ago(48), bundleId: 'hd-317987595', title: DETAILS['hd-317987595']!.title, model: 'PCL1200K2', kind: 'match', applied: 'PCL235B · B0BGYFTPGK', verifiedBy: ['the quote was found word for word on the Amazon listing', 'the quote names PCL235B'], by: 'claude-sonnet-4-5', undone: false, undoable: true },
    { id: 'a2', at: ago(48), bundleId: 'hd-345178210', title: DETAILS['hd-345178210']!.title, model: 'PCL1600K2-A983002', kind: 'split', applied: 'PCL1600K2 + A983002', verifiedBy: ['the quote was found word for word on the Home Depot page', 'the answer is one of the question’s readings'], by: 'claude-sonnet-4-5', undone: false, undoable: true },
    { id: 'a1', at: ago(49), bundleId: 'hd-204373168', title: DETAILS['hd-204373168']!.title, model: 'DCK240C2', kind: 'match', applied: 'DCF885B · B00DL7QDBW', verifiedBy: ['the quote was found word for word on the Amazon listing'], by: 'claude-sonnet-4-5', undone: false, undoable: false },
  ],
  errors: [
    { id: 'e1', at: ago(406), sentence: 'SerpApi did not answer during the scan at 4:00 PM, so 3 bundles kept their older prices. Retry the scan.', retry: { label: 'Retry scan', searches: 5, usd: 0 } },
  ],
  month: { searches: 63, keepaTokens: 820, aiUsd: 4.12 },
};
