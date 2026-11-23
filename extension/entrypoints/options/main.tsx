import '../../styles/tokens.css';
import './options.css';
import { browser } from 'wxt/browser';
import { createRoot } from 'react-dom/client';
import { appHomeUrl } from '../../lib/appPrimaryUi';
import { SettingsPage } from './SettingsPage';

declare const __SPLIT_FINDER_HELPER__: boolean;

async function bootOptions(): Promise<void> {
  const redirect = () => {
    window.location.replace(appHomeUrl());
  };
  if (typeof __SPLIT_FINDER_HELPER__ !== 'undefined' && __SPLIT_FINDER_HELPER__) {
    redirect();
    return;
  }
  try {
    const stored = await browser.storage.local.get('appPrimaryUi');
    if (stored.appPrimaryUi === true) {
      redirect();
      return;
    }
  } catch {
    // Dev builds without storage still show options until app sync sets primary UI.
  }
  createRoot(document.getElementById('root')!).render(<SettingsPage />);
}

void bootOptions();
