// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { AppState, EbayState, Reply, Request } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { SettingsPage } from './SettingsPage';
import { researchCostLabel } from '@core/research/eval';

// Step 10: the eBay keys, the Anthropic key, the model and the limit on the settings page.

afterEach(cleanup);

const EBAY: EbayState = { hasEbayKeys: false, hasAnthropicKey: false, judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 60 };
const stateWith = (ebay: Partial<EbayState> = {}): AppState => ({
  hasKey: false, account: null, accountCheckedAt: null, problem: null, settings: DEFAULT_SETTINGS, scanRunning: false, lastJob: null, nextRunAt: null, ebay: { ...EBAY, ...ebay },
});

type Handler = (r: Request) => Reply | Promise<Reply>;

async function open(state: AppState, handlers: Partial<Record<Request['type'], Handler>> = {}) {
  const send = vi.fn(async (r: Request): Promise<Reply> => {
    if (r.type === 'getState') return { ok: true, data: state };
    return (await handlers[r.type]?.(r)) ?? { ok: true, data: null };
  });
  const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
  const user = userEvent.setup();
  render(createElement(SettingsPage, { api }));
  await screen.findByRole('heading', { name: 'Listing check' });
  const sent = (type: Request['type']) => send.mock.calls.map((c) => c[0]).filter((r) => r.type === type);
  return { send, user, sent };
}

const app = () => screen.getByLabelText('eBay App ID') as HTMLInputElement;
const cert = () => screen.getByLabelText('eBay Cert ID') as HTMLInputElement;
const anthropic = () => screen.getByLabelText('Anthropic key') as HTMLInputElement;
const limit = () => screen.getByLabelText('eBay listings judged per scan') as HTMLInputElement;

