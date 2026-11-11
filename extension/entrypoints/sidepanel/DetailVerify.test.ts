// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Reply, Request } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { Verify } from './DetailVerify';

afterEach(cleanup);

const quoting = (): WorkerApi => ({
  send: (async (r: Request): Promise<Reply> => (r.type === 'quote' ? { ok: true, data: { searches: 1, refusal: null } } : { ok: true, data: null })) as WorkerApi['send'],
  onStateChanged: () => () => {},
  download: vi.fn(),
});

const show = (onRun: () => Promise<string | null>) =>
  render(createElement(Verify, { brand: 'RYOBI', model: 'PBLRC25B', asin: 'B0B3JWF5ZV', report: {}, api: quoting(), scanRunning: false, version: 0, busy: false, onRun }));

describe('Verify (QA m4)', () => {
  it('reads Verifying… while its request runs, then Verify again', async () => {
    const user = userEvent.setup();
    let release: (e: string | null) => void = () => {};
    show(() => new Promise<string | null>((r) => (release = r)));
    await user.click(await screen.findByRole('button', { name: /^Verify/ }));
    expect(screen.getByRole('button', { name: 'Verifying…' })).toBeInTheDocument();
    release(null);
    expect(await screen.findByRole('button', { name: /^Verify/ })).toBeInTheDocument();
  });

  it("says a failed Verify in words, not as the client's raw text", async () => {
    const user = userEvent.setup();
    show(async () => 'SerpApi returned HTTP 404.');
    await user.click(await screen.findByRole('button', { name: /^Verify/ }));
    expect(await screen.findByText('SerpApi answered with an error (HTTP 404). Try again later.')).toBeInTheDocument();
    expect(screen.queryByText('SerpApi returned HTTP 404.')).toBeNull();
  });

  it("passes the worker's own sentences as they are", async () => {
    const user = userEvent.setup();
    show(async () => 'A scan is running.');
    await user.click(await screen.findByRole('button', { name: /^Verify/ }));
    await waitFor(() => expect(screen.getByText('A scan is running.')).toBeInTheDocument());
  });
});
