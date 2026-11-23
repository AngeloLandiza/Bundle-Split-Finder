import { Button } from './Button';
import { useUi } from './ui';
import { wantRunStep } from '../screens/WelcomeRun';

/**
 * "Recommended schedule…": opens the welcome sheet at its last step, "Let it run by itself", from Settings. A shared
 * component so a Settings pane adds it as one element.
 */
export function RecommendedScheduleLink() {
  const ui = useUi();
  return (
    <Button
      size="sm"
      onClick={() => {
        wantRunStep();
        ui.openSetup();
      }}
    >
      Recommended schedule…
    </Button>
  );
}
