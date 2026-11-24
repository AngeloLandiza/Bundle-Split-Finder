import { useContext } from 'react';
import { Button } from './Button';
import { UiContext } from './ui';
import { askMainForRunStep } from '../lib/runStep';
import { wantRunStep } from '../screens/WelcomeRun';

/**
 * "Recommended schedule…": opens the welcome sheet at its last step, "Let it run by itself". The sheet lives in the
 * main window. In the main window this opens it directly. The Preferences window is a page of its own with no
 * UiContext (the first build of this link called useUi() there, which threw and left Settings, Scanning blank), so
 * from there it asks the main window through localStorage (lib/runStep.ts).
 */
export function RecommendedScheduleLink() {
  const ui = useContext(UiContext);
  return (
    <Button
      size="sm"
      onClick={() => {
        if (ui) {
          wantRunStep();
          ui.openSetup();
        } else {
          askMainForRunStep();
        }
      }}
    >
      Recommended schedule…
    </Button>
  );
}
