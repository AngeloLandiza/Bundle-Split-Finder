// The one client every screen talks to. `VITE_MOCK=1` selects the fixture-backed mock; otherwise
// the real HTTP client against the agent (same origin, bearer token from the shell).

import type {
  ActivityResponse,
  AgentEvent,
  AppState,
  DealDetail,
  DealsResponse,
  KeyName,
  ReviewAnswer,
  ReviewResponse,
  Settings,
  SettingsPatch,
} from './types';
import { createHttpClient } from './http';
import { createMockClient } from './mock';

export interface ApiClient {
  state(): Promise<AppState>;
  deals(): Promise<DealsResponse>;
  deal(id: string): Promise<DealDetail>;
  /** The CSV of the deals as shown (UI asks: GET /api/deals/export.csv?section&sort). */
  dealsCsvUrl(query: { section: string | null; sort: string }): string;

  review(): Promise<ReviewResponse>;
  answer(id: string, answer: ReviewAnswer, fromAi: boolean): Promise<void>;
  /** UI asks: POST /api/review/:id/ask. */
  ask(id: string): Promise<void>;
  askAll(): Promise<void>;
  approve(ids: string[]): Promise<{ approved: number; refused: number }>;

  activity(): Promise<ActivityResponse>;
  undo(autopilotId: string): Promise<void>;
  /** UI asks: POST /api/activity/errors/:id/retry. */
  retry(errorId: string): Promise<void>;

  scan(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** UI asks: POST /api/deals/:id/lookup and /verify {model}. */
  lookUp(dealId: string): Promise<void>;
  verify(dealId: string, model: string): Promise<void>;

  settings(): Promise<Settings>;
  patchSettings(patch: SettingsPatch): Promise<Settings>;
  /** Write-only: the agent never sends a key back. */
  putKey(name: KeyName, value: string): Promise<void>;
  /** UI asks: DELETE /api/keys/:name. */
  deleteKey(name: KeyName): Promise<void>;

  /** Approve a waiting pairing request from Chrome; revoke the paired helper (UI asks: POST /api/pair/revoke). */
  approvePairing(): Promise<void>;
  revokePairing(): Promise<void>;

  /** Server-sent events. Returns the unsubscribe. `onDown` fires when the stream drops. */
  subscribe(onEvent: (e: AgentEvent) => void, onDown: () => void): () => void;
}


export const api: ApiClient = import.meta.env.VITE_MOCK === '1' ? createMockClient() : createHttpClient();
