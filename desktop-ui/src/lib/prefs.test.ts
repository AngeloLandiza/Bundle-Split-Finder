import { describe, expect, it } from 'vitest';
import {
  RULES,
  checkBaseUrl,
  checkNumber,
  fromAppearanceSetting,
  guardIcons,
  isClock,
  isLastIcon,
  isPreferencesHash,
  nextTab,
  parsePrefsTab,
  prefsHash,
  tabForSettingsId,
  toAppearanceSetting,
  windowHeight,
} from './prefs';

describe('preferences addresses', () => {
  it('reads the tab from the address and falls back to General', () => {
    expect(parsePrefsTab('#/preferences/keys')).toBe('keys');
    expect(parsePrefsTab('#/preferences')).toBe('general');
    expect(parsePrefsTab('#/preferences/nothing')).toBe('general');
    expect(prefsHash('notifications')).toBe('#/preferences/notifications');
  });
  it('tells the Preferences window from the dashboard', () => {
    expect(isPreferencesHash('#/preferences/ai')).toBe(true);
    expect(isPreferencesHash('#/preferences')).toBe(true);
    expect(isPreferencesHash('#/deals/preferences')).toBe(false);
    expect(isPreferencesHash('')).toBe(false);
  });
  it('sends an old settings link to the tab that holds it', () => {
    expect(tabForSettingsId('fees')).toBe('scanning');
    expect(tabForSettingsId('alerts')).toBe('notifications');
    expect(tabForSettingsId(null)).toBe('general');
  });
  it('moves between tabs with the arrows and wraps', () => {
    expect(nextTab('general', 'ArrowRight')).toBe('scanning');
    expect(nextTab('general', 'ArrowLeft')).toBe('advanced');
    expect(nextTab('advanced', 'ArrowRight')).toBe('general');
    expect(nextTab('keys', 'Enter')).toBeNull();
  });
});

describe('number fields', () => {
  it('accepts a value inside the limits', () => {
    expect(checkNumber('5', RULES.searchesPerScan)).toEqual({ ok: true, value: 5 });
    expect(checkNumber(' 15.5 ', RULES.referralPercent)).toEqual({ ok: true, value: 15.5 });
  });
  it('says what to use when a value is empty, text, fractional where whole is needed, or out of range', () => {
    expect(checkNumber('', RULES.reserve)).toEqual({ ok: false, message: 'Reserve: use a whole number from 0 to 250.' });
    expect(checkNumber('abc', RULES.reserve).ok).toBe(false);
    expect(checkNumber('2.5', RULES.searchesPerScan).ok).toBe(false);
    expect(checkNumber('0', RULES.searchesPerScan)).toEqual({ ok: false, message: 'Searches per scan: use a whole number from 1 to 250.' });
    expect(checkNumber('251', RULES.searchesPerScan).ok).toBe(false);
    expect(checkNumber('101', RULES.referralPercent)).toEqual({ ok: false, message: 'Referral fee: use a number from 0% to 100%.' });
    expect(checkNumber('-1', RULES.minProfit)).toEqual({ ok: false, message: 'Estimated profit: use a number of $0 or more.' });
  });
});

describe('times and addresses', () => {
  it('takes a 24-hour clock time', () => {
    expect(isClock('07:30')).toBe(true);
    expect(isClock('23:59')).toBe(true);
    expect(isClock('24:00')).toBe(false);
    expect(isClock('7:30')).toBe(false);
    expect(isClock('')).toBe(false);
  });
  it('takes https, or http on this Mac, and nothing else', () => {
    expect(checkBaseUrl('https://api.deepseek.com/')).toEqual({ ok: true, value: 'https://api.deepseek.com' });
    expect(checkBaseUrl('http://localhost:11434/v1')).toEqual({ ok: true, value: 'http://localhost:11434/v1' });
    expect(checkBaseUrl('http://example.com').ok).toBe(false);
    expect(checkBaseUrl('api.deepseek.com').ok).toBe(false);
    expect(checkBaseUrl('').ok).toBe(false);
  });
});

describe('the way back into the app', () => {
  it('lets one icon go while the other stays', () => {
    expect(guardIcons({ menuBarIcon: true, dockIcon: true }, { dockIcon: false })).toEqual({ next: { menuBarIcon: true, dockIcon: false }, blocked: null });
  });
  it('refuses to turn the last one off, whichever it is', () => {
    const noDock = { menuBarIcon: true, dockIcon: false };
    expect(guardIcons(noDock, { menuBarIcon: false })).toEqual({ next: noDock, blocked: 'menuBarIcon' });
    const noBar = { menuBarIcon: false, dockIcon: true };
    expect(guardIcons(noBar, { dockIcon: false })).toEqual({ next: noBar, blocked: 'dockIcon' });
  });
  it('names the switch that cannot be turned off', () => {
    expect(isLastIcon({ menuBarIcon: true, dockIcon: false }, 'menuBarIcon')).toBe(true);
    expect(isLastIcon({ menuBarIcon: true, dockIcon: false }, 'dockIcon')).toBe(false);
    expect(isLastIcon({ menuBarIcon: true, dockIcon: true }, 'dockIcon')).toBe(false);
  });
});

describe('the look and the agent', () => {
  it('maps theme to appearance and back', () => {
    const look = { appearance: 'dark', accent: 'green', density: 'compact' } as const;
    expect(toAppearanceSetting(look)).toEqual({ theme: 'dark', accent: 'green', density: 'compact' });
    expect(fromAppearanceSetting(toAppearanceSetting(look))).toEqual(look);
  });
});

describe('the window height', () => {
  it('fits the pane inside the window limits', () => {
    expect(windowHeight(86, 400)).toBe(486);
    expect(windowHeight(86, 100)).toBe(320);
    expect(windowHeight(86, 2000)).toBe(820);
  });
});
