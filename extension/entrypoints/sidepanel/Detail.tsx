import type { AppState, PanelReport } from '../../lib/messages';

export interface DetailProps {
  report: PanelReport | null;
  state: AppState;
  bundleKey: string;
  onBack: () => void;
}

// Stub: the bundle detail comes in a later task. It is a full panel with its own top bar.
export function Detail({ bundleKey, onBack }: DetailProps) {
  return (
    <div className="stub">
      <button type="button" onClick={onBack}>
        Back
      </button>
      <p>{bundleKey}</p>
    </div>
  );
}
