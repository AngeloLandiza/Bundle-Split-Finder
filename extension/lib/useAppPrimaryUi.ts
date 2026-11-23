import { useEffect, useState } from 'react';

import { appHomeUrl } from './appPrimaryUi';
import { getAppPrimaryUi } from './prefs';

/** Lane D: native app owns scan and settings; helper stays thin. */
export function useAppPrimaryUi(): { primary: boolean; openApp: () => void } {
  const [primary, setPrimary] = useState(false);
  useEffect(() => {
    void getAppPrimaryUi().then(setPrimary);
  }, []);
  return { primary, openApp: () => void window.open(appHomeUrl(), '_blank') };
}