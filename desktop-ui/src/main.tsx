import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PopoverApp } from './screens/PopoverApp';
import { applyBackdrop, applyLook, readLook, shellChrome } from './lib/appearance';
import { routeLinkClicks } from './lib/actions';
import { applyPlatform } from './lib/platform';
import { isPreferencesHash } from './lib/prefs';
import { PreferencesApp } from './screens/preferences/Preferences';
import './base.css';
import './windows.css';

// The look and the shell's chrome go on <html> before the first paint, so the window never flashes light
// in dark mode or paints over the sidebar material.
applyPlatform();
applyLook(readLook());
document.documentElement.dataset.chrome = shellChrome();
applyBackdrop();
// Web links open in the default browser, from every window of the app.
routeLinkClicks();

// The menu bar popover is its own window on this same page (src-tauri/src/popover.rs): `#/popover` draws it alone.
const popover = window.location.hash.startsWith('#/popover');
if (popover) document.documentElement.dataset.surface = 'popover';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {popover ? <PopoverApp /> : isPreferencesHash(window.location.hash) ? <PreferencesApp /> : <App />}
  </StrictMode>,
);
