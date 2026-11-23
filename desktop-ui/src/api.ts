import type { StoredSuggestion } from '@core/assist/stored';
import type { Schedule } from '@core/schedule';
import type { EbaySettings } from '@core/settings';

const origin = typeof window !== 'undefined' ? window.location.origin : '';

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${origin}${path}`, init);
  return (await res.json()) as T;
}

export type SetupStatus = {
  ok: boolean;
  extensionReady?: boolean;
  extensionDir?: string;
  extensionMessage?: string;
  zipAvailable?: boolean;
};

export type AppSettings = {
  ok: boolean;
  serpApiKeySet?: boolean;
  keepaKeySet?: boolean;
  ebayKeysSet?: boolean;
  anthropicKeySet?: boolean;
  askAfterScan?: boolean;
  ebaySettings?: EbaySettings;
  appPrimaryUi?: boolean;
  compactHelperPanel?: boolean;
  settings?: {
    schedule?: Schedule;
    searchesPerScan?: number;
    reserve?: number;
    agentBridgeAfterScan?: boolean;
    keepaTokensPerScan?: number;
    keepaReserve?: number;
    fees?: {
      referralRate?: number;
      fulfillmentFee?: number;
      minReferral?: number;
      salesTaxRate?: number;
      inboundCost?: number;
    };
    brands?: string[];
    pagesPerBrand?: number;
  };
};

export type DealRow = {
  key: string;
  brand: string;
  model: string;
  title: string;
  section: string;
  itemId: number | null;
  price?: number | null;
  percentOff?: number | null;
  profit?: number | null;
  roi?: number | null;
  roiLowest?: number | null;
  roiHighest?: number | null;
  matchLine?: string | null;
  needsReview?: boolean;
  lookupParts?: Array<{ brand: string; model: string }>;
};

export type ReviewOpenRow = { id: string; kind: string; bundleKey: string | null };

export type PanelBundle = {
  key: string;
  title: string;
  brand: string;
  model: string;
  price: number | null;
  percentOff: number | null;
  section: string;
  link: string | null;
  parts: Array<{ model: string; grade?: string | null; price?: number | null }>;
  estimate: { profit: number; roi: number; cost: number; netRevenue: number } | null;
};

export type DealsResponse = {
  ok: boolean;
  at?: string;
  staleDays?: number | null;
  limitNotice?: { title: string; text: string; limit: boolean } | null;
  ebayNotice?: string | null;
  bundles?: DealRow[];
  reviewOpen?: ReviewOpenRow[];
  message?: string;
};

export type EbayReviewQuestion = {
  id: string;
  key: string;
  brand: string;
  model: string;
  itemId: string;
  title: string;
  url: string;
  price: number | null;
  soldQuantity: number | null;
  reasons: string[];
  openedAt: number;
};

export type ReviewQuestion = {
  id: string;
  kind: string;
  brand: string;
  model: string;
  title: string | null;
  reason: string;
  choices: string[][];
  candidates?: Array<{ asin: string; title: string | null }>;
  openedAt?: number;
};

export type SerpCheckResponse =
  | { ok: true; account: { planName: string; totalSearchesLeft: number; searchesPerMonth: number; rateLimitPerHour: number } }
  | { ok: false; message: string };

export type EbayCheckResponse = { ok: true } | { ok: false; message: string };

export const api = {
  setup: () => json<SetupStatus>('/api/setup/status'),
  checkEbayKeys: (ebayAppId: string, ebayCertId: string) =>
    json<EbayCheckResponse>('/api/settings/check-ebay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ebayAppId, ebayCertId }),
    }),
  checkSerpKey: (serpApiKey: string) =>
    json<SerpCheckResponse>('/api/settings/check-serp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serpApiKey }),
    }),
  installHelper: () => json<SetupStatus & { ok: boolean }>('/api/setup/install-extension', { method: 'POST' }),
  settings: () => json<AppSettings>('/api/settings'),
  saveSettings: (body: Record<string, unknown>) =>
    json<{ ok: boolean; serpApiKeySet?: boolean }>('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  scanStart: () => json<{ ok: boolean }>('/api/scan/start', { method: 'POST' }),
  deals: () => json<DealsResponse>('/api/deals'),
  deal: (key: string) => json<{ ok: boolean; bundle?: PanelBundle; message?: string }>(`/api/deals/${encodeURIComponent(key)}`),
  review: () =>
    json<{
      ok: boolean;
      questions?: ReviewQuestion[];
      ebayQuestions?: EbayReviewQuestion[];
      aiSuggestions?: StoredSuggestion[];
      message?: string;
    }>('/api/review'),
  askReview: (questionId: string) =>
    json<{ ok: boolean }>('/api/review/ask/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId }),
    }),
  askAllReview: () =>
    json<{ ok: boolean }>('/api/review/ask/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    }),
  queueLookUp: (brand: string, parts: Array<{ brand: string; model: string }>) =>
    json<{ ok: boolean }>('/api/paid/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: { kind: 'lookUp', parts } }),
    }),
  queueReview: (
    id: string,
    answer: { choice: number } | { none: true } | { parts: string[] } | { ebay: 'yes' | 'no' },
    aiSuggestion?: boolean,
  ) =>
    json<{ ok: boolean }>('/api/review/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, answer, ...(aiSuggestion ? { aiSuggestion: true } : {}) }),
    }),
  bridge: () => json<{ ok: boolean; summary?: { bundleCount: number; at: string } }>('/api/bridge'),
};