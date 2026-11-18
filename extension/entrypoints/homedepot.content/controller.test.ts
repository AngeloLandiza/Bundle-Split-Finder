import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChipModel } from './chipModel';
import { type ChipEnv, createChipController, type PreparedChip } from './controller';
import type { ChipRequest, PageSeenRequest } from './protocol';
import { estimateView, lookupView, pricedText, recordedText } from './realViews';
import type { BundleView } from './protocol';

// The content script's behaviour with fakes for the document, storage and the worker. The page texts are the
// recorded 328814689 and 320243741 pages (priced as captured on Nov 17); the replies are real PageViews.

let estimate: BundleView;
let lookup: BundleView;
beforeAll(async () => {
  estimate = await estimateView();
  lookup = await lookupView();
}, 60_000);

interface Fake {
  env: ChipEnv;
  sent: ChipRequest[];
  chips: { model: ChipModel; open: () => Promise<boolean>; started: boolean; removed: boolean }[];
  go(itemId: string | null, text?: string | null): void;
}

function fake(opts: { show?: boolean; reply?: (m: ChipRequest) => unknown | Promise<unknown> } = {}): Fake {
  let itemId: string | null = '328814689';
  let text: string | null = pricedText('328814689');
  const sent: ChipRequest[] = [];
  const chips: Fake['chips'] = [];
  const env: ChipEnv = {
    itemId: () => itemId,
    stateText: () => text,
    showChip: async () => opts.show ?? true,
    async send(m) {
      sent.push(m);
      return opts.reply ? opts.reply(m) : m.type === 'pageSeen' ? estimate : { opened: true };
    },
    async prepare(model, open) {
      const chip = { model, open, started: false, removed: false };
      chips.push(chip);
      const prepared: PreparedChip = { start: () => void (chip.started = true), remove: () => void (chip.removed = true) };
      return prepared;
    },
  };
  return {
    env, sent, chips,
    go(id, t) {
      itemId = id;
      if (t !== undefined) text = t;
    },
  };
}

const live = (f: Fake) => f.chips.filter((c) => c.started && !c.removed);

