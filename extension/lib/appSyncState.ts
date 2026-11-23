import { agentBridgeEndpoints } from './agentBridge';
import type { AppState } from './messages';

const base = agentBridgeEndpoints().url.replace(/\/api\/bridge$/, '');

/** POST sanitized meters so the native app can show SerpApi / Keepa footer (P3). */
export async function postHelperState(state: AppState): Promise<void> {
  const account = state.account;
  const keepa = state.keepa;
  const job = state.lastJob;
  const body = {
    hasKey: state.hasKey,
    hasAnthropicKey: state.ebay?.hasAnthropicKey === true,
    scanRunning: state.scanRunning,
    askAiAllRunning: state.askAll !== undefined,
    searchesLeft: account?.totalSearchesLeft ?? null,
    searchesPerMonth: account?.searchesPerMonth ?? null,
    keepaTokensLeft: keepa?.hasKeepaKey && keepa.tokensLeft !== null ? keepa.tokensLeft : null,
    keepaRefillMin: keepa?.refillIn ?? null,
    searchesPerScan: state.settings.searchesPerScan,
    rateLimitPerHour: account?.rateLimitPerHour ?? null,
    lastJob: job
      ? {
          status: job.status,
          stopReason: job.stopReason,
          stopMessage: job.stopMessage,
          searchesUsed: job.searchesUsed,
          finishedAt: job.finishedAt,
          deferred: job.deferred,
          ebayNotice: job.ebayNotice ?? null,
        }
      : null,
  };
  try {
    await fetch(`${base}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // ignore
  }
}