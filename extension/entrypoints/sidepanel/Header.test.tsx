import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Header } from './Header';

describe('Header app-primary mode', () => {
  it('shows Open app instead of Scan now when the app is primary', () => {
    render(
      createElement(Header, {
        scanRunning: false,
        noKey: false,
        appPrimary: true,
        onScan: () => {},
        onStop: () => {},
        onSettings: () => {},
        onOpenApp: () => {},
      }),
    );
    expect(screen.getByRole('button', { name: 'Open app' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Scan now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  });
});