describe('the page is read from the document and sent once', () => {
  it('sends the parsed page of 328814689 (priced as captured) and shows what the worker says', async () => {
    const f = fake();
    await createChipController(f.env).refresh();
    expect(f.sent).toHaveLength(1);
    const msg = f.sent[0] as PageSeenRequest;
    expect(msg.type).toBe('pageSeen');
    expect(msg.page).toMatchObject({ itemId: '328814689', brand: 'RYOBI', model: 'PBLRC2501SB', price: 189, wasPrice: 338 });
    expect(msg.page.bullets.length).toBeGreaterThan(0);
    expect(live(f)).toHaveLength(1);
    expect(live(f)[0]!.model).toMatchObject({ kind: 'estimate', parts: 2 });
  });

  it('a click sends openThisPage and reports whether the panel opened', async () => {
    const f = fake({ reply: (m) => (m.type === 'pageSeen' ? lookup : { opened: false }) });
    await createChipController(f.env).refresh();
    expect(await live(f)[0]!.open()).toBe(false);
    expect(f.sent.at(-1)).toEqual({ type: 'openThisPage' });
    const g = fake();
    await createChipController(g.env).refresh();
    expect(await live(g)[0]!.open()).toBe(true);
  });

  it('a reply that is not a bundle gives no chip: none, an error, or nothing at all', async () => {
    for (const reply of [{ kind: 'none' }, { ok: false, error: 'This request is not allowed from here.' }, undefined, null, 'x']) {
      const f = fake({ reply: () => reply });
      await createChipController(f.env).refresh();
      expect(f.chips).toEqual([]);
    }
  });

  it('a worker that cannot be reached gives no chip and no error', async () => {
    const f = fake({ reply: () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')) });
    await expect(createChipController(f.env).refresh()).resolves.toBeUndefined();
    expect(f.chips).toEqual([]);
  });
});

describe('Show the chip turned off (the setting)', () => {
  it('sends no message and builds no chip', async () => {
    const f = fake({ show: false });
    await createChipController(f.env).refresh();
    expect(f.sent).toEqual([]);
    expect(f.chips).toEqual([]);
  });
});

describe('no page to read', () => {
  it('a page with no embedded state sends nothing', async () => {
    const f = fake();
    f.go('328814689', null);
    await createChipController(f.env).refresh();
    expect(f.sent).toEqual([]);
  });

  it('a path with no item id sends nothing', async () => {
    const f = fake();
    f.go(null);
    await createChipController(f.env).refresh();
    expect(f.sent).toEqual([]);
  });

  it('state that holds another product only (left over from the page before) sends nothing', async () => {
    const f = fake();
    f.go('320243741', pricedText('328814689'));
    await createChipController(f.env).refresh();
    expect(f.sent).toEqual([]);
    expect(f.chips).toEqual([]);
  });
});

describe('in-page navigation to another product (Review Focus 4)', () => {
  it('takes the old chip off at once and shows the new product\'s, never the old one', async () => {
    const f = fake({ reply: (m) => (m.type === 'pageSeen' ? ((m as PageSeenRequest).page.itemId === '328814689' ? estimate : lookup) : { opened: true }) });
    const chip = createChipController(f.env);
    await chip.refresh();
    expect(live(f)[0]!.model.kind).toBe('estimate');

    f.go('320243741', pricedText('320243741'));
    await chip.navigated();
    expect(f.chips[0]!.removed).toBe(true);
    expect(f.sent.map((m) => m.type === 'pageSeen' && m.page.itemId)).toEqual(['328814689', '320243741']);
    expect(live(f).map((c) => c.model.kind)).toEqual(['lookup']);
  });

  it('a slow answer for the old product is dropped when the owner has moved on', async () => {
    let releaseOld: (v: unknown) => void = () => {};
    const f = fake({
      reply: (m) => {
        if (m.type !== 'pageSeen') return { opened: true };
        return m.page.itemId === '328814689' ? new Promise((ok) => (releaseOld = ok)) : lookup;
      },
    });
    const chip = createChipController(f.env);
    const first = chip.refresh();
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    f.go('320243741', pricedText('320243741'));
    await chip.navigated();
    releaseOld(estimate);
    await first;
    expect(f.chips.map((c) => c.model.kind)).toEqual(['lookup']);
    expect(live(f)).toHaveLength(1);
  });

  it('moving to a page with no state yet removes the chip and shows none', async () => {
    const f = fake();
    const chip = createChipController(f.env);
    await chip.refresh();
    f.go('320243741', recordedText('328814689'));
    await chip.navigated();
    expect(live(f)).toEqual([]);
  });

  it('the same product again (a hash or query change) does not send again', async () => {
    const f = fake();
    const chip = createChipController(f.env);
    await chip.refresh();
    await chip.navigated();
    expect(f.sent).toHaveLength(1);
    expect(live(f)).toHaveLength(1);
  });

  it('stop takes the chip off, and an answer that arrives after it builds nothing', async () => {
    let release: (v: unknown) => void = () => {};
    const f = fake({ reply: () => new Promise((ok) => (release = ok)) });
    const chip = createChipController(f.env);
    const pending = chip.refresh();
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    chip.stop();
    release(estimate);
    await pending;
    expect(f.chips).toEqual([]);
  });
});

describe('Show the chip changed while the page is open', () => {
  it('refresh follows the setting: off removes the chip and sends nothing, on shows it again', async () => {
    let show = true;
    const f = fake();
    f.env.showChip = async () => show;
    const chip = createChipController(f.env);
    await chip.refresh();
    expect(live(f)).toHaveLength(1);
    show = false;
    await chip.refresh();
    expect(live(f)).toEqual([]);
    expect(f.sent).toHaveLength(1);
    show = true;
    await chip.refresh();
    expect(live(f)).toHaveLength(1);
  });
});
