import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyLook, readLook, shellChrome } from './lib/appearance';
import './base.css';

// The look and the shell's chrome go on <html> before the first paint, so the window never flashes light
// in dark mode or paints over the sidebar material.
applyLook(readLook());
document.documentElement.dataset.chrome = shellChrome();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