describe('Settings: eBay reference values', () => {
  it('says eBay values are a reference and not counted, and that the keys stay in this browser', async () => {
    await open(stateWith());
    expect(screen.getByRole('heading', { name: 'eBay reference values' })).toBeInTheDocument();
    expect(screen.getByText(/shown beside a part's other prices as a reference\. It is not counted in any estimate\./)).toBeInTheDocument();
    expect(screen.getByText(/It uses your own eBay developer keys, stored only in this browser\./)).toBeInTheDocument();
  });

  it('the App ID and Cert ID are masked, empty, and Check waits until both are typed', async () => {
    const { user } = await open(stateWith());
    expect(app().type).toBe('password');
    expect(cert().type).toBe('password');
    expect(screen.getByRole('button', { name: 'Check eBay keys' })).toBeDisabled();
    await user.type(app(), 'my-app');
    expect(screen.getByRole('button', { name: 'Check eBay keys' })).toBeDisabled();
    await user.type(cert(), 'my-cert');
    expect(screen.getByRole('button', { name: 'Check eBay keys' })).toBeEnabled();
  });

  it('sends the keys once, says they work, and empties the fields: the keys are not left in the page', async () => {
    const { user, sent } = await open(stateWith());
    await user.type(app(), 'my-app');
    await user.type(cert(), 'my-cert');
    await user.click(screen.getByRole('button', { name: 'Check eBay keys' }));
    await waitFor(() => expect(screen.getByTestId('ebay-key-result')).toHaveTextContent('Keys work.'));
    expect(sent('saveEbayKeys')).toEqual([{ type: 'saveEbayKeys', appId: 'my-app', certId: 'my-cert' }]);
    expect(app().value).toBe('');
    expect(cert().value).toBe('');
    expect(document.body.innerHTML).not.toContain('my-cert');
  });

  it('shows the sentence eBay\'s refusal comes as, and keeps the fields', async () => {
    const { user } = await open(stateWith(), { saveEbayKeys: () => ({ ok: false, error: 'eBay did not accept this App ID and Cert ID.' }) });
    await user.type(app(), 'my-app');
    await user.type(cert(), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Check eBay keys' }));
    await waitFor(() => expect(screen.getByTestId('ebay-key-result')).toHaveTextContent('eBay did not accept this App ID and Cert ID.'));
    expect(cert().value).toBe('wrong');
  });

  it('saved keys are never shown back; Remove asks once', async () => {
    const { user, sent } = await open(stateWith({ hasEbayKeys: true }));
    expect(app().placeholder).toBe('••••••••••••');
    expect(cert().placeholder).toBe('••••••••••••');
    expect(screen.getByRole('button', { name: 'Replace eBay keys' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Check eBay keys' })).toBeNull();
    expect(app().value).toBe('');
    await user.click(screen.getByRole('button', { name: 'Remove eBay keys' }));
    expect(sent('forgetEbayKeys')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, remove keys' }));
    expect(sent('forgetEbayKeys')).toHaveLength(1);
  });
});

describe('Settings: the listing check', () => {
  it('says a model reads each listing, with the owner\'s own Anthropic key and bill, and the key is masked', async () => {
    await open(stateWith());
    expect(screen.getByText(/uses your own Anthropic key, so the calls are billed to your Anthropic account/)).toBeInTheDocument();
    expect(anthropic().type).toBe('password');
    expect(screen.getByRole('button', { name: 'Add key' })).toBeDisabled();
  });

  it('saves the key without checking it, empties the field, and never shows it back', async () => {
    const { user, sent } = await open(stateWith());
    await user.type(anthropic(), 'sk-ant-secret');
    await user.click(screen.getByRole('button', { name: 'Add key' }));
    await waitFor(() => expect(screen.getByTestId('anthropic-key-result')).toHaveTextContent('Key saved in this browser.'));
    expect(sent('saveAnthropicKey')).toEqual([{ type: 'saveAnthropicKey', apiKey: 'sk-ant-secret' }]);
    expect(anthropic().value).toBe('');
    expect(document.body.innerHTML).not.toContain('sk-ant-secret');
  });

  it('a saved key shows only that it is saved; Remove asks once', async () => {
    const { user, sent } = await open(stateWith({ hasAnthropicKey: true }));
    expect(anthropic().placeholder).toBe('••••••••••••');
    expect(screen.getByTestId('anthropic-key-result')).toHaveTextContent('Anthropic key saved.');
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add key' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove Anthropic key' }));
    await user.click(screen.getByRole('button', { name: 'Yes, remove Anthropic key' }));
    expect(sent('forgetAnthropicKey')).toHaveLength(1);
  });

  it('offers the two models, Haiku chosen to start, and saves a change at once', async () => {
    const { user, sent } = await open(stateWith());
    const haiku = screen.getByRole('radio', { name: /Claude Haiku 5\.5/ });
    const opus = screen.getByRole('radio', { name: /Claude Opus 5\.5/ });
    expect(haiku).toBeChecked();
    expect(opus).not.toBeChecked();
    await user.click(opus);
    expect(opus).toBeChecked();
    expect(sent('saveEbaySettings')).toEqual([{ type: 'saveEbaySettings', judgeModel: 'claude-opus-5-5', listingsJudgedPerScan: 60 }]);
    // No floating confirmation: the page's own line already says changes save as they are made.
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('says a refusal of the settings under the control, as an alert', async () => {
    const { user } = await open(stateWith(), { saveEbaySettings: () => ({ ok: false, error: 'Choose one of the models offered.' }) });
    await user.click(screen.getByRole('radio', { name: /Claude Opus 5\.5/ }));
    expect(await screen.findByTestId('ebay-settings-error')).toHaveTextContent('Choose one of the models offered.');
  });

  it('starts at 60 listings, saves a new number when the field is left, and refuses a number that is not whole or in range without sending it', async () => {
    const { user, sent } = await open(stateWith());
    expect(limit()).toHaveValue(60);
    await user.clear(limit());
    await user.type(limit(), '25');
    await user.tab();
    expect(sent('saveEbaySettings')).toEqual([{ type: 'saveEbaySettings', judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 25 }]);
    await user.clear(limit());
    await user.type(limit(), '2.5');
    await user.tab();
    expect(screen.getByText('Use a whole number of listings from 1 to 500.')).toBeInTheDocument();
    await user.clear(limit());
    await user.type(limit(), '0');
    await user.tab();
    expect(sent('saveEbaySettings')).toHaveLength(1);
  });

  it('says what a scan may cost, as an estimate, at the model and number chosen', async () => {
    const { user } = await open(stateWith());
    const cost = () => screen.getByTestId('ebay-cost');
    expect(cost()).toHaveTextContent(/Estimated cost: up to \$0\.025 a scan\./);
    expect(cost()).toHaveTextContent('An estimate');
    await user.click(screen.getByRole('radio', { name: /Claude Opus 5\.5/ }));
    expect(cost()).toHaveTextContent(/up to \$1\.01 a scan/);
    await user.clear(limit());
    await user.type(limit(), '10');
    expect(cost()).toHaveTextContent(/up to \$0\.17 a scan/);
  });

  it('a state with no eBay part (before step 10) shows the defaults with no keys', async () => {
    const state = { ...stateWith(), ebay: undefined } as unknown as AppState;
    await open(state);
    expect(anthropic().placeholder).toBe('');
    expect(limit()).toHaveValue(60);
  });
});

describe('Settings: Ask AI after each scan (step 12)', () => {
  const box = () => screen.getByRole('checkbox', { name: /Ask AI after each scan/ });

  it('is off until the owner turns it on, and says what it does and that nothing is answered for them', async () => {
    await open(stateWith({ hasAnthropicKey: true }));
    expect(box()).not.toBeChecked();
    expect(screen.getByText(/It only drafts: nothing is answered until you approve it in Review\./)).toBeVisible();
    // The checkbox says whether it is on; the label does not say it again.
    expect(screen.queryByText(/off until you turn it on/)).toBeNull();
    expect(box().closest('label')).toHaveTextContent(/^Ask AI after each scan$/);
  });

  it('is on when the worker says so, and a press saves the change at once, in one message', async () => {
    const { user, sent } = await open({ ...stateWith({ hasAnthropicKey: true }), askAfterScan: true });
    expect(box()).toBeChecked();
    await user.click(box());
    expect(box()).not.toBeChecked();
    expect(sent('saveAskAfterScan')).toEqual([{ type: 'saveAskAfterScan', on: false }]);
  });

  it('puts it back and says so when the change could not be saved', async () => {
    const { user } = await open(stateWith({ hasAnthropicKey: true }), { saveAskAfterScan: () => ({ ok: false, error: 'No.' }) });
    await user.click(box());
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved. Try again.');
    expect(box()).not.toBeChecked();
  });

  it('says what asking costs a question, as an estimate, at the model chosen', async () => {
    const { user } = await open(stateWith());
    expect(screen.getByTestId('ask-cost')).toHaveTextContent('Estimated cost of asking, on the model above: ' + researchCostLabel('claude-haiku-5-5') + ' for a bundle\'s parts, about $0.01 for a listing. An estimate');
    await user.click(screen.getByRole('radio', { name: /Claude Opus 5\.5/ }));
    expect(screen.getByTestId('ask-cost')).toHaveTextContent(researchCostLabel('claude-opus-5-5') + ' for a bundle\'s parts, about $0.02 for a listing');
  });
});
