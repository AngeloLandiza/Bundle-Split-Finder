// The one client every screen talks to. `VITE_MOCK=1` selects the fixture-backed mock; otherwise
// the real HTTP client against the agent (same origin, bearer token from the shell). Both answer
// in the shapes of types.ts, which map.ts builds from the agent's contract.

import type { InstallExtensionResponse, KeyCheck, KeyValues, PriceFromLinkResponse } from '@core/api/contract';
import type { CostSettingsPatch } from '../lib/costs';
import { createHttpClient } from './http';
import type {
  ActivityView,
  AgentEvent,
  AppSettings,
  AppState,
  AskAiResult,
  BogoRequest,
  BogoView,
  ConfirmPriceRequest,
  DealDetail,
  DealSort,
  DealsView,
  KeyName,
  LookupsRun,
  OutcomesResponse,
  PartOutcomeBody,
  PurchasePatch,
  PurchaseResponse,
  RecordPurchaseBody,
  PairedExtension,
  PendingPairRequest,
  ReviewAnswer,
  ReviewView,
  CostsView,
  SettingsPatch,
  StreamStatus,
} from './types';

export interface ApiClient {
  state(): Promise<AppState>;
  deals(): Promise<DealsView>;
  deal(id: string): Promise<DealDetail>;
  /** Saves the deals as CSV (GET /api/deals/export.csv): the token goes in a header, so a plain link cannot fetch it. */
  downloadDealsCsv(query: { sort: DealSort }): Promise<void>;
  /** Saves the audit file (GET /api/export/audit): what a developer needs to see what happened. No key is in it. */
  downloadAudit(): Promise<void>;
  /** Clears the scan data only (POST /api/data/reset); the agent keeps a backup and says where. Keys, settings and pairing stay. */
  resetScanData(): Promise<{ backup: string }>;

  review(): Promise<ReviewView>;
  /** `seen` is the question's signature as it was shown; the agent refuses the answer when the question has changed. */
  answer(
    id: string, answer: ReviewAnswer, o: { fromSuggestion: boolean; seen: string | null; remember?: string[] },
  ): Promise<{ answerId: string | null; remembered?: { models: string[]; settled: string[]; skipped: { model: string; why: string }[] } }>;
  /** Answer once (Nov 23): "In the box, not sold separately" for a model, or that answer kept after newer evidence (POST /api/facts). */
  markNotSold(brand: string, model: string): Promise<void>;
  /** Answer once, "Change": forgets what he settled about a model (DELETE /api/facts/:key); the bundles it settled are asked about again. */
  forgetFact(key: string, field?: 'isPart' | 'sellAs' | 'notSoldSeparately'): Promise<void>;
  /** Takes back an answer he saved (POST /api/review/:id/undo, the id `answer` returned): the question is open in Review again. */
  undoAnswer(answerId: string): Promise<{ questionId: string }>;
  /**
   * Asks the AI about one question (POST /api/review/:id/ask). Never silent: `queued`, or the agent's `reason` nothing was
   * started. `force` asks again though nothing new has been read since the last answer.
   */
  askAi(id: string, o?: { force?: boolean }): Promise<AskAiResult>;
  askAll(): Promise<void>;
  approve(ids: string[]): Promise<{ approved: number; skipped: { id: string; reason: string }[] }>;

  /** Outcomes: what he bought and what became of each part, with the scorecard's records (GET /api/outcomes). */
  outcomes(): Promise<OutcomesResponse>;
  /** "I bought this" (POST /api/outcomes): the agent freezes the deal's estimate at this moment. */
  recordPurchase(body: RecordPurchaseBody): Promise<PurchaseResponse>;
  /** Corrects the date, price paid or quantity of a purchase (PATCH /api/outcomes/:id); the frozen estimate cannot be changed. */
  editPurchase(id: string, patch: PurchasePatch): Promise<PurchaseResponse>;
  /** Sold, still holding, or returned / not sold, for one part (POST /api/outcomes/:id/parts/:part). */
  recordPart(id: string, partId: string, body: PartOutcomeBody): Promise<PurchaseResponse>;
  /** Removes a purchase record (DELETE /api/outcomes/:id); the entry it returns takes it back. */
  removePurchase(id: string): Promise<{ entryId: string }>;
  /** Takes back one recorded change (POST /api/outcomes/entries/:id/undo). */
  undoOutcome(entryId: string): Promise<void>;
  /** Saves the outcomes as CSV (GET /api/outcomes/export.csv). */
  downloadOutcomesCsv(): Promise<void>;

  activity(): Promise<ActivityView>;
  undo(autopilotId: string): Promise<void>;
  retry(errorId: string): Promise<void>;

