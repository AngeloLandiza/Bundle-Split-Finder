// The one client every screen talks to. `VITE_MOCK=1` selects the fixture-backed mock; otherwise
// the real HTTP client against the agent (same origin, bearer token from the shell). Both answer
// in the shapes of types.ts, which map.ts builds from the agent's contract.

import type { InstallExtensionResponse, KeyValues } from '@core/api/contract';
import { createHttpClient } from './http';
import { createMockClient } from './mock';
import type {
  ActivityView,
  AgentEvent,
  AppSettings,
  AppState,
  BogoRequest,
  BogoView,
  ConfirmPriceRequest,
  DealDetail,
  DealSort,
  DealsView,
  KeyName,
  LookupsRun,
  PairedExtension,
  PendingPairRequest,
  ReviewAnswer,
  ReviewView,
  SettingsPatch,
  StreamStatus,
} from './types';

export interface ApiClient {
  state(): Promise<AppState>;
  deals(): Promise<DealsView>;
  deal(id: string): Promise<DealDetail>;
  /** Saves the deals as CSV (GET /api/deals/export.csv): the token goes in a header, so a plain link cannot fetch it. */
  downloadDealsCsv(query: { sort: DealSort }): Promise<void>;

  review(): Promise<ReviewView>;
  /** `seen` is the question's signature as it was shown; the agent refuses the answer when the question has changed. */
  answer(id: string, answer: ReviewAnswer, o: { fromSuggestion: boolean; seen: string | null }): Promise<{ answerId: string | null }>;
  /** Takes back an answer he saved (POST /api/review/:id/undo, the id `answer` returned): the question is open in Review again. */
  undoAnswer(answerId: string): Promise<{ questionId: string }>;
  ask(id: string): Promise<void>;
  askAll(): Promise<void>;
  approve(ids: string[]): Promise<{ approved: number; skipped: { id: string; reason: string }[] }>;

  activity(): Promise<ActivityView>;
  undo(autopilotId: string): Promise<void>;
  retry(errorId: string): Promise<void>;

  scan(): Promise<void>;
  /** Reads again the Home Depot pages the last scan could not read (POST /api/scan/read-pages). Free: no search is spent. */
  readPagesAgain(): Promise<{ started: boolean; reason?: string }>;
  /**
   * Looks up the parts that wait for an Amazon lookup now (POST /api/lookups/run): Keepa tokens first, then up to
   * `maxSearches` SerpApi searches within the per-scan cap and above the reserve. `started: false` carries the reason.
   */
  runLookups(body?: { maxSearches?: number }): Promise<LookupsRun>;
  /** Asks Chrome to reload the helper extension when it is older than the app (POST /api/helper/reload). */
  reloadHelper(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** What a Look up of this bundle's unmatched parts would spend now, in searches. Free. */
  lookupQuote(dealId: string): Promise<number>;
  lookUp(dealId: string): Promise<void>;
  verify(dealId: string, model: string): Promise<void>;
  /** Confirms a sell price for one part of a deal (POST /api/deals/:id/parts/:part/price). The agent never makes up a figure. */
  confirmPrice(dealId: string, model: string, body: ConfirmPriceRequest): Promise<void>;
  /** Watches or stops watching a deal (POST /api/deals/:id/watch). */
  watch(dealId: string, watch: boolean): Promise<void>;
  /** Marks the deal as a BOGO promotion and/or chooses the free tool (POST /api/deals/:id/bogo). Resolves to the promotion with its estimate. */
  setBogo(dealId: string, body: BogoRequest): Promise<BogoView | null>;
  /** Removes the promotion (DELETE /api/deals/:id/bogo): the deal is no longer a BOGO. */
  removeBogo(dealId: string): Promise<void>;
  /** Removes the confirmed price (DELETE on the same path). */
  removePrice(dealId: string, model: string): Promise<void>;

  settings(): Promise<AppSettings>;
  patchSettings(patch: SettingsPatch): Promise<AppSettings>;
  /** Write-only: the agent never sends a key back. eBay takes {appId, certId}, Telegram {botToken, chatId}. */
  putKey<N extends KeyName>(name: N, value: KeyValues[N]): Promise<void>;
  deleteKey(name: KeyName): Promise<void>;

  /** Asks the agent for one notification on this Mac (POST /api/notify/test), so the owner can see how they arrive. */
  testNotification(): Promise<void>;

  /** Chrome's pairing requests waiting for the owner, newest last. */
  pairRequests(): Promise<PendingPairRequest[]>;
  decidePairing(requestId: string, allow: boolean): Promise<void>;
  pairedExtensions(): Promise<PairedExtension[]>;
  revokeExtension(extensionId: string): Promise<void>;
  /** Unpacks the bundled Chrome helper to its folder (POST /api/setup/install-extension). Rejects with the agent's sentence. */
  installExtension(): Promise<InstallExtensionResponse>;

  /** Server-sent events; reconnects with a growing wait by itself. Returns the unsubscribe. */
  subscribe(onEvent: (e: AgentEvent) => void, onStatus: (s: StreamStatus) => void): () => void;
}

export const api: ApiClient = import.meta.env.VITE_MOCK === '1' ? createMockClient() : createHttpClient();
