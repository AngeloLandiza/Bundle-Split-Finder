// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTICE_DISCONNECTED, type AgentLink } from '../../lib/agentLink';
import { AgentSection } from './AgentSection';

afterEach(cleanup);

const NOW = Date.parse('2026-11-22T12:00:00Z');
const draw = (link: AgentLink, connect = vi.fn(async () => null as string | null), disconnect = vi.fn(async () => null as string | null)) => {
  render(createElement(AgentSection, { linkStore: { readLink: async () => link }, actions: { connect, disconnect }, now: () => NOW }));
  return { connect, disconnect };
};

describe('settings: Split Finder app', () => {
  it('unpaired: Connect starts pairing, and a refusal is shown in words', async () => {
    const user = userEvent.setup();
    const { connect } = draw({ status: 'unpaired', notice: null }, vi.fn(async () => 'Could not reach the Split Finder app. Open the app, then connect again.'));
    expect(await screen.findByRole('heading', { name: 'Split Finder app' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect to the Split Finder app' }));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the Split Finder app.');
  });

  it('waiting: the code to approve in the app, and Cancel', async () => {
    draw({ status: 'pairing', code: '017045', expiresAt: NOW + 90_000 });
    expect(await screen.findByText(/approve code/)).toHaveTextContent('Enter nothing — approve code 017 045 in the app.');
    expect(screen.getByText(/about 2 more minutes/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('paired: says so with the last job, and Disconnect', async () => {
    const user = userEvent.setup();
    const { disconnect } = draw({ status: 'paired', since: NOW - 1000, lastJobAt: null });
    expect(await screen.findByText('Connected to the app')).toBeInTheDocument();
    expect(screen.getByText('no jobs yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('after a disconnect or a refusal by the app, the sentence stays above the button', async () => {
    draw({ status: 'unpaired', notice: NOTICE_DISCONNECTED });
    expect(await screen.findByText(NOTICE_DISCONNECTED)).toBeInTheDocument();
  });
});
