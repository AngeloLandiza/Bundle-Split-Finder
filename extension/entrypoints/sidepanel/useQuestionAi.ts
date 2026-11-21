// Ask AI for one Review question, shared by Review, Detail and This page.
// Ask AI about all still uses canAsk (core/src/assist/askAll.ts) and does not queue a match with no listing.

import { useState } from 'react';
import { canAsk } from '@core/assist/askAll';
import { questionCostLabel } from '@core/assist/cost';
import { liveSuggestion, type StoredSuggestion } from '@core/assist/stored';
import { DEFAULT_CLAUDE_JUDGE_MODEL } from '@core/judge/claude';
import type { ReviewItem } from '@core/scan/types';
import type { AppState, PanelReport } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { notSuggestedSentence } from './AiSuggestion';
import type { AiControl } from './ReviewQuestion';

export function useQuestionAi(api: WorkerApi, report: PanelReport | null, state: AppState) {
  const [asking, setAsking] = useState<string | null>(null);
  const [aiNotice, setAiNotice] = useState<{ id: string; text: string } | null>(null);
  const [got, setGot] = useState<Readonly<Record<string, StoredSuggestion>>>({});
  const hasAi = state.ebay?.hasAnthropicKey === true;
  const model = state.ebay?.judgeModel ?? DEFAULT_CLAUDE_JUDGE_MODEL;
  const records = [...Object.values(got), ...(report?.aiSuggestions ?? [])];
  const suggestionFor = (r: ReviewItem): StoredSuggestion | null => liveSuggestion(records, r) ?? null;

  const ask = async (r: ReviewItem): Promise<void> => {
    if (asking !== null) return;
    setAsking(r.id);
    setAiNotice(null);
    try {
      const reply = await api.send<StoredSuggestion>({ type: 'askAi', questionId: r.id });
      if (!reply.ok) setAiNotice({ id: r.id, text: reply.error });
      else if (reply.data.suggestion.status === 'not_suggested') setAiNotice({ id: r.id, text: notSuggestedSentence(reply.data.suggestion) });
      else setGot((g) => ({ ...g, [r.id]: reply.data }));
    } catch {
      setAiNotice({ id: r.id, text: UNREACHABLE });
    } finally {
      setAsking(null);
    }
  };

  /** A button on every Review question once a key is saved. A match with no listing still gets one, with no price: no call is made. */
  const aiFor = (r: ReviewItem): AiControl | undefined => {
    const suggestion = suggestionFor(r);
    const offered = canAsk(r) || r.kind === 'match';
    if (!suggestion && !(hasAi && offered)) return undefined;
    return {
      cost: canAsk(r) ? questionCostLabel(r.kind, model) : null,
      suggestion,
      asking: asking === r.id,
      queueRunning: state.askAll != null,
      notice: aiNotice?.id === r.id ? aiNotice.text : null,
      onAsk: () => void ask(r),
    };
  };

  const clear = (id: string): void => {
    setGot(({ [id]: _dropped, ...rest }) => rest);
  };

  return { aiFor, got, suggestionFor, records, clear };
}
