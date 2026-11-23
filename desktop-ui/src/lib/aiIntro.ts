// The first-use line above the first AI suggestion ever shown (docs/ux-checklist.md, "AI suggestions he approves":
// before the first suggestion the app says what the AI does and that it can be wrong; HAX G1, G2). Dismissible and
// remembered in this window's storage; where storage is blocked it shows again next time, which is harmless.

const KEY = 'splitFinder.aiIntroDismissed';

export const AI_INTRO =
  'Suggested by AI: it reads the page text and proposes an answer. It can be wrong. Only answers the code has checked against the page are ever applied without you.';

/** The same warning as one line under the decision card: it says what the AI is and that it can be wrong, and nothing more. */
export const AI_FOOTNOTE = 'AI can be wrong. Only verified answers apply without you.';

export function aiIntroDismissed(storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissAiIntro(storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, '1');
  } catch {
    // shown again next time
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
