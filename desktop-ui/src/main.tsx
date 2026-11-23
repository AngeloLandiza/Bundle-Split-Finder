import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PopoverApp } from './screens/PopoverApp';
import { applyLook, readLook, shellChrome } from './lib/appearance';
import { isPreferencesHash } from './lib/prefs';
import { PreferencesApp } from './screens/preferences/Preferences';
import './base.css';

// The look and the shell's chrome go on <html> before the first paint, so the window never flashes light
// in dark mode or paints over the sidebar material.
applyLook(readLook());
document.documentElement.dataset.chrome = shellChrome();

// The menu bar popover is its own window on this same page (src-tauri/src/popover.rs): `#/popover` draws it alone.
const popover = window.location.hash.startsWith('#/popover');
if (popover) document.documentElement.dataset.surface = 'popover';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {popover ? <PopoverApp /> : isPreferencesHash(window.location.hash) ? <PreferencesApp /> : <App />}
  </StrictMode>,
);
