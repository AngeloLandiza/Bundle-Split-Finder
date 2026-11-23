import { describe, expect, it } from 'vitest';

import { recommendSchedule } from '@core/schedule/recommend';
import { takeWantedStep, turnedOnSentence, wantRunStep, type RunPlan } from './WelcomeRun';

const plan = (schedule: RunPlan['schedule']): RunPlan => ({
  rec: recommendSchedule({ monthly: 250, reserve: 100, perScanCap: 18, hasKeepa: true, now: new Date(2026, 10, 23) }),
  settings: {} as RunPlan['settings'],
  schedule,
  login: true,
  awake: true,
});

describe('the welcome sheet’s schedule step', () => {
  it('Settings asks for it once: the sheet takes the request and it is gone', () => {
    expect(takeWantedStep()).toBeNull();
    wantRunStep();
    expect(takeWantedStep()).toBe('run');
    expect(takeWantedStep()).toBeNull();
  });

  it('says what was turned on in the schedule’s own words, and that nothing starts now', () => {
    expect(turnedOnSentence(plan('daily'))).toBe('Turned on: Daily at 7:00. The first scan runs at the next slot, not now. You can change this in Settings.');
    expect(turnedOnSentence(plan('manual'))).toBe('Scans run only when you press Scan now. You can choose a schedule later in Settings.');
  });
});
