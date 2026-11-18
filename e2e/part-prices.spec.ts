import type { Worker } from '@playwright/test';
import { expect, test } from './fixtures';

// The part price reader runs in the built extension: one background tab on the replay server's /s/<model>, the
// search and product fetches made from inside it. The replay server's search pages and product pages are
// synthetic (fixtures/homedepot-pages/part-search-2026-11-18.json says so); the shapes are Home Depot's.
interface Read {
  brand: string;
  model: string;
  itemId: string | null;
  price: number | null;
  title: string | null;
  link: string | null;
}

const read = (worker: Worker, parts: { brand: string; model: string }[]): Promise<Read[]> =>
  worker.evaluate(
    (asked) => (globalThis as unknown as { splitFinderReadPartPrices: (p: typeof asked) => Promise<Read[]> }).splitFinderReadPartPrices(asked),
    parts,
  );

test('reads each part\'s Home Depot price through its own search, and gives nothing where the model is not confirmed', async ({ worker, server, context, seen }) => {
  server.reset();
  const out = await read(worker, [
    { brand: 'RYOBI', model: 'PCL265B' },
    { brand: 'RYOBI', model: 'PCG002' },
    // Written without RYOBI's tool-only B: Home Depot's product is PCL206B.
    { brand: 'RYOBI', model: 'PCL206' },
    { brand: 'DEWALT', model: 'DCD791B' },
    // The first link ends with PBP004 but is the PCL1600K2-PBP004 kit: its page does not confirm the model.
    { brand: 'RYOBI', model: 'PBP004' },
    // No link ends with this model.
    { brand: 'RYOBI', model: 'PCL999' },
  ]);
  const origin = `http://localhost:${new URL(server.url).port}`;
  expect(out).toEqual([
    { brand: 'RYOBI', model: 'PCL265B', itemId: '399000001', price: 99, title: 'ONE+ 18V Cordless Brushless 1/2 in. Impact Wrench (Tool Only)', link: `${origin}/p/RYOBI-ONE-18V-Cordless-Brushless-1-2-in-Impact-Wrench-Tool-Only-PCL265B/399000001` },
    { brand: 'RYOBI', model: 'PCG002', itemId: '399000002', price: 34.97, title: 'ONE+ 18V Lithium-Ion Charger', link: `${origin}/p/RYOBI-ONE-18V-Lithium-Ion-Charger-PCG002/399000002` },
    { brand: 'RYOBI', model: 'PCL206', itemId: '399000003', price: 59, title: 'ONE+ 18V Cordless 1/2 in. Drill/Driver (Tool Only)', link: `${origin}/p/RYOBI-ONE-18V-Cordless-1-2-in-Drill-Driver-Tool-Only-PCL206B/399000003` },
    { brand: 'DEWALT', model: 'DCD791B', itemId: '399000005', price: 159, title: '20V MAX XR Brushless Cordless 1/2 in. Drill/Driver (Tool Only)', link: `${origin}/p/DEWALT-20V-MAX-XR-Brushless-Cordless-1-2-in-Drill-Driver-Tool-Only-DCD791B/399000005` },
    { brand: 'RYOBI', model: 'PBP004', itemId: null, price: null, title: null, link: null },
    { brand: 'RYOBI', model: 'PCL999', itemId: null, price: null, title: null, link: null },
  ]);
  // Six searches (one per model, in batches of four) and a product page only for each part that had a matching link.
  // (The doorway tab itself opens on the first model's search, so that one is requested twice.)
  expect([...new Set(server.searchPageRequests.map((m) => m.toUpperCase()))].sort()).toEqual(['DCD791B', 'PBP004', 'PCG002', 'PCL206', 'PCL265B', 'PCL999']);
  expect(server.pageRequests.sort()).toEqual(['341645081', '399000001', '399000002', '399000003', '399000005']);
  // The doorway tab is closed at the end.
  expect(context.pages().filter((p) => p.url().startsWith(origin))).toEqual([]);
  expect(seen.console).toEqual([]);
});

test('a refused search stops the call: every part is empty, and no product page is read', async ({ worker, server }) => {
  server.reset();
  server.refuse('*');
  const out = await read(worker, [
    { brand: 'RYOBI', model: 'PCL265B' },
    { brand: 'RYOBI', model: 'PCG002' },
  ]);
  expect(out.map((o) => [o.itemId, o.price])).toEqual([[null, null], [null, null]]);
  expect(server.pageRequests).toEqual([]);
  expect(server.searchPageRequests.length).toBeGreaterThan(0);
});
