import { describe, expect, it } from 'vitest';
import { detectPlatform, formatShortcut, wordsFor } from './platform';

const EDGE_ON_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
const SAFARI_ON_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

describe('platform detection', () => {
  it('reads Windows from the WebView2 user agent and a Mac from the WKWebView one', () => {
    expect(detectPlatform({ userAgent: EDGE_ON_WINDOWS, platform: 'Win32' })).toBe('windows');
    expect(detectPlatform({ userAgent: SAFARI_ON_MAC, platform: 'MacIntel' })).toBe('mac');
  });
  it('lets the user agent win over a stale platform string, as a test override needs', () => {
    expect(detectPlatform({ userAgent: EDGE_ON_WINDOWS, platform: 'MacIntel' })).toBe('windows');
  });
  it('falls back to client hints, then the platform string', () => {
    expect(detectPlatform({ userAgent: '', userAgentData: { platform: 'Windows' } })).toBe('windows');
    expect(detectPlatform({ userAgentData: { platform: 'macOS' } })).toBe('mac');
    expect(detectPlatform({ platform: 'Win32' })).toBe('windows');
  });
  it('says other for anything unknown, and never guesses Windows', () => {
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64' })).toBe('other');
    expect(detectPlatform({ userAgent: 'Node.js/22' })).toBe('other');
    expect(detectPlatform(undefined)).toBe('other');
  });
});

describe('shortcut labels', () => {
  it('writes glyphs on a Mac in the system order and words on Windows', () => {
    expect(formatShortcut(['mod', '1'], true)).toBe('⌘1');
    expect(formatShortcut(['mod', '1'], false)).toBe('Ctrl+1');
    expect(formatShortcut(['mod', 'alt', 'I'], true)).toBe('⌥⌘I');
    expect(formatShortcut(['mod', 'alt', 'I'], false)).toBe('Ctrl+Alt+I');
    expect(formatShortcut(['mod', 'shift', 'K'], true)).toBe('⇧⌘K');
    expect(formatShortcut(['mod', 'shift', 'K'], false)).toBe('Ctrl+Shift+K');
    expect(formatShortcut(['shift', 'F10'], false)).toBe('Shift+F10');
    expect(formatShortcut(['enter'], true)).toBe('↩');
    expect(formatShortcut(['enter'], false)).toBe('Enter');
  });
});

describe('the words of each system', () => {
  it('calls Preferences Settings, the Dock the taskbar and Finder File Explorer on Windows', () => {
    const w = wordsFor(true);
    expect(w).toMatchObject({ preferences: 'Settings', quit: 'Exit', revealFolder: 'Show in File Explorer', trayPlace: 'notification area', dockSwitch: 'Show in taskbar', computer: 'PC' });
    expect(w.trayIconSwitch).toContain('notification area icon');
    expect(wordsFor(false)).toMatchObject({ preferences: 'Preferences', preferencesRow: 'Preferences…', revealFolder: 'Show in Finder', trayIconSwitch: 'Show menu bar icon', dockSwitch: 'Show Dock icon' });
  });
});
