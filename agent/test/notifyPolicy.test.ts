import { describe, expect, it } from 'vitest';

import type { NotificationSettings, NotifyEvent } from '../../core/src/api/contract';
import { NotifyPolicy } from '../notifyPolicy';

const base = (): NotificationSettings => ({
  kinds: { review: true, deal: true, autopilot: true, scan: true, error: true, version: true, costs: true },
  sound: false,
  quietHours: { enabled: false, from: '22:00', to: '07:00' },
  digest: 'each-run',
  morningAt: '08:00',
});

function setup(over: Partial<NotificationSettings> = {}) {
  const settings = { ...base(), ...over };
  const clock = { at: new Date(2026, 10, 23, 12, 0).getTime() };
  const sent: Omit<NotifyEvent, 'id'>[] = [];
  const policy = new NotifyPolicy({ settings: () => settings, now: () => clock.at, emit: (e) => void sent.push(e) });
  const at = (h: number, m = 0, day = 23) => void (clock.at = new Date(2026, 10, day, h, m).getTime());
  return { settings, policy, sent, at };
}

const deal = { kind: 'deal', title: 'Split Finder', body: '1 new deal', count: 1, route: '/deals' } as const;
const review = { kind: 'review', title: 'Split Finder', body: '2 questions need you.', count: 2, route: '/review' } as const;

describe('notification kinds', () => {
  it('a kind turned off emits nothing, the others do', () => {
    const { policy, sent, settings } = setup();
    settings.kinds.deal = false;
    expect(policy.digest(deal, deal.body)).toBe(deal.body); // Telegram follows the digest setting, not the kinds
    policy.send(review);
    expect(sent).toEqual([review]);
  });
});

describe('quiet hours (22:00 to 07:00)', () => {
  const quiet = { quietHours: { enabled: true, from: '22:00', to: '07:00' } };

  it('holds events across midnight and sends one when they end; scan events are dropped', () => {
    const { policy, sent, at } = setup(quiet);
    at(23, 30);
    policy.send(deal);
    policy.send(review);
    policy.send({ kind: 'scan', title: 'Split Finder', body: 'Scan finished.' });
    policy.flush();
    expect(sent).toEqual([]);
    at(6, 59, 24);
    policy.flush();
    expect(sent).toEqual([]);
    at(7, 0, 24);
    policy.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'review', count: 3, route: '/', body: '1 new deal\n2 questions need you.' });
    policy.flush();
    expect(sent).toHaveLength(1);
  });

  it('does not hold anything outside the window or with quiet hours off', () => {
    const a = setup(quiet);
    a.policy.send(deal);
    expect(a.sent).toEqual([deal]);
    const b = setup();
    b.at(23, 0);
    b.policy.send(deal);
    expect(b.sent).toEqual([deal]);
  });
});

describe('digest timing', () => {
  it("'off' sends nothing, to the app or Telegram", () => {
    const { policy, sent } = setup({ digest: 'off' });
    expect(policy.digest(deal, 'text')).toBeNull();
    expect(sent).toEqual([]);
    expect(policy.flush()).toBeNull();
  });

  it("'morning' collects the run digests and sends one message, and the Telegram text, at morningAt", () => {
    const { policy, sent, at } = setup({ digest: 'morning' });
    at(23, 0, 22);
    expect(policy.digest(deal, 'deal text')).toBeNull();
    expect(policy.digest(review, 'review text')).toBeNull();
    at(7, 59);
    expect(policy.flush()).toBeNull();
    expect(sent).toEqual([]);
    at(8, 0);
    expect(policy.flush()).toBe('deal text\nreview text');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ body: '1 new deal\n2 questions need you.', count: 3 });
    // Once a day: later lines wait for tomorrow.
    at(14, 0);
    policy.digest(deal, 'later');
    expect(policy.flush()).toBeNull();
    at(8, 5, 24);
    expect(policy.flush()).toBe('later');
  });

  it('the morning message waits for the end of quiet hours when they cover morningAt', () => {
    const { policy, sent, at } = setup({ digest: 'morning', morningAt: '06:30', quietHours: { enabled: true, from: '22:00', to: '07:00' } });
    at(23, 0, 22);
    policy.digest(deal, 'deal text');
    at(6, 30);
    expect(policy.flush()).toBe('deal text');
    expect(sent).toEqual([]);
    at(7, 0);
    policy.flush();
    expect(sent).toEqual([deal]);
  });
});
