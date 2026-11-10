// Find the best way to sell a bundle's parts.
//
// A bundle is a bag of components. A listing sells one or more of them (a
// single tool, a 2-pack of batteries, a battery + charger starter kit). The
// founder's question, "all the possible combinations of listings", is: every
// way to cover the bag with listings, and which way pays the most.
//
// Parts no listing covers are valued at a liquidation price, not dropped.

export interface Listing {
  /** ASIN, or another marketplace's listing id. */
  id: string;
  /** Component model -> quantity this listing sells. */
  covers: Record<string, number>;
  /** What is left after marketplace fees. */
  net: number;
  channel?: string;
}

export interface Plan {
  totalNet: number;
  listings: string[];
  liquidated: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function prepare(components: Record<string, number>, listings: Listing[]) {
  const names = Object.keys(components).sort();
  const index = new Map(names.map((n, i) => [n, i]));
  const usable = listings
    .filter((l) => Object.keys(l.covers).every((m) => index.has(m)))
    .map((l) => {
      const need = names.map(() => 0);
      for (const [model, qty] of Object.entries(l.covers)) need[index.get(model)!]! += qty;
      return { listing: l, need };
    });
  const start = names.map((n) => components[n] ?? 0);
  return { names, usable, start };
}

export function bestPlan(
  components: Record<string, number>,
  listings: Listing[],
  liquidation: Record<string, number> = {},
): Plan {
  const { names, usable, start } = prepare(components, listings);
  const memo = new Map<string, { value: number; path: string[] }>();

  const solve = (state: number[]): { value: number; path: string[] } => {
    const key = state.join(',');
    const hit = memo.get(key);
    if (hit) return hit;
    const i = state.findIndex((v) => v > 0);
    if (i === -1) return { value: 0, path: [] };

    // Option A: sell one unit of component i on its own, outside a listing.
    const rest = state.slice();
    rest[i]! -= 1;
    const a = solve(rest);
    let best = { value: a.value + (liquidation[names[i]!] ?? 0), path: [...a.path, `liquidate:${names[i]}`] };

    // Option B: any listing that uses component i and fits what is left.
    for (const { listing, need } of usable) {
      if (need[i]! > 0 && state.every((s, k) => s >= need[k]!)) {
        const next = solve(state.map((s, k) => s - need[k]!));
        if (next.value + listing.net > best.value + 1e-9) {
          best = { value: next.value + listing.net, path: [...next.path, listing.id] };
        }
      }
    }
    memo.set(key, best);
    return best;
  };

  const { value, path } = solve(start);
  return {
    totalNet: round2(value),
    listings: path.filter((p) => !p.startsWith('liquidate:')).sort(),
    liquidated: path.filter((p) => p.startsWith('liquidate:')).map((p) => p.slice('liquidate:'.length)).sort(),
  };
}

/** Every distinct way to cover the bundle, best first (capped at `limit`). */
export function allPlans(
  components: Record<string, number>,
  listings: Listing[],
  liquidation: Record<string, number> = {},
  limit = 500,
): Plan[] {
  const { names, usable, start } = prepare(components, listings);
  const found = new Map<string, Plan>();

  const walk = (state: number[], minPos: number, used: Listing[]): void => {
    if (found.size >= limit) return;
    // Close this plan: whatever is left is liquidated.
    const left: string[] = [];
    state.forEach((count, k) => {
      for (let n = 0; n < count; n++) left.push(names[k]!);
    });
    const ids = used.map((u) => u.id).sort();
    const key = `${ids.join('|')}#${left.join('|')}`;
    if (!found.has(key)) {
      const net = used.reduce((s, u) => s + u.net, 0) + left.reduce((s, n) => s + (liquidation[n] ?? 0), 0);
      found.set(key, { totalNet: round2(net), listings: ids, liquidated: left });
    }
    // Or add one more listing (non-decreasing order avoids duplicates).
    usable.forEach(({ listing, need }, pos) => {
      if (pos >= minPos && state.every((s, k) => s >= need[k]!)) {
        walk(state.map((s, k) => s - need[k]!), pos, [...used, listing]);
      }
    });
  };

  walk(start, 0, []);
  return [...found.values()].sort((a, b) => b.totalNet - a.totalNet);
}