  scan(): Promise<void>;
  /** Reads again the Home Depot pages the last scan could not read (POST /api/scan/read-pages). Free: no search is spent. */
  readPagesAgain(): Promise<{ started: boolean; reason?: string }>;
  /**
   * Looks up the parts that wait for an Amazon lookup now (POST /api/lookups/run): Keepa tokens first, then up to
   * `maxSearches` SerpApi searches within the per-scan cap and above the reserve. `started: false` carries the reason.
   * `useReserve` is the owner's explicit yes to spend from the reserve ("Use searches for these"); without it the reserve is kept.
   */
  runLookups(body?: { maxSearches?: number; useReserve?: boolean }): Promise<LookupsRun>;
  /** Asks Chrome to reload the helper extension when it is older than the app (POST /api/helper/reload). */
  reloadHelper(): Promise<void>;
  /** Closes the new-version notice for this version, for good (POST /api/update/dismiss). */
  dismissUpdate(version: string): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** What a Look up of this bundle's unmatched parts would spend now, in searches. Free. */
  lookupQuote(dealId: string): Promise<number>;
  lookUp(dealId: string): Promise<void>;
  /** His verdict on a "Needs a look" finding (POST /api/deals/:id/needs-look): right remembers it, wrong withdraws the listing. */
  settleNeedsLook(dealId: string, clearKey: string, verdict: 'right' | 'wrong'): Promise<void>;
  verify(dealId: string, model: string): Promise<void>;
  /** Confirms a sell price for one part of a deal (POST /api/deals/:id/parts/:part/price). The agent never makes up a figure. */
  confirmPrice(dealId: string, model: string, body: ConfirmPriceRequest): Promise<void>;
  /** Watches or stops watching a deal (POST /api/deals/:id/watch). */
  watch(dealId: string, watch: boolean): Promise<void>;
  /** Marks the deal as a BOGO promotion and/or chooses the free tool (POST /api/deals/:id/bogo). Resolves to the promotion with its estimate. */
  setBogo(dealId: string, body: BogoRequest): Promise<BogoView | null>;
  /** Removes the promotion (DELETE /api/deals/:id/bogo): the deal is no longer a BOGO. */
  removeBogo(dealId: string): Promise<void>;
  /** Reads a pasted link for its price (POST /api/price-from-link): eBay, Amazon through Keepa, Home Depot through Chrome. It only shows a price; it counts when he confirms it. */
  priceFromLink(url: string): Promise<PriceFromLinkResponse>;
  /** Removes the confirmed price (DELETE on the same path). */
  removePrice(dealId: string, model: string): Promise<void>;

  settings(): Promise<AppSettings>;
  patchSettings(patch: SettingsPatch): Promise<AppSettings>;
  /**
   * Write-only: the agent never sends a key back. eBay takes {appId, certId}, Telegram {botToken, chatId}. The key is saved either
   * way; the answer is what its own service said within ten seconds (a rejection, a working key with what it found, or "could not reach").
   */
  putKey<N extends KeyName>(name: N, value: KeyValues[N]): Promise<KeyCheck>;
  /** Checks the stored key again with its own service (POST /api/keys/:name/check), from the stored value; nothing is typed. */
  checkKey(name: KeyName): Promise<KeyCheck>;
  deleteKey(name: KeyName): Promise<void>;

  /** Asks the agent for one notification on this Mac (POST /api/notify/test), so the owner can see how they arrive. */
  testNotification(): Promise<void>;
  /** Sends one test message to the saved Telegram bot and chat (POST /api/notify/test-telegram). `problem` is Telegram's refusal in plain words. */
  testTelegram(): Promise<{ ok: boolean; problem?: string }>;

  /** Chrome's pairing requests waiting for the owner, newest last. */
  pairRequests(): Promise<PendingPairRequest[]>;
  decidePairing(requestId: string, allow: boolean): Promise<void>;
  pairedExtensions(): Promise<PairedExtension[]>;
  revokeExtension(extensionId: string): Promise<void>;
  /** Unpacks the bundled Chrome helper to its folder (POST /api/setup/install-extension). Rejects with the agent's sentence. */
  installExtension(): Promise<InstallExtensionResponse>;

  /** What the services cost: this month, the forecast, each service against its limit, the owner's limits (GET /api/costs). */
  costs(): Promise<CostsView>;
  /**
   * Saves a change to the cost limits, prices or budget (PATCH /api/settings with `{ costs: patch }`): only what changed;
   * null clears a limit, a price or the total. Resolves to the view as the agent now computes it, since a limit moves the
   * states and the forecast's "reached on".
   */
  patchCosts(patch: CostSettingsPatch): Promise<CostsView>;

  /** Server-sent events; reconnects with a growing wait by itself. Returns the unsubscribe. */
  subscribe(onEvent: (e: AgentEvent) => void, onStatus: (s: StreamStatus) => void): () => void;
}

// The mock is loaded by a dynamic import so a production build leaves it (and its fixture data) out.
export const api: ApiClient =
  import.meta.env.VITE_MOCK === '1' ? (await import('./mock')).createMockClient() : createHttpClient();
